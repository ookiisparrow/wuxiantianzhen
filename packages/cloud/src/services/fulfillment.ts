import {
  COLLECTIONS,
  DAY_MS,
  HOUR_MS,
  AppError,
  ERROR_CODES,
  LEDGER_ACCOUNT_CODES,
  ZERO_FEN,
  addFen,
  asNonNegativeFen,
  formatCstYmd,
  BAG_STICKER_STATUS_SPEC,
  ORDER_PACKAGE_STATUS_SPEC,
  PHOTO_REVIEW_STATUS_SPEC,
  SHIPMENT_STATUS_SPEC,
  type AddressDoc,
  type Fen,
  type BagStickerDoc,
  type OrderDoc,
  type OrderPackageDoc,
  type PhotoReviewDoc,
  type ShipmentDoc,
  type StyleDoc,
  type UserDoc,
  type VolunteerDoc,
  type VolunteerVoteDoc,
} from "@wxtz/shared";
import type { DbAdapter } from "../kit/db.ts";
import { bagStickerId, ledgerKeyShipFee, newReviewId, shipmentId, volunteerId, volunteerVoteId } from "../kit/ids.ts";
import { accrueSettledPackage, postLedgerEntry } from "../kit/ledger.ts";
import { compactWeaverQueue } from "../kit/queue.ts";
import { updateWeaverSpeedFactorOnShipped } from "../kit/speed.ts";
import { transitionStatus } from "../kit/transition.ts";
import type { LogisticsPort } from "../ports/index.ts";

/**
 * Weaver submits finished work from `making`:
 *  - High-credit skip (`pkg.reviewMode === 'skip'`): 1-step merged submission (photos + bag sticker + seal photo) -> `ready_to_ship`.
 *  - Standard/new weaver (`required`/`sampled`): requires 3 fixed camera angles (frontOnScaleCard, backStitch, sidePlumpness),
 *    checks pHash duplicate fraud across orders, creates 2h SLA review -> `photo_review` (bag sticker NOT bound yet!).
 */
export async function submitFinishedWork(
  db: DbAdapter,
  params: {
    packageId: string;
    weaverId: string;
    photoSlots: { frontOnScaleCard: string; backStitch: string; sidePlumpness: string };
    imageHashes: string[];
    bagStickerCode?: string; // required only when reviewMode === 'skip'
    sealedPhotoFileId?: string; // required only when reviewMode === 'skip'
    pickupWindow?: string;
    selfDropoffTrackingNo?: string;
    standardSelfShipReimbFen?: Fen;
    logisticsPort?: LogisticsPort;
    nowUtcMs?: number;
  },
): Promise<{ nextStatus: OrderPackageDoc["status"]; reviewId?: string; duplicateFlagged?: boolean }> {
  const now = params.nowUtcMs ?? Date.now();
  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, params.packageId);
  if (!pkg || pkg.assignedWeaverId !== params.weaverId || pkg.status !== "making") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Package is not in making state for this weaver");
  }
  if (
    !params.photoSlots.frontOnScaleCard ||
    !params.photoSlots.backStitch ||
    !params.photoSlots.sidePlumpness
  ) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "必须上传齐 3 张标准机位照（正面压标准刻度比对卡 / 背面藏线特写 / 侧面饱满度）",
    );
  }

  // pHash cross-package duplicate check
  const priorReviews = await db.find<PhotoReviewDoc>(
    COLLECTIONS.PHOTO_REVIEWS,
    (r) => r.targetId !== pkg._id && r.imageHashes.some((h) => params.imageHashes.includes(h)),
  );
  const duplicateFlag = priorReviews.length > 0;

  // High-credit merged 1-step direct ship (ONLY if no duplicate image hash hit!)
  if (pkg.reviewMode === "skip" && !duplicateFlag) {
    if (!params.bagStickerCode || !params.sealedPhotoFileId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, "免审直发需同时扫袋码贴纸并上传封签留底照");
    }
    await bindBagStickerToPackage(db, params.weaverId, params.bagStickerCode, pkg._id, now);
    const shipDoc = await createReadyShipment(
      db,
      pkg,
      params.weaverId,
      params.sealedPhotoFileId,
      params.pickupWindow,
      now,
      params.selfDropoffTrackingNo,
      params.standardSelfShipReimbFen,
    );

    const tr = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "making",
      "ready_to_ship",
      pkg.version,
      () => ({ bagQrCode: params.bagStickerCode, queueSeq: undefined, lastProgressAt: now }),
      now,
    );
    let finalStatus: OrderPackageDoc["status"] = "ready_to_ship";
    if (tr.moved && tr.doc && shipDoc.fulfillMode === "weaver_self_ship" && params.selfDropoffTrackingNo) {
      const trShip = await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "ready_to_ship",
        "shipped",
        tr.doc.version,
        () => ({ shippedAt: now }),
        now,
      );
      if (trShip.moved) {
        finalStatus = "shipped";
        await updateWeaverSpeedFactorOnShipped(db, pkg, now);
      }
    } else if (
      tr.moved &&
      pkg.channel === "mp_wechat" &&
      shipDoc.fulfillMode === "kuaidi100_pickup" &&
      params.logisticsPort
    ) {
      const sched = await scheduleMpPickupForShipment(db, pkg._id, params.logisticsPort, now);
      if (sched.movedToManualHold) {
        finalStatus = "manual_hold";
      }
    }
    if (tr.moved) {
      await compactWeaverQueue(db, params.weaverId, now);
    }
    return { nextStatus: finalStatus };
  }

  // Standard 3-slot photo review path
  const sku = pkg.itemsSnapshot[0]?.skuCode;
  const style = sku ? await db.get<StyleDoc>(COLLECTIONS.STYLES, sku) : null;
  const isCreatorLed = style?.qcOwner === "creator_led" && Boolean(style.creatorUserId);

  const revId = newReviewId();
  const reviewDoc: PhotoReviewDoc = {
    _id: revId,
    scene: "shipment_qc",
    targetId: pkg._id,
    weaverId: params.weaverId,
    skuCode: sku,
    photoSlots: params.photoSlots,
    photoFileIds: [
      params.photoSlots.frontOnScaleCard,
      params.photoSlots.backStitch,
      params.photoSlots.sidePlumpness,
    ],
    imageHashes: params.imageHashes,
    duplicateFlag,
    isCalibrationSample: false,
    requiredVotes: isCreatorLed ? 1 : 5,
    slaDeadlineAt: now + 2 * HOUR_MS,
    voteCount: 0,
    status: duplicateFlag ? "needs_admin" : "pending",
    version: 1,
    createdAt: now,
  };
  await db.insert(COLLECTIONS.PHOTO_REVIEWS, reviewDoc);

  await transitionStatus(
    db,
    COLLECTIONS.ORDER_PACKAGES,
    pkg._id,
    ORDER_PACKAGE_STATUS_SPEC,
    "making",
    "photo_review",
    pkg.version,
    () => ({ lastProgressAt: now }),
    now,
  );

  return { nextStatus: "photo_review", reviewId: revId, duplicateFlagged: duplicateFlag };
}

