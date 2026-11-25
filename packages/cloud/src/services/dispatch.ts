import { computeWeaverStyleUnits } from "../../../shared/src/capacity.ts";
import { COLLECTIONS } from "../../../shared/src/collections.ts";
import { DAY_MS, HOUR_MS, addAwakeHoursCst } from "../../../shared/src/cst.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";
import { DISPATCH_OFFER_STATUS_SPEC, ORDER_PACKAGE_STATUS_SPEC } from "../../../shared/src/status.ts";
import type {
  DispatchOfferDoc,
  OrderPackageDoc,
  PatternDoc,
  RegionCode,
  StyleDoc,
  StyleEnrollmentDoc,
  UserDoc,
  WeaverStockDoc,
  YarnCatalogDoc,
} from "../../../shared/src/schemas.ts";
import { assertNotSelfOrder } from "../kit/auth.ts";
import type { DbAdapter } from "../kit/db.ts";
import { dispatchOfferId, weaverStockId } from "../kit/ids.ts";
import { transitionStatus } from "../kit/transition.ts";
import { consumeYarnForPackage } from "../kit/yarnInventory.ts";

const PROVINCE_TO_REGION: Readonly<Record<string, RegionCode>> = {
  上海市: "jzh",
  上海: "jzh",
  江苏省: "jzh",
  江苏: "jzh",
  浙江省: "jzh",
  浙江: "jzh",
  安徽省: "jzh",
  安徽: "jzh",
  北京市: "north",
  河北省: "north",
  山东省: "north",
  河南省: "north",
  云南省: "sw_ygc",
  贵州省: "sw_ygc",
  四川省: "sw_ygc",
  重庆市: "sw_ygc",
  陕西省: "nw",
  甘肃省: "nw",
  新疆维吾尔自治区: "nw",
};

export function inferRegionFromProvince(province: string): RegionCode {
  return PROVINCE_TO_REGION[province.trim()] ?? "south_central";
}

/**
 * Promotes `confirming` Douyin packages whose merge window has elapsed into `waiting_dispatch`,
 * then dispatches `waiting_dispatch` packages by priority tier:
 *   stock (ready stock reuse) -> same_province -> same_region -> national.
 * Enforces channel-specific queue horizon (`mp_wechat: 3` days vs `douyin_online: 5` days),
 * blocks self-orders, and enforces `styleEnrollments` when `requiresEnrollment === true`.
 */
