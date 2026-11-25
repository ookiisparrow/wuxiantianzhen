import {
  COLLECTIONS,
  DAY_MS,
  HOUR_MS,
  addAwakeHoursCst,
  AppError,
  ERROR_CODES,
  DISPATCH_OFFER_STATUS_SPEC,
  ORDER_PACKAGE_STATUS_SPEC,
  computeWeaverFreeMin,
  estimateAvailableGrams,
  inferRegionFromProvince,
  type DispatchOfferDoc,
  type OrderPackageDoc,
  type PatternDoc,
  type StyleDoc,
  type StyleEnrollmentDoc,
  type UserDoc,
  type WeaverStockDoc,
  type YarnCatalogDoc,
} from "@wxtz/shared";
import { assertNotSelfOrder } from "../kit/auth.ts";
import type { DbAdapter } from "../kit/db.ts";
import { dispatchOfferId, weaverStockId } from "../kit/ids.ts";
import { compactWeaverQueue } from "../kit/queue.ts";
import { consumeReadyStockForAcceptedOffer } from "../kit/stockLock.ts";
import { transitionStatus } from "../kit/transition.ts";
import { consumeYarnForPackage, restoreYarnForPackage } from "../kit/yarnInventory.ts";

function normProvince(p: string): string {
  return p.trim().replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/, "");
}