/**
 * Fan volunteer onboarding 5-question defect-spotting test (Round 9 Q4).
 */
export async function activateFanVolunteerAfterExam(
  db: DbAdapter,
  params: { userId: string; correctCount: number; totalQuestions?: number; nowUtcMs?: number },
): Promise<VolunteerDoc> {
  const reqTotal = params.totalQuestions ?? 5;
  if (params.correctCount < reqTotal) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `次品找茬上岗考需全对 ${reqTotal} 题（当前答对 ${params.correctCount} 题）`);
  }
  const now = params.nowUtcMs ?? Date.now();
  const vId = volunteerId(params.userId);
  const vol: VolunteerDoc = {
    _id: vId,
    userId: params.userId,
    source: "fan",
    status: "active",
    onboardingExamPassedAt: now,
    dailyLimit: 30,
    todayCount: 0,
    todayDate: "",
    points: 10,
    calibrationTotal: reqTotal,
    calibrationCorrect: params.correctCount,
    recentWeaverIds: [],
    joinedAt: now,
  };
  await db.put(COLLECTIONS.VOLUNTEERS, vol);
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    params.userId,
    () => true,
    (u) => ({
      ...u,
      roles: u.roles.includes("volunteer") ? u.roles : [...u.roles, "volunteer"],
      updatedAt: now,
    }),
  );
  return vol;
}

/**
 * Fetches blind review card stripped of ALL weaver identity fields (`weaverId` removed).
 */
export async function getBlindReviewCardForVolunteer(
  db: DbAdapter,
  reviewId: string,
  volunteerUserId: string,
): Promise<Omit<PhotoReviewDoc, "weaverId">> {
  const vol = await db.get<VolunteerDoc>(COLLECTIONS.VOLUNTEERS, volunteerId(volunteerUserId));
  if (!vol || vol.status !== "active") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Volunteer has not passed onboarding exam or is inactive");
  }
  const rev = await db.get<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, reviewId);
  if (!rev) throw new AppError(ERROR_CODES.NOT_FOUND, "Review not found");
  if (rev.weaverId === volunteerUserId || vol.recentWeaverIds.includes(rev.weaverId)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Blind review conflict-of-interest avoidance");
  }
  const { weaverId: _redacted, ...safeCard } = rev;
  return safeCard;
}

/**
 * Casts an anonymous fan-volunteer vote (enforcing >= 8000ms dwell time & spread >= 3 escalation).
 */