export async function dispatchPoolTick(
  db: DbAdapter,
  params: {
    nowUtcMs?: number;
    mpHorizonDays?: number;
    liveHorizonDays?: number;
    maxSimultaneousOffersPerWeaver?: number;
    maxDispatchAttempts?: number;
  } = {},
): Promise<{ promotedConfirming: number; dispatchedCount: number; movedToManualHold: number }> {
  const now = params.nowUtcMs ?? Date.now();
  const mpHorizon = params.mpHorizonDays ?? 3;
  const liveHorizon = params.liveHorizonDays ?? 5;
  const maxOffersPerWeaver = params.maxSimultaneousOffersPerWeaver ?? 3;
  const maxAttempts = params.maxDispatchAttempts ?? 5;

  let promotedConfirming = 0;
  let dispatchedCount = 0;
  let movedToManualHold = 0;

  // 1. Promote matured confirming packages
  const confirming = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) => p.status === "confirming" && now >= p.dispatchableAt,
  );
  for (const pkg of confirming) {
    const tr = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "confirming",
      "waiting_dispatch",
      pkg.version,
      undefined,
      now,
    );
    if (tr.moved) promotedConfirming++;
  }

  // 2. Load weavers, active packages (for backlog & pending offer counts), styles, yarn catalog, enrollments
  const weavers = await db.find<UserDoc>(
    COLLECTIONS.USERS,
    (u) => u.roles.includes("weaver") && u.funnelStage === "approved" && u.acceptingOrders,
  );
  const activePkgs = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) =>
    ["offered", "making", "photo_review", "awaiting_seal"].includes(p.status),
  );
  const styles = await db.find<StyleDoc>(COLLECTIONS.STYLES, () => true);
  const styleMap = new Map(styles.map((s) => [s._id, s]));
  const yarns = await db.find<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, () => true);
  const yarnWeightMap = new Map(yarns.map((y) => [y._id, y.unitWeightG || 50]));
  const enrollments = await db.find<StyleEnrollmentDoc>(
    COLLECTIONS.STYLE_ENROLLMENTS,
    (e) => e.status === "certified",
  );
  const certifiedByWeaver = new Map<string, string[]>();
  for (const e of enrollments) {
    const arr = certifiedByWeaver.get(e.weaverId) ?? [];
    arr.push(e.skuCode);
    certifiedByWeaver.set(e.weaverId, arr);
  }

  const backlogByWeaver = new Map<string, number>();
  const pendingOfferCountByWeaver = new Map<string, number>();
  const stalledWeavers = new Set<string>();

  for (const ap of activePkgs) {
    if (!ap.assignedWeaverId) continue;
    if (ap.status === "offered") {
      pendingOfferCountByWeaver.set(ap.assignedWeaverId, (pendingOfferCountByWeaver.get(ap.assignedWeaverId) ?? 0) + 1);
    }
    if (["offered", "making", "photo_review"].includes(ap.status)) {
      backlogByWeaver.set(ap.assignedWeaverId, (backlogByWeaver.get(ap.assignedWeaverId) ?? 0) + ap.totalMin);
    }
    if (ap.status === "making" && ap.queueSeq === 1 && ap.stallPromptedAt) {
      stalledWeavers.add(ap.assignedWeaverId);
    }
  }

  const waiting = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) => p.status === "waiting_dispatch" && now >= p.dispatchableAt,
  );
  waiting.sort((a, b) => a.dispatchableAt - b.dispatchableAt);

  for (const pkg of waiting) {
    if (pkg.attemptCount >= maxAttempts) {
      const tr = await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "waiting_dispatch",
        "manual_hold",
        pkg.version,
        undefined,
        now,
      );
      if (tr.moved) movedToManualHold++;
      continue;
    }

    const horizonDays = pkg.channel === "mp_wechat" ? mpHorizon : liveHorizon;
    const buyerRegion = inferRegionFromProvince(pkg.buyerProvince);

    // Candidate pool rule (docs/07 §16): douyin_online ONLY live pool; mp_wechat allows mp (priority) + live (overflow)
    const eligibleWeavers = weavers.filter((w) => {
      if (pkg.channel === "douyin_online" && w.pool !== "live") return false;
      if (pkg.buyerUserId && pkg.buyerUserId === w._id) return false; // Hard anti-self-order
      if (w.pauseUntil && w.pauseUntil > now) return false;
      if (stalledWeavers.has(w._id)) return false;
      if ((pendingOfferCountByWeaver.get(w._id) ?? 0) >= maxOffersPerWeaver) return false;
      return true;
    });

    type ScoredCandidate = {
      weaver: UserDoc;
      tier: DispatchOfferDoc["matchTier"];
      tierRank: number;
      isStockReuse: boolean;
    };
    const scored: ScoredCandidate[] = [];

    for (const w of eligibleWeavers) {
      // Check if weaver holds full ready stock for single-item package
      let holdsReadyStock = false;
      if (pkg.itemsSnapshot.length === 1) {
        const only = pkg.itemsSnapshot[0]!;
        const st = await db.get<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, weaverStockId(w._id, only.skuCode));
        if (st && st.availableQty >= only.qty) {
          holdsReadyStock = true;
        }
      }

      if (!holdsReadyStock) {
        // Check dual-bucket capacity (time + yarn + Craft-KOL enrollment) for all items in package
        const backlog = backlogByWeaver.get(w._id) ?? 0;
        let canMakeAll = true;
        for (const item of pkg.itemsSnapshot) {
          const styleDoc = styleMap.get(item.skuCode);
          const cap = computeWeaverStyleUnits(
            {
              userId: w._id,
              acceptingOrders: w.acceptingOrders,
              pauseUntil: w.pauseUntil,
              restDays: w.restDays,
              dailyCapacityMin: w.dailyCapacityMin,
              speedFactor: w.speedFactor,
              backlogMin: backlog,
              yarnInventory: w.yarnInventory,
              certifiedStyleCodes: certifiedByWeaver.get(w._id) ?? [],
            },
            {
              skuCode: item.skuCode,
              standardMin: item.standardMin,
              requiresEnrollment: styleDoc?.requiresEnrollment,
              yarnBomConsumed: item.yarnBomSnapshot.map((b) => ({
                yarnCode: b.yarnCode,
                consumedG: b.consumedG,
                unitWeightG: yarnWeightMap.get(b.yarnCode) ?? 50,
              })),
            },
            undefined,
            { nowUtcMs: now, horizonDays },
          );
          if (cap.units < item.qty) {
            canMakeAll = false;
            break;
          }
        }
        if (!canMakeAll) continue;
      }

      const wProvince = w.cityQuotaKey?.split("-")[0] ?? "";
      let tier: DispatchOfferDoc["matchTier"] = "national";
      let tierRank = 4;
      if (holdsReadyStock) {
        tier = "stock";
        tierRank = 0;
      } else if (wProvince && pkg.buyerProvince.startsWith(wProvince)) {
        tier = "same_province";
        tierRank = 1;
      } else if (w.regionCode === buyerRegion) {
        tier = "same_region";
        tierRank = 2;
      }
      // Prefer mp pool weavers before overflowing to live pool weavers for mp_wechat orders
      if (pkg.channel === "mp_wechat" && w.pool === "live" && !holdsReadyStock) {
        tierRank += 0.5;
      }

      scored.push({ weaver: w, tier, tierRank, isStockReuse: holdsReadyStock });
    }

    scored.sort((a, b) => a.tierRank - b.tierRank || b.weaver.creditScore - a.weaver.creditScore);
    const chosen = scored[0];
    if (!chosen) continue;

    assertNotSelfOrder(pkg.buyerUserId, chosen.weaver._id);
    const nextAttempt = pkg.attemptCount + 1;
    const offerDoc: DispatchOfferDoc = {
      _id: dispatchOfferId(pkg._id, nextAttempt),
      packageId: pkg._id,
      attemptNo: nextAttempt,
      weaverId: chosen.weaver._id,
      matchTier: chosen.tier,
      status: "pending",
      offeredAt: now,
      expireAt: now + HOUR_MS,
      yarnAvailabilityConfirmed: false,
      version: 1,
    };

    const ins = await db.insert(COLLECTIONS.DISPATCH_OFFERS, offerDoc);
    if (!ins.inserted) continue;

    const reviewMode: OrderPackageDoc["reviewMode"] =
      chosen.weaver.creditScore >= 120 ? "skip" : "required";

    const tr = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "waiting_dispatch",
      "offered",
      pkg.version,
      () => ({
        assignedWeaverId: chosen.weaver._id,
        attemptCount: nextAttempt,
        isReadyStockReuse: chosen.isStockReuse,
        reviewMode,
      }),
      now,
    );

    if (tr.moved) {
      dispatchedCount++;
      pendingOfferCountByWeaver.set(
        chosen.weaver._id,
        (pendingOfferCountByWeaver.get(chosen.weaver._id) ?? 0) + 1,
      );
      if (!chosen.isStockReuse) {
        backlogByWeaver.set(chosen.weaver._id, (backlogByWeaver.get(chosen.weaver._id) ?? 0) + pkg.totalMin);
      }
    }
  }

  return { promotedConfirming, dispatchedCount, movedToManualHold };
}

