import {
  AppError,
  COLLECTIONS,
  ERROR_CODES,
  asFen,
  computeSafeLiveStockPlan,
  type OrderPackageDoc,
  type PhotoReviewDoc,
  type ProductDoc,
  type RecruitFunnelDoc,
  type StyleDoc,
  type UserDoc,
  type WeaverAccountDoc,
  type WeaverStockDoc,
  type YarnCatalogDoc,
  type YarnClaimDoc,
} from "@wxtz/shared";
import { loginOrMergeUser, type MiniProgramApp } from "../kit/auth.ts";
import type { DbAdapter } from "../kit/db.ts";
import { weaverAccountId } from "../kit/ids.ts";
import { reconcileWeaverAccount } from "../kit/ledger.ts";
import { releaseExpiredReservations } from "../kit/stockLock.ts";
import { confirmWeaverSkeinCheck } from "../kit/yarnInventory.ts";
import type { ExternalPorts } from "../ports/index.ts";
import {
  checkProductSellability,
  createMpBuyerOrder,
  handleWxPaySuccessWebhook,
  requestMpBuyerRefund,
  resolvePendingRefundByAdmin,
} from "../services/buyerMall.ts";
import {
  dispatchPoolTick,
  getHeadPatternForWeaver,
  releaseMakingOrderVoluntarily,
  respondDispatchOffer,
  sweepOffersAndStalledPackages,
} from "../services/dispatch.ts";
import { commitDouyinImport, previewDouyinImport } from "../services/douyinCsv.ts";
import {
  activateFanVolunteerAfterExam,
  adminArbitratePhotoReview,
  castVolunteerVote,
  getBlindReviewCardForVolunteer,
  sealAndSubmitShipment,
  submitFinishedWork,
  sweepPhotoReviewSla,
  sweepSettleEligiblePackages,
} from "../services/fulfillment.ts";
import {
  completeDepositAndApproveWeaver,
  passPortfolioAndUnlockExamSample,
  passTrialPhotosToSampleInspect,
  recordPhysicalSampleInspection,
  submitFunnelEntryStep1,
} from "../services/funnel.ts";
import {
  confirmSettlementBatchPaid,
  confirmYarnClaimReceived,
  createSettlementBatchAndExportBankCsv,
  exportSupplierCsvAndMarkDispatched,
  submitWeeklyYarnClaim,
} from "../services/supplyAndPayout.ts";
import { recordAdminAudit, verifyAdminJwt } from "./adminJwt.ts";

export interface CloudRequestContext {
  db: DbAdapter;
  ports: ExternalPorts;
  app?: MiniProgramApp;
  openid?: string;
  adminJwtSecret: string;
  adminToken?: string;
  nowUtcMs?: number;
}

export type ApiResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

async function requireMiniProgramUser(ctx: CloudRequestContext): Promise<UserDoc> {
  if (!ctx.openid || !ctx.app) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "请在微信小程序内打开");
  }
  const field = ctx.app === "mp-buyer" ? "buyerOpenid" : "weaverOpenid";
  const found = await ctx.db.find<UserDoc>(COLLECTIONS.USERS, (u) => u[field] === ctx.openid);
  if (!found[0]) {
    throw new AppError(ERROR_CODES.PHONE_REQUIRED, "请先完成手机号绑定登录");
  }
  return found[0];
}

/**
 * Unified CloudBase entrypoint router dispatching actions across all 8 domains
 * (`auth.*`, `weaver.*`, `volunteer.*`, `buyer.*`, `admin.*`, `webhook.*`, `cron.*`).
 */