export async function castVolunteerVote(
  db: DbAdapter,
  params: {
    reviewId: string;
    volunteerUserId: string;
    score: number; // 1..5
    tags?: string[];
    dwellMs: number;
    nowUtcMs?: number;
  },
): Promise<{ reviewStatus: PhotoReviewDoc["status"] }> {
  if (params.dwellMs < 8000) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "每张审核卡需至少仔细查看 8 秒才可提交");
  }
  if (!Number.isInteger(params.score) || params.score < 1 || params.score > 5) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "评分须为 1–5 整数");
  }
  const now = params.nowUtcMs ?? Date.now();
  const vol = await db.get<VolunteerDoc>(COLLECTIONS.VOLUNTEERS, volunteerId(params.volunteerUserId));
  if (!vol || vol.status !== "active") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Volunteer not active");
  }
  const rev = await db.get<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, params.reviewId);
  if (!rev || rev.status !== "pending") {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "Review is no longer pending");
  }
  if (rev.weaverId === params.volunteerUserId || vol.recentWeaverIds.includes(rev.weaverId)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Blind review conflict-of-interest avoidance");
  }

  const todayYmd = formatCstYmd(now);
  const curTodayCount = vol.todayDate === todayYmd ? vol.todayCount : 0;
  if (curTodayCount >= vol.dailyLimit) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "今日盲审张数已达上限，明天再来吧");
  }

  const voteKey = volunteerVoteId(rev._id, params.volunteerUserId);
  const ins = await db.insert<VolunteerVoteDoc>(COLLECTIONS.VOLUNTEER_VOTES, {
    _id: voteKey,
    reviewId: rev._id,
    volunteerUserId: params.volunteerUserId,
    score: params.score,
    tags: params.tags ?? [],
    dwellMs: params.dwellMs,
    createdAt: now,
  });
  if (!ins.inserted) {
    throw new AppError(ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY, "Already voted on this review");
  }

  // Update volunteer points, daily counter & avoidance window
  await db.atomicUpdate<VolunteerDoc>(
    COLLECTIONS.VOLUNTEERS,
    vol._id,
    () => true,
    (v) => {
      const baseCount = v.todayDate === todayYmd ? v.todayCount : 0;
      return {
        ...v,
        todayDate: todayYmd,
        todayCount: baseCount + 1,
        points: v.points + 2,
        recentWeaverIds: [...v.recentWeaverIds.slice(-9), rev.weaverId],
      };
    },
  );

  const allVotes = await db.find<VolunteerVoteDoc>(COLLECTIONS.VOLUNTEER_VOTES, (v) => v.reviewId === rev._id);
  const scores = allVotes.map((v) => v.score).sort((a, b) => a - b);
  const spread = scores.length > 0 ? scores[scores.length - 1]! - scores[0]! : 0;

  let avg = 0;
  if (scores.length >= 5) {
    const trimmed = scores.slice(1, -1);
    avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  } else if (scores.length > 0) {
    avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  if (scores.length < rev.requiredVotes) {
    await db.atomicUpdate<PhotoReviewDoc>(
      COLLECTIONS.PHOTO_REVIEWS,
      rev._id,
      () => true,
      (cur) => ({ ...cur, voteCount: scores.length, avgScore: avg, scoreSpread: spread }),
    );
    return { reviewStatus: "pending" };
  }

  // Enough votes collected
  if (spread >= 3) {
    await transitionStatus(
      db,
      COLLECTIONS.PHOTO_REVIEWS,
      rev._id,
      PHOTO_REVIEW_STATUS_SPEC,
      "pending",
      "needs_admin",
      rev.version,
      () => ({ voteCount: scores.length, avgScore: avg, scoreSpread: spread }),
      now,
    );
    return { reviewStatus: "needs_admin" };
  }

  const nextStatus: PhotoReviewDoc["status"] = avg >= 4.0 ? "approved" : "rejected";
  const tr = await transitionStatus(
    db,
    COLLECTIONS.PHOTO_REVIEWS,
    rev._id,
    PHOTO_REVIEW_STATUS_SPEC,
    "pending",
    nextStatus,
    rev.version,
    () => ({ voteCount: scores.length, avgScore: avg, scoreSpread: spread, decidedAt: now }),
    now,
  );
  if (tr.moved && rev.scene === "shipment_qc") {
    await applyShipmentQcDecision(db, rev.targetId, nextStatus === "approved", now);
  }
  return { reviewStatus: nextStatus };
}

/**
 * 2-hour SLA watchdog (Round 9 Q4):
 * If `now >= slaDeadlineAt` and review is still `pending`:
 *   - >=2 votes all >=4 from high-accuracy volunteers -> auto-approve so same-day courier isn't missed!
 *   - otherwise -> escalate to `needs_admin` for 10-second admin decision.
 */
export async function sweepPhotoReviewSla(
  db: DbAdapter,
  nowUtcMs: number = Date.now(),
): Promise<{ autoApproved: number; escalatedToAdmin: number }> {
  const overdue = await db.find<PhotoReviewDoc>(
    COLLECTIONS.PHOTO_REVIEWS,
    (r) => r.status === "pending" && nowUtcMs >= r.slaDeadlineAt,
  );
  let autoApproved = 0;
  let escalatedToAdmin = 0;

  for (const rev of overdue) {
    const votes = await db.find<VolunteerVoteDoc>(COLLECTIONS.VOLUNTEER_VOTES, (v) => v.reviewId === rev._id);
    let allHighAndTrusted = votes.length >= 2 && votes.every((v) => v.score >= 4);
    if (allHighAndTrusted) {
      for (const v of votes) {
        const vDoc = await db.get<VolunteerDoc>(COLLECTIONS.VOLUNTEERS, volunteerId(v.volunteerUserId));
        const acc = vDoc && vDoc.calibrationTotal > 0 ? vDoc.calibrationCorrect / vDoc.calibrationTotal : 0;
        if (!vDoc || vDoc.status !== "active" || acc < 0.8) {
          allHighAndTrusted = false;
          break;
        }
      }
    }

    if (allHighAndTrusted) {
      const tr = await transitionStatus(
        db,
        COLLECTIONS.PHOTO_REVIEWS,
        rev._id,
        PHOTO_REVIEW_STATUS_SPEC,
        "pending",
        "approved",
        rev.version,
        () => ({ finalDecisionBy: "sla_2h_fast_pass", decidedAt: nowUtcMs }),
        nowUtcMs,
      );
      if (tr.moved) {
        autoApproved++;
        if (rev.scene === "shipment_qc") {
          await applyShipmentQcDecision(db, rev.targetId, true, nowUtcMs);
        }
      }
    } else {
      const tr = await transitionStatus(
        db,
        COLLECTIONS.PHOTO_REVIEWS,
        rev._id,
        PHOTO_REVIEW_STATUS_SPEC,
        "pending",
        "needs_admin",
        rev.version,
        undefined,
        nowUtcMs,
      );
      if (tr.moved) escalatedToAdmin++;
    }
  }
  return { autoApproved, escalatedToAdmin };
}