/**
 * Weaver accepts or rejects an offered order package.
 * - Ready-stock reuse (`isReadyStockReuse === true`) jumps directly `offered -> awaiting_seal`
 *   and deducts `weaverStock.availableQty` WITHOUT touching `yarnInventory`!
 * - Normal order moves `offered -> making`, appends to weaver's linear queue (`queueSeq`),
 *   and accumulates BOM grams in `yarnInventory`.
 */
export async function respondDispatchOffer(
  db: DbAdapter,
  params: {
    packageId: string;
    weaverId: string;
    action: "accept" | "reject";
    nowUtcMs?: number;
  },
): Promise<{ status: OrderPackageDoc["status"]; queueSeq?: number; triggeredYarnChecks: string[] }> {
  const now = params.nowUtcMs ?? Date.now();
  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, params.packageId);
  if (!pkg || pkg.status !== "offered" || pkg.assignedWeaverId !== params.weaverId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Offer is not currently assigned to this weaver");
  }

  const offerKey = dispatchOfferId(pkg._id, pkg.attemptCount);
  const offer = await db.get<DispatchOfferDoc>(COLLECTIONS.DISPATCH_OFFERS, offerKey);
  if (!offer || offer.status !== "pending") {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "Dispatch offer is no longer pending");
  }

  if (params.action === "reject") {
    await transitionStatus(
      db,
      COLLECTIONS.DISPATCH_OFFERS,
      offer._id,
      DISPATCH_OFFER_STATUS_SPEC,
      "pending",
      "rejected",
      offer.version,
      () => ({ respondedAt: now }),
      now,
    );
    const tr = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "offered",
      "waiting_dispatch",
      pkg.version,
      () => ({ assignedWeaverId: undefined, isReadyStockReuse: false }),
      now,
    );
    return { status: tr.doc?.status ?? "waiting_dispatch", triggeredYarnChecks: [] };
  }

  // Accept path
  await transitionStatus(
    db,
    COLLECTIONS.DISPATCH_OFFERS,
    offer._id,
    DISPATCH_OFFER_STATUS_SPEC,
    "pending",
    "accepted",
    offer.version,
    () => ({ respondedAt: now, yarnAvailabilityConfirmed: true }),
    now,
  );

  // Reset consecutive timeouts on successful acceptance
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    params.weaverId,
    () => true,
    (u) => ({ ...u, consecutiveTimeouts: 0, updatedAt: now }),
  );

  if (pkg.isReadyStockReuse) {
    const only = pkg.itemsSnapshot[0]!;
    const stockId = weaverStockId(params.weaverId, only.skuCode);
    await db.atomicUpdate<WeaverStockDoc>(
      COLLECTIONS.WEAVER_STOCK,
      stockId,
      (s) => s.availableQty >= only.qty,
      (s) => ({
        ...s,
        availableQty: s.availableQty - only.qty,
        version: s.version + 1,
        updatedAt: now,
      }),
    );

    const tr = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "offered",
      "awaiting_seal",
      pkg.version,
      () => ({ acceptedAt: now, lastProgressAt: now }),
      now,
    );
    return { status: tr.doc!.status, triggeredYarnChecks: [] };
  }

  // Compute linear queueSeq for this weaver
  const existingQueue = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) =>
      p.assignedWeaverId === params.weaverId &&
      ["making", "photo_review", "awaiting_seal"].includes(p.status),
  );
  const maxSeq = existingQueue.reduce((m, p) => Math.max(m, p.queueSeq ?? 0), 0);
  const nextSeq = maxSeq + 1;

  const tr = await transitionStatus(
    db,
    COLLECTIONS.ORDER_PACKAGES,
    pkg._id,
    ORDER_PACKAGE_STATUS_SPEC,
    "offered",
    "making",
    pkg.version,
    () => ({ queueSeq: nextSeq, acceptedAt: now, lastProgressAt: now }),
    now,
  );

  let triggeredYarnChecks: string[] = [];
  if (tr.moved && tr.doc) {
    const yarnRes = await consumeYarnForPackage(db, params.weaverId, tr.doc, {}, now);
    triggeredYarnChecks = yarnRes.triggeredCheckCodes;
  }

  return { status: tr.doc!.status, queueSeq: nextSeq, triggeredYarnChecks };
}