export async function dispatchCloudAction(
  ctx: CloudRequestContext,
  action: string,
  payload: Record<string, any> = {},
): Promise<ApiResponse> {
  const now = ctx.nowUtcMs ?? Date.now();
  try {
    switch (action) {
      // ---------------- AUTH ----------------
      case "auth.login": {
        if (!ctx.app || !ctx.openid) {
          throw new AppError(ERROR_CODES.FORBIDDEN, "Missing MiniProgram context");
        }
        const res = await loginOrMergeUser(ctx.db, {
          app: ctx.app,
          openid: ctx.openid,
          phone: payload.phone,
          unionid: payload.unionid,
          nickname: payload.nickname,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }

      // ---------------- WEAVER (mp-weaver) ----------------
      case "weaver.dashboard": {
        const u = await requireMiniProgramUser(ctx);
        const [account, packages, yarnClaims] = await Promise.all([
          ctx.db.get<WeaverAccountDoc>(COLLECTIONS.WEAVER_ACCOUNTS, weaverAccountId(u._id)),
          ctx.db.find<OrderPackageDoc>(
            COLLECTIONS.ORDER_PACKAGES,
            (p) =>
              p.assignedWeaverId === u._id &&
              ["offered", "making", "photo_review", "awaiting_seal", "ready_to_ship"].includes(p.status),
          ),
          ctx.db.find<YarnClaimDoc>(COLLECTIONS.YARN_CLAIMS, (c) => c.weaverId === u._id),
        ]);
        packages.sort((a, b) => (a.queueSeq ?? 999) - (b.queueSeq ?? 999));
        return { ok: true, data: { user: u, account, packages, yarnClaims } };
      }
      case "weaver.respondOffer": {
        const u = await requireMiniProgramUser(ctx);
        const res = await respondDispatchOffer(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          action: payload.decision === "accept" ? "accept" : "reject",
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.getHeadPattern": {
        const u = await requireMiniProgramUser(ctx);
        const res = await getHeadPatternForWeaver(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.releaseOrder": {
        const u = await requireMiniProgramUser(ctx);
        const res = await releaseMakingOrderVoluntarily(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.submitFinishedWork": {
        const u = await requireMiniProgramUser(ctx);
        // Trigger mandatory WeChat UGC image security check via hexagonal port!
        for (const fid of Object.values(payload.photoSlots ?? {}) as string[]) {
          if (fid) {
            await ctx.ports.contentSec.submitImageCheckAsync({
              openid: ctx.openid ?? "",
              mediaUrl: fid,
              scene: 2,
            });
          }
        }
        const res = await submitFinishedWork(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          photoSlots: payload.photoSlots,
          imageHashes: payload.imageHashes ?? [],
          bagStickerCode: payload.bagStickerCode,
          sealedPhotoFileId: payload.sealedPhotoFileId,
          pickupWindow: payload.pickupWindow,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.sealAndSubmit": {
        const u = await requireMiniProgramUser(ctx);
        const res = await sealAndSubmitShipment(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          bagStickerCode: String(payload.bagStickerCode),
          sealedPhotoFileId: String(payload.sealedPhotoFileId),
          pickupWindow: payload.pickupWindow,
          selfDropoffTrackingNo: payload.selfDropoffTrackingNo,
          standardSelfShipReimbFen: payload.standardSelfShipReimbFen
            ? asFen(Number(payload.standardSelfShipReimbFen))
            : undefined,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.confirmSkeinCheck": {
        const u = await requireMiniProgramUser(ctx);
        const res = await confirmWeaverSkeinCheck(
          ctx.db,
          u._id,
          String(payload.yarnCode),
          Number(payload.reportedWholeSkeins),
          50,
          1,
          now,
        );
        return { ok: true, data: res };
      }
      case "weaver.submitYarnClaim": {
        const u = await requireMiniProgramUser(ctx);
        const res = await submitWeeklyYarnClaim(ctx.db, {
          weaverId: u._id,
          sendAddrId: String(payload.sendAddrId),
          items: payload.items ?? [],
          shippingFeeFen: asFen(Number(payload.shippingFeeFen ?? 250)),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.confirmYarnReceived": {
        const u = await requireMiniProgramUser(ctx);
        const res = await confirmYarnClaimReceived(ctx.db, {
          claimId: String(payload.claimId),
          weaverId: u._id,
          confirmPhotoFileId: payload.confirmPhotoFileId,
          nowUtcMs: now,
        });
        return { ok: true, data: { yarnInventory: res.yarnInventory } };
      }
      case "weaver.funnelStep1": {
        const u = await requireMiniProgramUser(ctx);
        const res = await submitFunnelEntryStep1(ctx.db, {
          userId: u._id,
          province: String(payload.province),
          city: String(payload.city),
          activeRecruitRegions: payload.activeRecruitRegions ?? ["jzh"],
          quizCorrectCount: Number(payload.quizCorrectCount),
          portfolioPhotoFileIds: payload.portfolioPhotoFileIds ?? [],
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.funnelAckDeposit": {
        const u = await requireMiniProgramUser(ctx);
        const res = await passPortfolioAndUnlockExamSample(ctx.db, {
          userId: u._id,
          ackDepositNotice: Boolean(payload.ackDepositNotice),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }

      // ---------------- VOLUNTEER (mp-buyer role entry) ----------------
      case "volunteer.passExam": {
        const u = await requireMiniProgramUser(ctx);
        const res = await activateFanVolunteerAfterExam(ctx.db, {
          userId: u._id,
          correctCount: Number(payload.correctCount),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "volunteer.getCard": {
        const u = await requireMiniProgramUser(ctx);
        const card = await getBlindReviewCardForVolunteer(ctx.db, String(payload.reviewId), u._id);
        return { ok: true, data: card };
      }
      case "volunteer.vote": {
        const u = await requireMiniProgramUser(ctx);
        const res = await castVolunteerVote(ctx.db, {
          reviewId: String(payload.reviewId),
          volunteerUserId: u._id,
          score: Number(payload.score),
          tags: payload.tags,
          dwellMs: Number(payload.dwellMs),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }

      // ---------------- BUYER (mp-buyer) ----------------
      case "buyer.listCatalog": {
        const [products, stocks] = await Promise.all([
          ctx.db.find<ProductDoc>(COLLECTIONS.PRODUCTS, (p) => p.status === "on_sale"),
          ctx.db.find<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, (s) => s.availableQty > 0),
        ]);
        const readyStockBySku: Record<string, number> = {};
        for (const s of stocks) {
          readyStockBySku[s.skuCode] = (readyStockBySku[s.skuCode] ?? 0) + s.availableQty;
        }
        return { ok: true, data: { products, readyStockBySku } };
      }
      case "buyer.payWeaverDeposit": {
        const u = await requireMiniProgramUser(ctx);
        const depositAmountFen = asFen(20000); // 200.00 RMB cooperative performance deposit (LIAB_WEAVER_DEPOSIT)
        const outTradeNo = `DEP_${u._id}_${now}`;
        const prepay = await ctx.ports.payment.createJsapiPrepay({
          mchId: String(payload.mchId ?? "MCH_DEFAULT"),
          outTradeNo,
          buyerOpenid: ctx.openid!,
          amountFen: depositAmountFen,
          description: "无限天真·织女履约合作保证金(可全额退)",
        });
        return { ok: true, data: { userId: u._id, outTradeNo, amountFen: depositAmountFen, prepay } };
      }
      case "buyer.checkSellability": {
        const u = ctx.openid && ctx.app ? await requireMiniProgramUser(ctx).catch(() => null) : null;
        const res = await checkProductSellability(ctx.db, {
          productId: String(payload.productId),
          buyerUserId: u?._id,
          qty: Number(payload.qty ?? 1),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "buyer.createOrder": {
        const u = await requireMiniProgramUser(ctx);
        const res = await createMpBuyerOrder(ctx.db, {
          buyerUserId: u._id,
          productId: String(payload.productId),
          receiverAddrId: String(payload.receiverAddrId),
          qty: Number(payload.qty ?? 1),
          referrerCreatorId: payload.referrerCreatorId,
          mchId: String(payload.mchId ?? "MCH_DEFAULT"),
          nowUtcMs: now,
        });
        const prepay = await ctx.ports.payment.createJsapiPrepay({
          mchId: res.payment.mchId,
          outTradeNo: res.payment.outTradeNo,
          buyerOpenid: ctx.openid!,
          amountFen: res.payment.amountFen,
          description: `无限天真手作·${res.order.skuCode}`,
        });
        return { ok: true, data: { ...res, prepay } };
      }
      case "buyer.requestRefund": {
        const u = await requireMiniProgramUser(ctx);
        const res = await requestMpBuyerRefund(ctx.db, {
          orderId: String(payload.orderId),
          buyerUserId: u._id,
          reason: String(payload.reason ?? ""),
          trigger: payload.trigger,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }

      // ---------------- ADMIN (Web Console, JWT Protected) ----------------
      case "admin.liveSafeStockPlan": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const styles = await ctx.db.find<StyleDoc>(COLLECTIONS.STYLES, (s) => s.status === "active");
        const yarns = await ctx.db.find<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, () => true);
        const yarnWeight = new Map(yarns.map((y) => [y._id, y.unitWeightG || 50]));
        const liveWeavers = await ctx.db.find<UserDoc>(
          COLLECTIONS.USERS,
          (u) => u.pool === "live" && u.funnelStage === "approved" && u.acceptingOrders,
        );
        const activePkgs = await ctx.db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) =>
          ["offered", "making", "photo_review"].includes(p.status),
        );
        const backlogMap = new Map<string, number>();
        for (const p of activePkgs) {
          if (p.assignedWeaverId) {
            backlogMap.set(p.assignedWeaverId, (backlogMap.get(p.assignedWeaverId) ?? 0) + p.totalMin);
          }
        }
        const stocks = await ctx.db.find<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, (s) => s.availableQty > 0);
        const stockBySku = new Map<string, number>();
        for (const s of stocks) {
          stockBySku.set(s.skuCode, (stockBySku.get(s.skuCode) ?? 0) + s.availableQty);
        }

        const weights: Record<string, number> = payload.shareWeights ?? {};
        const plan = computeSafeLiveStockPlan(
          liveWeavers.map((w) => ({
            userId: w._id,
            acceptingOrders: w.acceptingOrders,
            pauseUntil: w.pauseUntil,
            restDays: w.restDays,
            dailyCapacityMin: w.dailyCapacityMin,
            speedFactor: w.speedFactor,
            backlogMin: backlogMap.get(w._id) ?? 0,
            yarnInventory: w.yarnInventory,
          })),
          styles.map((st) => ({
            style: {
              skuCode: st._id,
              standardMin: st.standardMin,
              requiresEnrollment: st.requiresEnrollment,
              yarnBomConsumed: st.yarnBom.map((b) => ({
                yarnCode: b.yarnCode,
                consumedG: Math.ceil((b.netWeightG * (10000 + st.wasteRateBp)) / 10000),
                unitWeightG: yarnWeight.get(b.yarnCode) ?? 50,
              })),
            },
            shareWeight: weights[st._id] ?? Math.floor(100 / Math.max(1, styles.length)),
            availableReadyStock: stockBySku.get(st._id) ?? 0,
          })),
          { nowUtcMs: now, horizonDays: Number(payload.horizonDays ?? 5) },
        );
        return { ok: true, data: plan };
      }
      case "admin.previewDouyinCsv": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await previewDouyinImport(ctx.db, {
          orderRows: payload.orderRows ?? [],
          refundRows: payload.refundRows,
          confirmZeroRefundsToday: Boolean(payload.confirmZeroRefundsToday),
        });
        return { ok: true, data: res };
      }
      case "admin.commitDouyinCsv": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await commitDouyinImport(ctx.db, {
          orderRows: payload.orderRows ?? [],
          refundRows: payload.refundRows,
          confirmZeroRefundsToday: Boolean(payload.confirmZeroRefundsToday),
          dispatchableAtMs: Number(payload.dispatchableAtMs ?? now),
          nowUtcMs: now,
        });
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "commitDouyinCsv",
          summary: `导入抖店新包裹 ${res.createdPackages}，合并 ${res.mergedOrders}，拦退单 ${res.cancelledPreMake}`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.exportSupplierYarnCsv": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await exportSupplierCsvAndMarkDispatched(ctx.db, {
          weekKey: String(payload.weekKey),
          nowUtcMs: now,
        });
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "exportSupplierYarnCsv",
          targetId: res.exportBatchId,
          summary: `导出江浙沪主供应商线材单 ${res.exportedClaimCount} 笔并标为 dispatched`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.exportBankPayoutCsv": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await createSettlementBatchAndExportBankCsv(ctx.db, now);
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "exportBankPayoutCsv",
          targetId: res.batchId,
          summary: `生成14天网银批量结款单 ${res.payeeCount} 人，总额 ${res.totalAmountFen} 分`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.confirmBankPayoutPaid": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await confirmSettlementBatchPaid(ctx.db, String(payload.batchId), now);
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "confirmBankPayoutPaid",
          targetId: String(payload.batchId),
          summary: `确认结款批次汇出完成：${res.paidPayees} 人 / ${res.settledPackages} 包`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.resolveRefund": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await resolvePendingRefundByAdmin(ctx.db, {
          refundId: String(payload.refundId),
          adminUserId: adm.sub,
          approve: Boolean(payload.approve),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.funnelApproveDeposit": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await completeDepositAndApproveWeaver(ctx.db, {
          userId: String(payload.userId),
          weaverNo: String(payload.weaverNo),
          dailyCapacityMin: Number(payload.dailyCapacityMin ?? 240),
          base12Codes: payload.base12Codes ?? [],
          depositChannel: payload.depositChannel ?? "mp_buyer_cashier",
          depositRefId: String(payload.depositRefId),
          nowUtcMs: now,
        });
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "funnelApproveDeposit",
          targetId: res._id,
          summary: `确认 200 元保证金到账并正式开通织女 ${res.weaverNo}`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.promoteWeaverPool": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const pool = payload.pool === "live" ? "live" : "mp";
        const upd = await ctx.db.atomicUpdate<UserDoc>(
          COLLECTIONS.USERS,
          String(payload.userId),
          (u) => u.funnelStage === "approved",
          (u) => ({ ...u, pool, updatedAt: now }),
        );
        if (!upd.updated || !upd.doc) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, "织女尚未通过准入漏斗，不可切换排产池");
        }
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "promoteWeaverPool",
          targetId: upd.doc._id,
          summary: `切换织女 ${upd.doc.weaverNo ?? upd.doc._id} 至 ${pool} 排产池`,
          nowUtcMs: now,
        });
        return { ok: true, data: upd.doc };
      }
      case "admin.funnelSampleInspect": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await recordPhysicalSampleInspection(ctx.db, {
          userId: String(payload.userId),
          trackingNo: String(payload.trackingNo),
          passed: Boolean(payload.passed),
          shippingModeConfirmed: payload.shippingModeConfirmed,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.funnelPassTrialPhotos": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await passTrialPhotosToSampleInspect(ctx.db, String(payload.userId), now);
        return { ok: true, data: res };
      }
      case "admin.arbitratePhotoReview": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await adminArbitratePhotoReview(ctx.db, {
          reviewId: String(payload.reviewId),
          adminUserId: adm.sub,
          approve: Boolean(payload.approve),
          nowUtcMs: now,
        });
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "arbitratePhotoReview",
          targetId: String(payload.reviewId),
          summary: `10秒仲裁审照单 ${payload.reviewId} -> ${res.reviewStatus}`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.overview": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const [readyPkgs, holdPkgs, escalatedReviews, funnelCandidates] = await Promise.all([
          ctx.db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.status === "ready_to_ship"),
          ctx.db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.status === "manual_hold"),
          ctx.db.find<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, (r) => r.status === "needs_admin"),
          ctx.db.find<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, (f) =>
            ["sample_inspect", "pending_deposit"].includes(f.stage),
          ),
        ]);
        return {
          ok: true,
          data: {
            readyToShipCount: readyPkgs.length,
            readyPackages: readyPkgs,
            manualHoldPackages: holdPkgs,
            escalatedReviews,
            funnelCandidates,
          },
        };
      }

      // ---------------- WEBHOOKS ----------------
      case "webhook.wxpay": {
        const res = await handleWxPaySuccessWebhook(ctx.db, {
          orderId: String(payload.orderId),
          wxTransactionId: String(payload.wxTransactionId),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }

      // ---------------- CRON ----------------
      case "cron.dispatchTick": {
        const res = await dispatchPoolTick(ctx.db, { nowUtcMs: now });
        return { ok: true, data: res };
      }
      case "cron.fiveMinuteWatchdog": {
        const [offers, stock, sla] = await Promise.all([
          sweepOffersAndStalledPackages(ctx.db, now),
          releaseExpiredReservations(ctx.db, now),
          sweepPhotoReviewSla(ctx.db, now),
        ]);
        return { ok: true, data: { offers, stock, sla } };
      }
      case "cron.dailySettleAndReconcile": {
        const settle = await sweepSettleEligiblePackages(ctx.db, now);
        const weavers = await ctx.db.find<UserDoc>(COLLECTIONS.USERS, (u) => u.roles.includes("weaver"));
        const mismatches: string[] = [];
        for (const w of weavers) {
          const r = await reconcileWeaverAccount(ctx.db, w._id);
          if (!r.ok) mismatches.push(w._id);
        }
        return { ok: true, data: { ...settle, reconciledWeavers: weavers.length, mismatches } };
      }

      default:
        throw new AppError(ERROR_CODES.NOT_FOUND, `Unknown cloud action: ${action}`);
    }
  } catch (err: unknown) {
    if (err instanceof AppError) {
      return { ok: false, code: err.code, message: err.message, details: err.details };
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    return { ok: false, code: "INTERNAL_ERROR", message: msg };
  }
}

// Re-export ProductDoc reference so unused-import lint stays clean
export type { ProductDoc };