/**
 * 10-second admin arbitration for escalated (`needs_admin`) photo reviews.
 */
export async function adminArbitratePhotoReview(
  db: DbAdapter,
  params: {
    reviewId: string;
    adminUserId: string;
    approve: boolean;
    nowUtcMs?: number;
  },
): Promise<{ reviewStatus: PhotoReviewDoc["status"] }> {
  const now = params.nowUtcMs ?? Date.now();
  const rev = await db.get<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, params.reviewId);
  if (!rev || rev.status !== "needs_admin") {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "该审照单不在待仲裁状态");
  }
  const nextStatus: PhotoReviewDoc["status"] = params.approve ? "approved" : "rejected";
  const tr = await transitionStatus(
    db,
    COLLECTIONS.PHOTO_REVIEWS,
    rev._id,
    PHOTO_REVIEW_STATUS_SPEC,
    "needs_admin",
    nextStatus,
    rev.version,
    () => ({ finalDecisionBy: params.adminUserId, decidedAt: now }),
    now,
  );
  if (tr.moved && rev.scene === "shipment_qc") {
    await applyShipmentQcDecision(db, rev.targetId, params.approve, now);
  }
  return { reviewStatus: nextStatus };
}

async function applyShipmentQcDecision(
  db: DbAdapter,
  packageId: string,
  approved: boolean,
  nowUtcMs: number,
): Promise<void> {
  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, packageId);
  if (!pkg || pkg.status !== "photo_review") return;
  await transitionStatus(
    db,
    COLLECTIONS.ORDER_PACKAGES,
    pkg._id,
    ORDER_PACKAGE_STATUS_SPEC,
    "photo_review",
    approved ? "awaiting_seal" : "making",
    pkg.version,
    () => ({ lastProgressAt: nowUtcMs }),
    nowUtcMs,
  );
}

/**
 * After `awaiting_seal` (either post-review OR ready-stock direct seal),
 * weaver binds bag sticker + uploads tamper-evident seal photo -> `ready_to_ship`,
 * and promotes next queued package to `queueSeq = 1`.
 */
export async function sealAndSubmitShipment(
  db: DbAdapter,
  params: {
    packageId: string;
    weaverId: string;
    bagStickerCode: string;
    sealedPhotoFileId: string;
    pickupWindow?: string;
    selfDropoffTrackingNo?: string; // if weaver is in township self_dropoff mode
    standardSelfShipReimbFen?: Fen;
    logisticsPort?: LogisticsPort;
    nowUtcMs?: number;
  },
): Promise<{ status: OrderPackageDoc["status"] }> {
  const now = params.nowUtcMs ?? Date.now();
  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, params.packageId);
  if (!pkg || pkg.assignedWeaverId !== params.weaverId || pkg.status !== "awaiting_seal") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Package is not awaiting seal for this weaver");
  }

  await bindBagStickerToPackage(db, params.weaverId, params.bagStickerCode, pkg._id, now);
  const shipDoc = await createReadyShipment(
    db,
    pkg,
    params.weaverId,
    params.sealedPhotoFileId,
    params.pickupWindow,
    now,
    params.selfDropoffTrackingNo,
    params.standardSelfShipReimbFen,
  );

  let finalStatus: OrderPackageDoc["status"] =
    shipDoc.fulfillMode === "weaver_self_ship" && params.selfDropoffTrackingNo ? "shipped" : "ready_to_ship";

  if (finalStatus === "shipped") {
    // Move awaiting_seal -> ready_to_ship -> shipped cleanly
    const tr1 = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "awaiting_seal",
      "ready_to_ship",
      pkg.version,
      () => ({ bagQrCode: params.bagStickerCode, queueSeq: undefined }),
      now,
    );
    if (tr1.moved && tr1.doc) {
      const tr2 = await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "ready_to_ship",
        "shipped",
        tr1.doc.version,
        () => ({ shippedAt: now }),
        now,
      );
      if (tr2.moved) {
        await updateWeaverSpeedFactorOnShipped(db, pkg, now);
      }
    }
  } else {
    const tr = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "awaiting_seal",
      "ready_to_ship",
      pkg.version,
      () => ({ bagQrCode: params.bagStickerCode, queueSeq: undefined }),
      now,
    );
    if (
      tr.moved &&
      pkg.channel === "mp_wechat" &&
      shipDoc.fulfillMode === "kuaidi100_pickup" &&
      params.logisticsPort
    ) {
      const sched = await scheduleMpPickupForShipment(db, pkg._id, params.logisticsPort, now);
      if (sched.movedToManualHold) {
        finalStatus = "manual_hold";
      }
    }
  }

  await compactWeaverQueue(db, params.weaverId, now);
  return { status: finalStatus };
}