/**
 * Unlocks structured lyric-style pattern ONLY for the weaver's head-of-queue (`queueSeq === 1`) package.
 */
export async function getHeadPatternForWeaver(
  db: DbAdapter,
  params: { packageId: string; weaverId: string; nowUtcMs?: number },
): Promise<{
  pattern: PatternDoc;
  watermarkText: string;
  urlExpiresAt: number;
}> {
  const now = params.nowUtcMs ?? Date.now();
  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, params.packageId);
  if (!pkg || pkg.assignedWeaverId !== params.weaverId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Package does not belong to this weaver");
  }
  if (pkg.status !== "making" || pkg.queueSeq !== 1) {
    throw new AppError(
      ERROR_CODES.FORBIDDEN,
      "Pattern is locked: only the head-of-queue (queueSeq=1) package in making state can view pattern",
    );
  }

  const sku = pkg.itemsSnapshot[0]?.skuCode;
  const style = sku ? await db.get<StyleDoc>(COLLECTIONS.STYLES, sku) : null;
  const pattern = style ? await db.get<PatternDoc>(COLLECTIONS.PATTERNS, style.patternId) : null;
  if (!pattern) {
    throw new AppError(ERROR_CODES.NOT_FOUND, "Pattern not found for style");
  }

  const weaver = await db.get<UserDoc>(COLLECTIONS.USERS, params.weaverId);
  await db.atomicUpdate<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    pkg._id,
    () => true,
    (cur) => ({ ...cur, lastProgressAt: now, stallPromptedAt: undefined }),
  );

  return {
    pattern,
    watermarkText: `${weaver?.weaverNo ?? params.weaverId} · 无限天真严禁外传`,
    urlExpiresAt: now + 5 * 60 * 1000, // 5-minute ephemeral signed URL TTL
  };
}

