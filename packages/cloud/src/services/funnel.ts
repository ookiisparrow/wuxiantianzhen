import { COLLECTIONS } from "../../../shared/src/collections.ts";
import { DAY_MS } from "../../../shared/src/cst.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";
import { WEAVER_DEPOSIT_FEN } from "../../../shared/src/money.ts";
import { RECRUIT_FUNNEL_SPEC, canTransition } from "../../../shared/src/status.ts";
import type {
  DepositChannel,
  RecruitFunnelDoc,
  RegionCode,
  ShippingMode,
  UserDoc,
} from "../../../shared/src/schemas.ts";
import type { DbAdapter } from "../kit/db.ts";
import { recruitFunnelId } from "../kit/ids.ts";
import { recordWeaverDeposit } from "../kit/ledger.ts";
import { createBase12Inventory } from "../kit/yarnInventory.ts";
import { inferRegionFromProvince } from "./dispatch.ts";

/**
 * Finalized 4-step weaver onboarding funnel (docs/07 §4.2, Round 9 Q5):
 *   Step 1 (`apply_entry`): active region check (e.g. ['jzh']) + 8-question quiz + 3 portfolio photos (<=2 tries)
 *   Step 2 (`trial_make`): acknowledge 200-Yuan deposit notice + non-commercial exam sample photo review (<=2 tries)
 *   Step 3 (`sample_inspect`): self-paid physical sample inspection (<=1 retry, no shipping reimbursement)
 *   Step 4 (`pending_deposit` -> `approved`): pay 200-Yuan cooperative deposit -> initialize pool='mp' & base-12 yarns
 */
export async function submitFunnelEntryStep1(
  db: DbAdapter,
  params: {
    userId: string;
    province: string;
    city: string;
    activeRecruitRegions: readonly RegionCode[]; // default ['jzh'] in Stage 1
    quizCorrectCount: number; // out of 8, pass >= 7
    portfolioPhotoFileIds: string[];
    nowUtcMs?: number;
  },
): Promise<{ passedQuizAndRegion: boolean; stage: RecruitFunnelDoc["stage"]; reason?: string }> {
  const now = params.nowUtcMs ?? Date.now();
  const fId = recruitFunnelId(params.userId);
  const existing = await db.get<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, fId);

  if (existing?.stage === "rejected" && existing.cooldownUntil && now < existing.cooldownUntil) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "当前处于 30 天冷却期内，期满后可重新申请");
  }
  if (params.portfolioPhotoFileIds.length < 3) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "请至少上传 3 张历史钩织作品照");
  }

  const region = inferRegionFromProvince(params.province);
  const regionOk = params.activeRecruitRegions.includes(region);

  const prevAttempts = existing && existing.stage !== "rejected" ? existing.quizAttempts : 0;
  const nextAttempts = prevAttempts + 1;
  const quizOk = params.quizCorrectCount >= 7;

  if (!regionOk) {
    const rejDoc: RecruitFunnelDoc = {
      _id: fId,
      userId: params.userId,
      stage: "rejected",
      regionCheckPassed: false,
      quizAttempts: nextAttempts,
      portfolioAttempts: existing?.portfolioAttempts ?? 0,
      trialAttempts: 0,
      sampleAttempts: 0,
      depositStatus: "unpaid",
      depositAmountFen: WEAVER_DEPOSIT_FEN,
      cooldownUntil: now + 30 * DAY_MS,
      version: (existing?.version ?? 0) + 1,
      updatedAt: now,
    };
    await db.put(COLLECTIONS.RECRUIT_FUNNEL, rejDoc);
    return { passedQuizAndRegion: false, stage: "rejected", reason: `当前批次暂未开放 ${region} 大区招募` };
  }

  if (!quizOk) {
    const exceeded = nextAttempts > 2;
    const doc: RecruitFunnelDoc = {
      _id: fId,
      userId: params.userId,
      stage: exceeded ? "rejected" : "apply_entry",
      regionCheckPassed: true,
      quizAttempts: nextAttempts,
      portfolioAttempts: existing?.portfolioAttempts ?? 0,
      trialAttempts: 0,
      sampleAttempts: 0,
      depositStatus: "unpaid",
      depositAmountFen: WEAVER_DEPOSIT_FEN,
      cooldownUntil: exceeded ? now + 30 * DAY_MS : undefined,
      version: (existing?.version ?? 0) + 1,
      updatedAt: now,
    };
    await db.put(COLLECTIONS.RECRUIT_FUNNEL, doc);
    return {
      passedQuizAndRegion: false,
      stage: doc.stage,
      reason: exceeded ? "基础常识测验超过 2 次未通过，进入 30 天冷却期" : "基础常识测验未达标，请重答",
    };
  }

  // Save region & city onto user doc, enter apply_entry awaiting portfolio review
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    params.userId,
    () => true,
    (u) => ({
      ...u,
      regionCode: region,
      cityQuotaKey: `${params.province.trim()}-${params.city.trim()}`,
      funnelStage: "apply_entry",
      updatedAt: now,
    }),
  );

  const doc: RecruitFunnelDoc = {
    _id: fId,
    userId: params.userId,
    stage: "apply_entry",
    regionCheckPassed: true,
    quizAttempts: nextAttempts,
    portfolioAttempts: (existing?.portfolioAttempts ?? 0) + 1,
    trialAttempts: 0,
    sampleAttempts: 0,
    depositStatus: "unpaid",
    depositAmountFen: WEAVER_DEPOSIT_FEN,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now,
  };
  await db.put(COLLECTIONS.RECRUIT_FUNNEL, doc);
  return { passedQuizAndRegion: true, stage: "apply_entry" };
}