async function loadUnitWeightMap(db: DbAdapter): Promise<Record<string, number>> {
  const yarns = await db.find<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, () => true);
  const out: Record<string, number> = {};
  for (const y of yarns) out[y._id] = y.unitWeightG || 50;
  return out;
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
  const pendingOfferGramsByWeaver = new Map<string, Map<string, number>>();

  for (const ap of activePkgs) {
    if (!ap.assignedWeaverId) continue;
    if (ap.status === "offered") {
      pendingOfferCountByWeaver.set(ap.assignedWeaverId, (pendingOfferCountByWeaver.get(ap.assignedWeaverId) ?? 0) + 1);
      if (!ap.isReadyStockReuse) {
        let gMap = pendingOfferGramsByWeaver.get(ap.assignedWeaverId);
        if (!gMap) {
          gMap = new Map();
          pendingOfferGramsByWeaver.set(ap.assignedWeaverId, gMap);
        }
        for (const it of ap.itemsSnapshot) {
          for (const b of it.yarnBomSnapshot) {
            gMap.set(b.yarnCode, (gMap.get(b.yarnCode) ?? 0) + b.consumedG * it.qty);
          }
        }
      }
    }
    if (["offered", "making", "photo_review"].includes(ap.status) && !ap.isReadyStockReuse) {
      backlogByWeaver.set(ap.assignedWeaverId, (backlogByWeaver.get(ap.assignedWeaverId) ?? 0) + ap.totalMin);
    }
    if (ap.status === "making" && ap.queueSeq === 1 && ap.stallPromptedAt) {
      stalledWeavers.add(ap.assignedWeaverId);
    }
  }

  // Preload prior offers: never re-offer to a weaver who rejected/timed-out, and deprioritize prior releasers
  const allOffers = await db.find<DispatchOfferDoc>(COLLECTIONS.DISPATCH_OFFERS, () => true);
  const rejectedOrExpiredByPkg = new Map<string, Set<string>>();
  const priorAcceptedByPkg = new Map<string, Set<string>>();
  for (const off of allOffers) {
    if (off.status === "rejected" || off.status === "timeout") {
      let s = rejectedOrExpiredByPkg.get(off.packageId);
      if (!s) {
        s = new Set();
        rejectedOrExpiredByPkg.set(off.packageId, s);
      }
      s.add(off.weaverId);
    } else if (off.status === "accepted") {
      let s = priorAcceptedByPkg.get(off.packageId);
      if (!s) {
        s = new Set();
        priorAcceptedByPkg.set(off.packageId, s);
      }
      s.add(off.weaverId);
    }
  }

  // Preload ready stock docs & track unreserved free stock across this tick
  const allStocks = await db.find<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, () => true);
  const stockDocById = new Map(allStocks.map((s) => [s._id, s]));
  const freeStockByDocId = new Map(allStocks.map((s) => [s._id, s.availableQty]));

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
    const buyerProvNorm = normProvince(pkg.buyerProvince);
    const rejectedOrExpired = rejectedOrExpiredByPkg.get(pkg._id);
    const priorAccepted = priorAcceptedByPkg.get(pkg._id);
    const pkgOrderSet = new Set(pkg.orderIds);

    // Aggregate total BOM grams required across ALL items in this package
    const pkgNeedGrams = new Map<string, number>();
    for (const it of pkg.itemsSnapshot) {
      for (const b of it.yarnBomSnapshot) {
        pkgNeedGrams.set(b.yarnCode, (pkgNeedGrams.get(b.yarnCode) ?? 0) + b.consumedG * it.qty);
      }
    }

    // Candidate pool rule (docs/07 §16): douyin_online ONLY live pool; mp_wechat allows mp (priority) + live (overflow)
    const eligibleWeavers = weavers.filter((w) => {
      if (pkg.channel === "douyin_online" && w.pool !== "live") return false;
      if (pkg.buyerUserId && pkg.buyerUserId === w._id) return false; // Hard anti-self-order
      if (rejectedOrExpired?.has(w._id)) return false; // Never re-offer to weaver who rejected or timed out
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
      usesPaidReservation: boolean;
      stockDocId?: string;
    };
    const scored: ScoredCandidate[] = [];

    for (const w of eligibleWeavers) {
      let holdsReadyStock = false;
      let usesPaidReservation = false;
      let stockDocId: string | undefined;

      if (pkg.itemsSnapshot.length === 1) {
        const only = pkg.itemsSnapshot[0]!;
        const sId = weaverStockId(w._id, only.skuCode);
        const st = stockDocById.get(sId);
        if (st) {
          const reservedForPkg = st.reservations
            .filter((r) => pkgOrderSet.has(r.orderId) || r.packageId === pkg._id)
            .reduce((sum, r) => sum + r.qty, 0);
          if (reservedForPkg >= only.qty) {
            holdsReadyStock = true;
            usesPaidReservation = true;
            stockDocId = sId;
          } else if ((freeStockByDocId.get(sId) ?? 0) >= only.qty) {
            holdsReadyStock = true;
            stockDocId = sId;
          }
        }
      }

      if (!holdsReadyStock) {
        // If package came from an explicit ready_stock SKU and this weaver has no ready stock, cannot make to order unless weaver has MTO capacity; check aggregate time + enrollment + yarn
        const certified = certifiedByWeaver.get(w._id) ?? [];
        let enrolledAll = true;
        for (const item of pkg.itemsSnapshot) {
          const styleDoc = styleMap.get(item.skuCode);
          if (styleDoc?.requiresEnrollment && !certified.includes(item.skuCode)) {
            enrolledAll = false;
            break;
          }
        }
        if (!enrolledAll) continue;

        const backlog = backlogByWeaver.get(w._id) ?? 0;
        const freeMin = computeWeaverFreeMin(
          {
            userId: w._id,
            acceptingOrders: w.acceptingOrders,
            pauseUntil: w.pauseUntil,
            restDays: w.restDays,
            dailyCapacityMin: w.dailyCapacityMin,
            speedFactor: w.speedFactor,
            backlogMin: backlog,
            yarnInventory: w.yarnInventory,
            certifiedStyleCodes: certified,
          },
          { nowUtcMs: now, horizonDays },
        );
        if (pkg.totalMin <= 0 || freeMin < pkg.totalMin) continue;

        const pendingG = pendingOfferGramsByWeaver.get(w._id);
        let enoughYarn = true;
        for (const [yarnCode, needG] of pkgNeedGrams.entries()) {
          if (needG <= 0) continue;
          const unitG = yarnWeightMap.get(yarnCode) ?? 50;
          const availG = estimateAvailableGrams(w.yarnInventory[yarnCode], unitG) - (pendingG?.get(yarnCode) ?? 0);
          if (availG < needG) {
            enoughYarn = false;
            break;
          }
        }
        if (!enoughYarn) continue;
      }

      const wProvince = normProvince(w.cityQuotaKey?.split("-")[0] ?? "");
      let tier: DispatchOfferDoc["matchTier"] = "national";
      let tierRank = 4;
      if (holdsReadyStock) {
        tier = "stock";
        tierRank = 0;
      } else if (wProvince && buyerProvNorm && buyerProvNorm === wProvince) {
        tier = "same_province";
        tierRank = 1;
      } else if (w.regionCode === buyerRegion) {
        tier = "same_region";
        tierRank = 2;
      }
      if (pkg.channel === "mp_wechat" && w.pool === "live" && !holdsReadyStock) {
        tierRank += 0.5;
      }
      if (priorAccepted?.has(w._id)) {
        tierRank += 10; // Prefer any untried weaver before falling back to a prior releaser
      }

      scored.push({
        weaver: w,
        tier,
        tierRank,
        isStockReuse: holdsReadyStock,
        usesPaidReservation,
        stockDocId,
      });
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
      if (chosen.isStockReuse) {
        if (!chosen.usesPaidReservation && chosen.stockDocId) {
          const only = pkg.itemsSnapshot[0]!;
          freeStockByDocId.set(
            chosen.stockDocId,
            Math.max(0, (freeStockByDocId.get(chosen.stockDocId) ?? 0) - only.qty),
          );
        }
      } else {
        backlogByWeaver.set(chosen.weaver._id, (backlogByWeaver.get(chosen.weaver._id) ?? 0) + pkg.totalMin);
        let gMap = pendingOfferGramsByWeaver.get(chosen.weaver._id);
        if (!gMap) {
          gMap = new Map();
          pendingOfferGramsByWeaver.set(chosen.weaver._id, gMap);
        }
        for (const [yarnCode, needG] of pkgNeedGrams.entries()) {
          gMap.set(yarnCode, (gMap.get(yarnCode) ?? 0) + needG);
        }
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
    const stockRes = await consumeReadyStockForAcceptedOffer(db, {
      weaverId: params.weaverId,
      skuCode: only.skuCode,
      qty: only.qty,
      orderIds: pkg.orderIds,
      packageId: pkg._id,
      nowUtcMs: now,
    });
    if (!stockRes.consumed) {
      // Stock was already consumed concurrently; return package cleanly to waiting_dispatch
      const backTr = await transitionStatus(
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
      return { status: backTr.doc?.status ?? "waiting_dispatch", triggeredYarnChecks: [] };
    }

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
    const unitWeightByYarn = await loadUnitWeightMap(db);
    const yarnRes = await consumeYarnForPackage(db, params.weaverId, tr.doc, unitWeightByYarn, now);
    triggeredYarnChecks = yarnRes.triggeredCheckCodes;
  }

  return { status: tr.doc!.status, queueSeq: nextSeq, triggeredYarnChecks };
}

/**
 * Unlocks structured lyric-style pattern(s) ONLY for the weaver's head-of-queue (`queueSeq === 1`) package.
 */
export async function getHeadPatternForWeaver(
  db: DbAdapter,
  params: { packageId: string; weaverId: string; skuCode?: string; nowUtcMs?: number },
): Promise<{
  pattern: PatternDoc;
  patterns: PatternDoc[];
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

  const patterns: PatternDoc[] = [];
  const seenSku = new Set<string>();
  for (const item of pkg.itemsSnapshot) {
    if (seenSku.has(item.skuCode)) continue;
    seenSku.add(item.skuCode);
    const st = await db.get<StyleDoc>(COLLECTIONS.STYLES, item.skuCode);
    const pat = st ? await db.get<PatternDoc>(COLLECTIONS.PATTERNS, st.patternId) : null;
    if (pat) patterns.push(pat);
  }
  const primary = params.skuCode
    ? patterns.find((p) => p.skuCode === params.skuCode) ?? patterns[0]
    : patterns[0];
  if (!primary) {
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
    pattern: primary,
    patterns,
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
    const unitWeightByYarn = await loadUnitWeightMap(db);
    await restoreYarnForPackage(db, params.weaverId, pkg, unitWeightByYarn, now);
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
    const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, off.packageId);
    // If buyer already cancelled the package before offer expiry, cancel the offer cleanly without penalizing weaver!
    if (!pkg || pkg.status !== "offered") {
      await transitionStatus(
        db,
        COLLECTIONS.DISPATCH_OFFERS,
        off._id,
        DISPATCH_OFFER_STATUS_SPEC,
        "pending",
        "cancelled",
        off.version,
        () => ({ respondedAt: nowUtcMs }),
        nowUtcMs,
      );
      continue;
    }

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
  const unitWeightByYarn = headMaking.length > 0 ? await loadUnitWeightMap(db) : {};
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
          if (weaverId) {
            await restoreYarnForPackage(db, weaverId, pkg, unitWeightByYarn, nowUtcMs);
            await compactWeaverQueue(db, weaverId, nowUtcMs);
          }
        }
      }
    }
  }

  return { timedOutOffers, promptedStalls, reclaimedStalls };
}