async function bindBagStickerToPackage(
  db: DbAdapter,
  weaverId: string,
  code: string,
  packageId: string,
  nowUtcMs: number,
): Promise<void> {
  const id = bagStickerId(code);
  const stk = await db.get<BagStickerDoc>(COLLECTIONS.BAG_STICKERS, id);
  if (!stk || stk.weaverId !== weaverId || stk.status !== "unused") {
    throw new AppError(ERROR_CODES.FORBIDDEN, `袋码贴纸不可用或不属于当前织女：${code}`);
  }
  const tr = await transitionStatus(
    db,
    COLLECTIONS.BAG_STICKERS,
    id,
    BAG_STICKER_STATUS_SPEC,
    "unused",
    "bound",
    stk.version,
    () => ({ boundPackageId: packageId, boundAt: nowUtcMs }),
    nowUtcMs,
  );
  if (!tr.moved) {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, `袋码贴纸已被并发绑定：${code}`);
  }
}

async function createReadyShipment(
  db: DbAdapter,
  pkg: OrderPackageDoc,
  weaverId: string,
  sealedPhotoFileId: string,
  pickupWindow: string | undefined,
  nowUtcMs: number,
  selfDropoffTrackingNo?: string,
  standardSelfShipReimbFen?: Fen,
): Promise<ShipmentDoc> {
  const weaver = await db.get<UserDoc>(COLLECTIONS.USERS, weaverId);
  let fulfillMode: ShipmentDoc["fulfillMode"] =
    pkg.channel === "douyin_online" ? "douyin_erp" : "kuaidi100_pickup";
  if (weaver?.shippingMode === "self_dropoff") {
    fulfillMode = "weaver_self_ship";
  }

  let senderAddrId = weaver?.defaultSendAddrId;
  if (!senderAddrId) {
    const addrs = await db.find<AddressDoc>(
      COLLECTIONS.ADDRESSES,
      (a) => a.ownerUserId === weaverId && a.type === "weaver_send",
    );
    addrs.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    senderAddrId = addrs[0]?._id;
  }

  let receiverAddrId: string | undefined;
  if (pkg.channel === "mp_wechat" && pkg.orderIds[0]) {
    const ord = await db.get<OrderDoc>(COLLECTIONS.ORDERS, pkg.orderIds[0]);
    receiverAddrId = ord?.receiverAddrId;
  }

  const doc: ShipmentDoc = {
    _id: shipmentId(pkg._id),
    packageId: pkg._id,
    fulfillMode,
    pickupWindow,
    sealedPhotoFileId,
    doudianAddressAlias: weaver?.doudianAddressAlias,
    senderAddrId,
    receiverAddrId,
    trackingNo: selfDropoffTrackingNo,
    selfShipReimbFen: fulfillMode === "weaver_self_ship" ? standardSelfShipReimbFen : undefined,
    pickupRetryCount: 0,
    status: selfDropoffTrackingNo ? "in_transit" : "ready_to_ship",
    version: 1,
    updatedAt: nowUtcMs,
  };
  await db.put(COLLECTIONS.SHIPMENTS, doc);
  return doc;
}

/**
 * Schedules doorstep courier pickup via Kuaidi100 (`privacyWaybill: true`) for MP packages in `ready_to_ship`.
 * On failure, increments `pickupRetryCount`; once retries exceed 2 (>2), moves shipment to `cancelled`
 * and escalates package `ready_to_ship -> manual_hold` (docs/07 §4.1).
 */
export async function scheduleMpPickupForShipment(
  db: DbAdapter,
  packageId: string,
  logisticsPort: LogisticsPort,
  nowUtcMs: number = Date.now(),
): Promise<{
  scheduled: boolean;
  taskId?: string;
  carrierCode?: string;
  retries?: number;
  movedToManualHold?: boolean;
}> {
  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, packageId);
  const ship = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(packageId));
  if (!pkg || !ship || ship.status !== "ready_to_ship") {
    return { scheduled: false };
  }

  let senderAddr = ship.senderAddrId ? await db.get<AddressDoc>(COLLECTIONS.ADDRESSES, ship.senderAddrId) : null;
  if (!senderAddr && pkg.assignedWeaverId) {
    const addrs = await db.find<AddressDoc>(
      COLLECTIONS.ADDRESSES,
      (a) => a.ownerUserId === pkg.assignedWeaverId && a.type === "weaver_send",
    );
    addrs.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    senderAddr = addrs[0] ?? null;
  }

  let receiverAddr = ship.receiverAddrId ? await db.get<AddressDoc>(COLLECTIONS.ADDRESSES, ship.receiverAddrId) : null;
  if (!receiverAddr && pkg.orderIds[0]) {
    const ord = await db.get<OrderDoc>(COLLECTIONS.ORDERS, pkg.orderIds[0]);
    if (ord?.receiverAddrId) {
      receiverAddr = await db.get<AddressDoc>(COLLECTIONS.ADDRESSES, ord.receiverAddrId);
    }
  }

  if (!senderAddr || !receiverAddr) {
    return { scheduled: false };
  }

  try {
    const gw = await logisticsPort.scheduleDoorstepPickup({
      packageId: pkg._id,
      sender: {
        contactName: senderAddr.contactName,
        contactPhone: senderAddr.contactPhone,
        province: senderAddr.province,
        city: senderAddr.city,
        district: senderAddr.district,
        detail: senderAddr.detail,
      },
      receiver: {
        contactName: receiverAddr.contactName,
        contactPhone: receiverAddr.contactPhone,
        province: receiverAddr.province,
        city: receiverAddr.city,
        district: receiverAddr.district,
        detail: receiverAddr.detail,
      },
      pickupWindow: ship.pickupWindow,
      privacyWaybill: true,
    });

    const tr = await transitionStatus(
      db,
      COLLECTIONS.SHIPMENTS,
      ship._id,
      SHIPMENT_STATUS_SPEC,
      "ready_to_ship",
      "pickup_scheduled",
      ship.version,
      () => ({
        senderAddrId: senderAddr._id,
        receiverAddrId: receiverAddr._id,
        kuaidi100TaskId: gw.taskId,
        carrierCode: gw.carrierCode,
      }),
      nowUtcMs,
    );
    return {
      scheduled: tr.moved,
      taskId: gw.taskId,
      carrierCode: gw.carrierCode,
      retries: ship.pickupRetryCount,
      movedToManualHold: false,
    };
  } catch {
    const nextRetry = ship.pickupRetryCount + 1;
    if (nextRetry > 2) {
      await transitionStatus(
        db,
        COLLECTIONS.SHIPMENTS,
        ship._id,
        SHIPMENT_STATUS_SPEC,
        "ready_to_ship",
        "cancelled",
        ship.version,
        () => ({ pickupRetryCount: nextRetry, kuaidi100TaskId: undefined }),
        nowUtcMs,
      );
      let movedHold = false;
      const curPkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkg._id);
      if (curPkg && curPkg.status === "ready_to_ship") {
        const pTr = await transitionStatus(
          db,
          COLLECTIONS.ORDER_PACKAGES,
          curPkg._id,
          ORDER_PACKAGE_STATUS_SPEC,
          "ready_to_ship",
          "manual_hold",
          curPkg.version,
          undefined,
          nowUtcMs,
        );
        movedHold = pTr.moved;
      }
      return { scheduled: false, retries: nextRetry, movedToManualHold: movedHold };
    }

    await db.atomicUpdate<ShipmentDoc>(
      COLLECTIONS.SHIPMENTS,
      ship._id,
      (cur) => cur.version === ship.version,
      (cur) => ({ ...cur, pickupRetryCount: nextRetry, version: cur.version + 1, updatedAt: nowUtcMs }),
    );
    return { scheduled: false, retries: nextRetry, movedToManualHold: false };
  }
}