/**
 * Portfolio review passed + weaver acknowledges 200-Yuan deposit notice -> unlocks Step 2 non-commercial exam sample!
 */
export async function passPortfolioAndUnlockExamSample(
  db: DbAdapter,
  params: {
    userId: string;
    ackDepositNotice: boolean;
    examSampleCode?: string; // e.g. "EXAM-MINI-MUSHROOM-01" (non-commercial!)
    nowUtcMs?: number;
  },
): Promise<RecruitFunnelDoc> {
  if (!params.ackDepositNotice) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "需确认知晓：指定考级作品考察通过后须缴付 200 元合作履约保证金方可正式接单",
    );
  }
  const now = params.nowUtcMs ?? Date.now();
  const fId = recruitFunnelId(params.userId);
  const cur = await db.get<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, fId);
  if (!cur || !canTransition(RECRUIT_FUNNEL_SPEC, cur.stage, "trial_make")) {
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, "当前漏斗阶段不可解锁考级小样");
  }

  const next: RecruitFunnelDoc = {
    ...cur,
    stage: "trial_make",
    depositNoticeAckAt: now,
    examSampleCode: params.examSampleCode ?? "EXAM-SAMPLE-NON-SALE-01",
    version: cur.version + 1,
    updatedAt: now,
  };
  await db.put(COLLECTIONS.RECRUIT_FUNNEL, next);
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    params.userId,
    () => true,
    (u) => ({ ...u, funnelStage: "trial_make", updatedAt: now }),
  );
  return next;
}

export async function passTrialPhotosToSampleInspect(
  db: DbAdapter,
  userId: string,
  nowUtcMs: number = Date.now(),
): Promise<RecruitFunnelDoc> {
  const fId = recruitFunnelId(userId);
  const cur = await db.get<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, fId);
  if (!cur || !canTransition(RECRUIT_FUNNEL_SPEC, cur.stage, "sample_inspect")) {
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, "当前阶段不可进入实物寄验");
  }
  const next: RecruitFunnelDoc = {
    ...cur,
    stage: "sample_inspect",
    trialPassedAt: nowUtcMs,
    version: cur.version + 1,
    updatedAt: nowUtcMs,
  };
  await db.put(COLLECTIONS.RECRUIT_FUNNEL, next);
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    userId,
    () => true,
    (u) => ({ ...u, funnelStage: "sample_inspect", updatedAt: nowUtcMs }),
  );
  return next;
}

