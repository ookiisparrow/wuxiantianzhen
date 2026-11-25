import { COLLECTIONS } from "../../../shared/src/collections.ts";
import { HOUR_MS } from "../../../shared/src/cst.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";
import { ZERO_FEN, addFen, type Fen } from "../../../shared/src/money.ts";
import {
  BAG_STICKER_STATUS_SPEC,
  ORDER_PACKAGE_STATUS_SPEC,
  PHOTO_REVIEW_STATUS_SPEC,
} from "../../../shared/src/status.ts";
import type {
  BagStickerDoc,
  OrderPackageDoc,
  PhotoReviewDoc,
  ShipmentDoc,
  StyleDoc,
  UserDoc,
  VolunteerDoc,
  VolunteerVoteDoc,
} from "../../../shared/src/schemas.ts";
import type { DbAdapter } from "../kit/db.ts";
import { bagStickerId, newReviewId, shipmentId, volunteerId, volunteerVoteId } from "../kit/ids.ts";
import { accrueSettledPackage } from "../kit/ledger.ts";
import { transitionStatus } from "../kit/transition.ts";
import { compactWeaverQueue } from "./dispatch.ts";

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
    await createReadyShipment(db, pkg, params.weaverId, params.sealedPhotoFileId, params.pickupWindow, now);

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
    if (tr.moved) {
      await compactWeaverQueue(db, params.weaverId, now);
    }
    return { nextStatus: "ready_to_ship" };
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
  if (rev.weaverId === params.volunteerUserId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Cannot review own work");
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

  // Update volunteer points & avoidance window
  await db.atomicUpdate<VolunteerDoc>(
    COLLECTIONS.VOLUNTEERS,
    vol._id,
    () => true,
    (v) => ({
      ...v,
      points: v.points + 2,
      recentWeaverIds: [...v.recentWeaverIds.slice(-9), rev.weaverId],
    }),
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
    const allHigh = votes.length >= 2 && votes.every((v) => v.score >= 4);

    if (allHigh) {
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

  const targetPkgStatus: OrderPackageDoc["status"] =
    shipDoc.fulfillMode === "weaver_self_ship" && params.selfDropoffTrackingNo ? "shipped" : "ready_to_ship";

  if (targetPkgStatus === "shipped") {
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
      await transitionStatus(
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
    }
  } else {
    await transitionStatus(
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
  }

  await compactWeaverQueue(db, params.weaverId, now);
  return { status: targetPkgStatus };
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

  const doc: ShipmentDoc = {
    _id: shipmentId(pkg._id),
    packageId: pkg._id,
    fulfillMode,
    pickupWindow,
    sealedPhotoFileId,
    doudianAddressAlias: weaver?.doudianAddressAlias,
    senderAddrId: weaver?.defaultSendAddrId,
    trackingNo: selfDropoffTrackingNo,
    selfShipReimbFen: fulfillMode === "weaver_self_ship" ? standardSelfShipReimbFen : undefined,
    pickupRetryCount: 0,
    status: selfDropoffTrackingNo ? "in_transit" : "ready_to_ship",
    updatedAt: nowUtcMs,
  };
  await db.put(COLLECTIONS.SHIPMENTS, doc);
  return doc;
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

    // If township weaver self-shipped at station, waive weaverShipShareFen and add standard reimbursement
    const shipDoc = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(pkg._id));
    if (shipDoc?.fulfillMode === "weaver_self_ship") {
      shipShare = ZERO_FEN;
      if (shipDoc.selfShipReimbFen) {
        craftTotal = addFen(craftTotal, shipDoc.selfShipReimbFen);
      }
    }

    await accrueSettledPackage(db, {
      packageId: pkg._id,
      weaverId: pkg.assignedWeaverId,
      craftFeeFen: craftTotal,
      weaverShipShareFen: shipShare,
      yarnPoolAccrualFen: yarnAccrualTotal,
      nowUtcMs,
    });
    settledReadyCount++;
  }
  return { settledReadyCount };
}