/**
 * Handles Kuaidi100 webhook state callbacks (`picked_up`, `signed`, `pickup_failed`, `lost`).
 */
export async function handleKuaidi100Webhook(
  db: DbAdapter,
  params: {
    packageId?: string;
    taskId?: string;
    state: "picked_up" | "signed" | "pickup_failed" | "lost" | (string & {});
    trackingNo?: string;
    carrierCode?: string;
    shippingCostFen?: number;
    logisticsPort?: LogisticsPort;
    nowUtcMs?: number;
  },
): Promise<{
  packageId: string;
  shipmentStatus: ShipmentDoc["status"];
  packageStatus: OrderPackageDoc["status"];
  retries?: number;
  movedToManualHold?: boolean;
}> {
  const now = params.nowUtcMs ?? Date.now();
  let ship: ShipmentDoc | null = null;
  if (params.packageId) {
    ship = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(params.packageId));
  }
  if (!ship && params.taskId) {
    const found = await db.find<ShipmentDoc>(COLLECTIONS.SHIPMENTS, (s) => s.kuaidi100TaskId === params.taskId);
    ship = found[0] ?? null;
  }
  if (!ship) {
    throw new AppError(ERROR_CODES.NOT_FOUND, "未找到对应的快递100发货单");
  }

  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, ship.packageId);
  if (!pkg) {
    throw new AppError(ERROR_CODES.NOT_FOUND, "未找到关联履约订单包");
  }

  if (params.state === "pickup_failed") {
    if (ship.status === "cancelled") {
      return {
        packageId: pkg._id,
        shipmentStatus: ship.status,
        packageStatus: pkg.status,
        retries: ship.pickupRetryCount,
        movedToManualHold: pkg.status === "manual_hold",
      };
    }

    const nextRetry = ship.pickupRetryCount + 1;
    if (nextRetry <= 2) {
      if (ship.status === "pickup_scheduled") {
        await transitionStatus(
          db,
          COLLECTIONS.SHIPMENTS,
          ship._id,
          SHIPMENT_STATUS_SPEC,
          "pickup_scheduled",
          "ready_to_ship",
          ship.version,
          () => ({ pickupRetryCount: nextRetry }),
          now,
        );
      } else {
        await db.atomicUpdate<ShipmentDoc>(
          COLLECTIONS.SHIPMENTS,
          ship._id,
          (cur) => cur.version === ship!.version,
          (cur) => ({ ...cur, pickupRetryCount: nextRetry, version: cur.version + 1, updatedAt: now }),
        );
      }
      if (params.logisticsPort) {
        const reSched = await scheduleMpPickupForShipment(db, pkg._id, params.logisticsPort, now);
        const latestShip = (await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, ship._id))!;
        const latestPkg = (await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkg._id))!;
        return {
          packageId: pkg._id,
          shipmentStatus: latestShip.status,
          packageStatus: latestPkg.status,
          retries: latestShip.pickupRetryCount,
          movedToManualHold: Boolean(reSched.movedToManualHold),
        };
      }
      const latestShip = (await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, ship._id))!;
      return {
        packageId: pkg._id,
        shipmentStatus: latestShip.status,
        packageStatus: pkg.status,
        retries: nextRetry,
        movedToManualHold: false,
      };
    }

    // Retries exhausted (nextRetry > 2) -> cancel shipment & move package to manual_hold
    if (ship.status === "pickup_scheduled" || ship.status === "ready_to_ship") {
      await transitionStatus(
        db,
        COLLECTIONS.SHIPMENTS,
        ship._id,
        SHIPMENT_STATUS_SPEC,
        ship.status,
        "cancelled",
        ship.version,
        () => ({ pickupRetryCount: nextRetry, kuaidi100TaskId: undefined }),
        now,
      );
    }
    let movedHold = false;
    if (pkg.status === "ready_to_ship") {
      const pTr = await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "ready_to_ship",
        "manual_hold",
        pkg.version,
        undefined,
        now,
      );
      movedHold = pTr.moved;
    }
    const latestShip = (await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, ship._id))!;
    const latestPkg = (await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkg._id))!;
    return {
      packageId: pkg._id,
      shipmentStatus: latestShip.status,
      packageStatus: latestPkg.status,
      retries: nextRetry,
      movedToManualHold: movedHold,
    };
  }

  if (params.state === "picked_up") {
    if (ship.status === "cancelled" || ship.status === "signed" || ship.status === "lost_or_damaged") {
      return {
        packageId: pkg._id,
        shipmentStatus: ship.status,
        packageStatus: pkg.status,
      };
    }

    const costFen =
      params.shippingCostFen !== undefined ? asNonNegativeFen(params.shippingCostFen) : ship.shippingCostFen;

    let shipMoved = false;
    if (ship.status === "ready_to_ship" || ship.status === "pickup_scheduled") {
      const sTr = await transitionStatus(
        db,
        COLLECTIONS.SHIPMENTS,
        ship._id,
        SHIPMENT_STATUS_SPEC,
        ship.status,
        "in_transit",
        ship.version,
        () => ({
          trackingNo: params.trackingNo ?? ship!.trackingNo,
          carrierCode: params.carrierCode ?? ship!.carrierCode,
          shippingCostFen: costFen,
        }),
        now,
      );
      shipMoved = sTr.moved;
    }

    let pkgMoved = false;
    if (shipMoved && pkg.status === "ready_to_ship") {
      const pTr = await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "ready_to_ship",
        "shipped",
        pkg.version,
        () => ({ shippedAt: now }),
        now,
      );
      pkgMoved = pTr.moved;
      if (pTr.moved) {
        await updateWeaverSpeedFactorOnShipped(db, pkg, now);
      }
    }

    if (pkgMoved && costFen && costFen > 0) {
      await postLedgerEntry(db, {
        _id: ledgerKeyShipFee(pkg._id),
        eventType: "ship_fee",
        bizId: pkg._id,
        lines: [
          { accountCode: LEDGER_ACCOUNT_CODES.EXP_SHIPPING_PLATFORM, debitFen: costFen, creditFen: ZERO_FEN },
          { accountCode: LEDGER_ACCOUNT_CODES.ASSET_KD100_PREPAID, debitFen: ZERO_FEN, creditFen: costFen },
        ],
        memo: `小程序包裹 ${pkg._id} 快递100取件运费扣减预充`,
        createdAt: now,
      });
    }

    const latestShip = (await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, ship._id))!;
    const latestPkg = (await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkg._id))!;
    return {
      packageId: pkg._id,
      shipmentStatus: latestShip.status,
      packageStatus: latestPkg.status,
    };
  }

  if (params.state === "signed") {
    if (ship.status === "cancelled" || ship.status === "lost_or_damaged") {
      return {
        packageId: pkg._id,
        shipmentStatus: ship.status,
        packageStatus: pkg.status,
      };
    }

    let curShip = ship;
    if (curShip.status === "ready_to_ship" || curShip.status === "pickup_scheduled") {
      const sTr1 = await transitionStatus(
        db,
        COLLECTIONS.SHIPMENTS,
        curShip._id,
        SHIPMENT_STATUS_SPEC,
        curShip.status,
        "in_transit",
        curShip.version,
        () => ({
          trackingNo: params.trackingNo ?? curShip.trackingNo,
          carrierCode: params.carrierCode ?? curShip.carrierCode,
        }),
        now,
      );
      if (sTr1.doc) curShip = sTr1.doc;
    }
    let shipSignedMoved = false;
    if (curShip.status === "in_transit") {
      const sTr2 = await transitionStatus(
        db,
        COLLECTIONS.SHIPMENTS,
        curShip._id,
        SHIPMENT_STATUS_SPEC,
        "in_transit",
        "signed",
        curShip.version,
        () => ({ trackingNo: params.trackingNo ?? curShip.trackingNo }),
        now,
      );
      shipSignedMoved = sTr2.moved;
    }

    let curPkg = pkg;
    if (shipSignedMoved && curPkg.status === "ready_to_ship") {
      const pTr1 = await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        curPkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "ready_to_ship",
        "shipped",
        curPkg.version,
        () => ({ shippedAt: now }),
        now,
      );
      if (pTr1.moved) {
        await updateWeaverSpeedFactorOnShipped(db, curPkg, now);
      }
      if (pTr1.doc) curPkg = pTr1.doc;
    }
    let pkgSignedMoved = false;
    if (curPkg.status === "shipped") {
      const pTr2 = await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        curPkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "shipped",
        "signed",
        curPkg.version,
        () => ({ signedAt: now, settleEligibleAt: now + 7 * DAY_MS }),
        now,
      );
      pkgSignedMoved = pTr2.moved;
    }

    if (pkgSignedMoved) {
      for (const ordId of curPkg.orderIds) {
        await db.atomicUpdate<OrderDoc>(
          COLLECTIONS.ORDERS,
          ordId,
          (o) => o.status === "paid",
          (o) => ({ ...o, status: "fulfilled", updatedAt: now }),
        );
      }
    }

    const latestShip = (await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, ship._id))!;
    const latestPkg = (await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkg._id))!;
    return {
      packageId: pkg._id,
      shipmentStatus: latestShip.status,
      packageStatus: latestPkg.status,
    };
  }

  if (params.state === "lost") {
    if (ship.status === "in_transit") {
      await transitionStatus(
        db,
        COLLECTIONS.SHIPMENTS,
        ship._id,
        SHIPMENT_STATUS_SPEC,
        "in_transit",
        "lost_or_damaged",
        ship.version,
        undefined,
        now,
      );
    }
    const latestShip = (await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, ship._id))!;
    const latestPkg = (await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkg._id))!;
    return {
      packageId: pkg._id,
      shipmentStatus: latestShip.status,
      packageStatus: latestPkg.status,
    };
  }

  // Intermediate carrier trajectory push (e.g., "in_transit", "delivering") -> harmless metadata refresh only
  if (params.trackingNo && ship.status !== "cancelled" && !ship.trackingNo) {
    await db.atomicUpdate<ShipmentDoc>(
      COLLECTIONS.SHIPMENTS,
      ship._id,
      (cur) => cur.version === ship!.version,
      (cur) => ({ ...cur, trackingNo: params.trackingNo, updatedAt: now }),
    );
  }
  return {
    packageId: pkg._id,
    shipmentStatus: ship.status,
    packageStatus: pkg.status,
  };
}