/**
 * Step 3 physical sample inspection (self-paid shipping, max 1 re-shipment on failure).
 */
export async function recordPhysicalSampleInspection(
  db: DbAdapter,
  params: {
    userId: string;
    trackingNo: string;
    passed: boolean;
    shippingModeConfirmed?: ShippingMode;
    nowUtcMs?: number;
  },
): Promise<RecruitFunnelDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const fId = recruitFunnelId(params.userId);
  const cur = await db.get<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, fId);
  if (!cur || cur.stage !== "sample_inspect") {
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, "当前不在实物样品验收阶段");
  }

  const attempts = cur.sampleAttempts + 1;
  let nextStage: RecruitFunnelDoc["stage"] = "sample_inspect";
  let cooldownUntil: number | undefined;

  if (params.passed) {
    nextStage = "pending_deposit";
  } else if (attempts >= 2) {
    // Initial + 1 retry exhausted -> rejected with 30-day cooldown
    nextStage = "rejected";
    cooldownUntil = now + 30 * DAY_MS;
  }

  const next: RecruitFunnelDoc = {
    ...cur,
    stage: nextStage,
    sampleAttempts: attempts,
    sampleTrackingNo: params.trackingNo,
    sampleReceivedAt: now,
    sampleInspectResult: params.passed ? "pass" : "fail",
    cooldownUntil,
    version: cur.version + 1,
    updatedAt: now,
  };
  await db.put(COLLECTIONS.RECRUIT_FUNNEL, next);

  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    params.userId,
    () => true,
    (u) => ({
      ...u,
      funnelStage: nextStage,
      shippingMode: params.shippingModeConfirmed ?? u.shippingMode ?? "auto_pickup",
      updatedAt: now,
    }),
  );
  return next;
}

/**
 * Step 4: Weaver pays 200-Yuan cooperative performance deposit -> transitions `pending_deposit -> approved`,
 * assigns `pool = 'mp'`, sets `weaverNo`, and initializes 12 base colors (`wholeSkeins = 1`).
 */
export async function completeDepositAndApproveWeaver(
  db: DbAdapter,
  params: {
    userId: string;
    weaverNo: string;
    dailyCapacityMin: number;
    base12Codes: readonly string[];
    depositChannel: DepositChannel;
    depositRefId: string;
    nowUtcMs?: number;
  },
): Promise<UserDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const fId = recruitFunnelId(params.userId);
  const cur = await db.get<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, fId);
  if (!cur || cur.stage !== "pending_deposit") {
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, "需先通过实物验收进入待缴保证金阶段");
  }

  await recordWeaverDeposit(db, params.userId, undefined, now);

  await db.put<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, {
    ...cur,
    stage: "approved",
    depositStatus: "paid",
    depositChannel: params.depositChannel,
    depositPaidAt: now,
    depositRefId: params.depositRefId,
    version: cur.version + 1,
    updatedAt: now,
  });

  const baseInv = createBase12Inventory(params.base12Codes);
  const upd = await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    params.userId,
    () => true,
    (u) => ({
      ...u,
      roles: u.roles.includes("weaver") ? u.roles : [...u.roles, "weaver"],
      weaverNo: params.weaverNo,
      pool: u.pool ?? "mp",
      shippingMode: u.shippingMode ?? "auto_pickup",
      funnelStage: "approved",
      acceptingOrders: true,
      dailyCapacityMin: params.dailyCapacityMin,
      yarnInventory: { ...baseInv, ...u.yarnInventory },
      updatedAt: now,
    }),
  );

  if (!upd.doc) throw new AppError(ERROR_CODES.NOT_FOUND, "User not found");
  return upd.doc;
}