/**
 * Round 9 Q2 compressed stall protection:
 *  - Weaver voluntary release: <=12h after accept = 0 credit penalty; >12h = -5 credit penalty.
 *  - Watchdog sweep: head package >24h idle -> prompt; >6 awake hours (skipping 00:00-08:00 CST) -> auto-reclaim.
 */
export async function releaseMakingOrderVoluntarily(
  db: DbAdapter,
  params: { packageId: string; weaverId: string; nowUtcMs?: number },
): Promise<{ penaltyApplied: number }> {
  const now = params.nowUtcMs ?? Date.now();
  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, params.packageId);
  if (!pkg || pkg.assignedWeaverId !== params.weaverId || pkg.status !== "making") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Cannot release package");
  }

  const elapsedMs = now - (pkg.acceptedAt ?? now);
  const penalty = elapsedMs <= 12 * HOUR_MS ? 0 : 5;

  const tr = await transitionStatus(
    db,
    COLLECTIONS.ORDER_PACKAGES,
    pkg._id,
    ORDER_PACKAGE_STATUS_SPEC,
    "making",
    "waiting_dispatch",
    pkg.version,
    () => ({ assignedWeaverId: undefined, queueSeq: undefined, stallPromptedAt: undefined }),
    now,
  );

  if (tr.moved) {
    await compactWeaverQueue(db, params.weaverId, now);
    if (penalty > 0) {
      await db.atomicUpdate<UserDoc>(
        COLLECTIONS.USERS,
        params.weaverId,
        () => true,
        (u) => ({ ...u, creditScore: Math.max(0, u.creditScore - penalty), updatedAt: now }),
      );
    }
  }
  return { penaltyApplied: penalty };
}