/**
 * 5-minute watchdog sweep for MP shipments stranded in `ready_to_ship` without a scheduled Kuaidi100 task
 * (e.g., transient Kuaidi100 HTTP timeout during weaver seal). Retries <= 2 times then escalates to `manual_hold`.
 */
export async function sweepUnscheduledMpPickups(
  db: DbAdapter,
  logisticsPort: LogisticsPort,
  nowUtcMs: number = Date.now(),
): Promise<{ retriedCount: number; scheduledCount: number; escalatedToManualHold: number }> {
  const pendingShips = await db.find<ShipmentDoc>(
    COLLECTIONS.SHIPMENTS,
    (s) => s.fulfillMode === "kuaidi100_pickup" && s.status === "ready_to_ship" && !s.kuaidi100TaskId,
  );
  let retriedCount = 0;
  let scheduledCount = 0;
  let escalatedToManualHold = 0;
  for (const s of pendingShips) {
    const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, s.packageId);
    if (!pkg || pkg.status !== "ready_to_ship") continue;
    retriedCount++;
    const res = await scheduleMpPickupForShipment(db, s.packageId, logisticsPort, nowUtcMs);
    if (res.scheduled) scheduledCount++;
    if (res.movedToManualHold) escalatedToManualHold++;
  }
  return { retriedCount, scheduledCount, escalatedToManualHold };
}