export async function sweepOffersAndStalledPackages(
  db: DbAdapter,
  nowUtcMs: number = Date.now(),
): Promise<{ timedOutOffers: number; promptedStalls: number; reclaimedStalls: number }> {
  let timedOutOffers = 0;
  let promptedStalls = 0;
  let reclaimedStalls = 0;

  // 1. Expired 1h dispatch offers
  const expiredOffers = await db.find<DispatchOfferDoc>(
    COLLECTIONS.DISPATCH_OFFERS,
    (o) => o.status === "pending" && nowUtcMs >= o.expireAt,
  );
  for (const off of expiredOffers) {
    const oTr = await transitionStatus(
      db,
      COLLECTIONS.DISPATCH_OFFERS,
      off._id,
      DISPATCH_OFFER_STATUS_SPEC,
      "pending",
      "timeout",
      off.version,
      () => ({ respondedAt: nowUtcMs }),
      nowUtcMs,
    );
    if (!oTr.moved) continue;
    timedOutOffers++;

    const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, off.packageId);
    if (pkg && pkg.status === "offered") {
      await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "offered",
        "waiting_dispatch",
        pkg.version,
        () => ({ assignedWeaverId: undefined, isReadyStockReuse: false }),
        nowUtcMs,
      );
    }

    // 3 consecutive timeouts -> pause weaver for 7 days
    await db.atomicUpdate<UserDoc>(
      COLLECTIONS.USERS,
      off.weaverId,
      () => true,
      (u) => {
        const nextTo = u.consecutiveTimeouts + 1;
        return {
          ...u,
          consecutiveTimeouts: nextTo,
          pauseUntil: nextTo >= 3 ? nowUtcMs + 7 * DAY_MS : u.pauseUntil,
          updatedAt: nowUtcMs,
        };
      },
    );
  }

  // 2. Head-of-queue stall guard (24h prompt -> 6 awake hours reclaim)
  const headMaking = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) => p.status === "making" && p.queueSeq === 1,
  );
  for (const pkg of headMaking) {
    const lastActive = pkg.lastProgressAt ?? pkg.acceptedAt ?? pkg.updatedAt;
    if (!pkg.stallPromptedAt && nowUtcMs - lastActive >= 24 * HOUR_MS) {
      const upd = await db.atomicUpdate<OrderPackageDoc>(
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        (cur) => cur.status === "making" && !cur.stallPromptedAt,
        (cur) => ({ ...cur, stallPromptedAt: nowUtcMs, updatedAt: nowUtcMs }),
      );
      if (upd.updated) promptedStalls++;
    } else if (pkg.stallPromptedAt) {
      const deadline = addAwakeHoursCst(pkg.stallPromptedAt, 6);
      if (nowUtcMs >= deadline) {
        const weaverId = pkg.assignedWeaverId;
        const tr = await transitionStatus(
          db,
          COLLECTIONS.ORDER_PACKAGES,
          pkg._id,
          ORDER_PACKAGE_STATUS_SPEC,
          "making",
          "waiting_dispatch",
          pkg.version,
          () => ({ assignedWeaverId: undefined, queueSeq: undefined, stallPromptedAt: undefined }),
          nowUtcMs,
        );
        if (tr.moved) {
          reclaimedStalls++;
          if (weaverId) await compactWeaverQueue(db, weaverId, nowUtcMs);
        }
      }
    }
  }

  return { timedOutOffers, promptedStalls, reclaimedStalls };
}

export async function compactWeaverQueue(db: DbAdapter, weaverId: string, nowUtcMs: number): Promise<void> {
  const remaining = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) =>
      p.assignedWeaverId === weaverId &&
      ["making", "photo_review", "awaiting_seal"].includes(p.status) &&
      p.queueSeq !== undefined,
  );
  remaining.sort((a, b) => (a.queueSeq ?? 999) - (b.queueSeq ?? 999));
  for (let i = 0; i < remaining.length; i++) {
    const targetSeq = i + 1;
    const item = remaining[i]!;
    if (item.queueSeq !== targetSeq) {
      await db.atomicUpdate<OrderPackageDoc>(
        COLLECTIONS.ORDER_PACKAGES,
        item._id,
        () => true,
        (cur) => ({ ...cur, queueSeq: targetSeq, updatedAt: nowUtcMs }),
      );
    }
  }
}