/**
 * Daily 02:00 sweep: transitions packages signed >= 7 days ago to `settled_ready`
 * and posts separated craft labor + BOM material ledger entries.
 */
export async function sweepSettleEligiblePackages(
  db: DbAdapter,
  nowUtcMs: number = Date.now(),
): Promise<{ settledReadyCount: number }> {
  const due = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) => p.status === "signed" && p.settleEligibleAt !== undefined && nowUtcMs >= p.settleEligibleAt,
  );

  let settledReadyCount = 0;
  for (const pkg of due) {
    if (!pkg.assignedWeaverId) continue;
    const tr = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "signed",
      "settled_ready",
      pkg.version,
      undefined,
      nowUtcMs,
    );
    if (!tr.moved) continue;

    let craftTotal = ZERO_FEN;
    let yarnAccrualTotal = ZERO_FEN;
    let shipShare = ZERO_FEN;
    for (const item of pkg.itemsSnapshot) {
      for (let q = 0; q < item.qty; q++) {
        craftTotal = addFen(craftTotal, item.craftFeeFen);
        yarnAccrualTotal = addFen(yarnAccrualTotal, item.yarnPoolAccrualFen);
      }
      if (item.weaverShipShareFen > shipShare) shipShare = item.weaverShipShareFen;
    }

    // If township weaver self-shipped at station, waive weaverShipShareFen and pass standard reimbursement separately (EXP_SHIPPING_PLATFORM)
    const shipDoc = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(pkg._id));
    let selfShipReimb = ZERO_FEN;
    if (shipDoc?.fulfillMode === "weaver_self_ship") {
      shipShare = ZERO_FEN;
      if (shipDoc.selfShipReimbFen) {
        selfShipReimb = shipDoc.selfShipReimbFen;
      }
    }

    await accrueSettledPackage(db, {
      packageId: pkg._id,
      weaverId: pkg.assignedWeaverId,
      craftFeeFen: craftTotal,
      weaverShipShareFen: shipShare,
      yarnPoolAccrualFen: yarnAccrualTotal,
      selfShipReimbFen: selfShipReimb,
      nowUtcMs,
    });
    settledReadyCount++;
  }
  return { settledReadyCount };
}
