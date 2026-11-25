import {
  AppError,
  COLLECTIONS,
  ERROR_CODES,
  PHOTO_REVIEW_STATUS_SPEC,
  asFen,
  computeSafeLiveStockPlan,
  type AddressDoc,
  type DepositChannel,
  type OrderPackageDoc,
  type PaymentDoc,
  type PhotoReviewDoc,
  type ProductDoc,
  type RecruitFunnelDoc,
  type RegionCode,
  type StyleDoc,
  type StyleEnrollmentDoc,
  type SystemConfigDoc,
  type TicketDoc,
  type UserDoc,
  type WeaverAccountDoc,
  type WeaverStockDoc,
  type YarnCatalogDoc,
  type YarnClaimDoc,
} from "@wxtz/shared";
import { loginOrMergeUser, type MiniProgramApp } from "../kit/auth.ts";
import type { DbAdapter } from "../kit/db.ts";
import { newUserId, paymentId, recruitFunnelId, weaverAccountId } from "../kit/ids.ts";
import { reconcileWeaverAccount } from "../kit/ledger.ts";
import { releaseExpiredReservations } from "../kit/stockLock.ts";
import { transitionStatus } from "../kit/transition.ts";
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
  generateBagStickerBatch,
  getSystemConfig,
  reassignManualHoldPackage,
  upsertPattern,
  upsertPatternModule,
  upsertProduct,
  upsertStyleWithBom,
  upsertSystemConfig,
  upsertYarnCatalogItem,
} from "../services/catalogAdmin.ts";
import {
  dispatchPoolTick,
  getHeadPatternForWeaver,
  releaseMakingOrderVoluntarily,
  respondDispatchOffer,
  sweepOffersAndStalledPackages,
} from "../services/dispatch.ts";
import { commitDouyinImport, importDouyinLogisticsCsv, previewDouyinImport } from "../services/douyinCsv.ts";
import {
  activateFanVolunteerAfterExam,
  adminArbitratePhotoReview,
  castVolunteerVote,
  getBlindReviewCardForVolunteer,
  handleKuaidi100Webhook,
  sealAndSubmitShipment,
  submitFinishedWork,
  sweepPhotoReviewSla,
  sweepSettleEligiblePackages,
  sweepUnscheduledMpPickups,
} from "../services/fulfillment.ts";
import {
  completeDepositAndApproveWeaver,
  passPortfolioAndUnlockExamSample,
  passTrialPhotosToSampleInspect,
  recordPhysicalSampleInspection,
  submitFunnelEntryStep1,
} from "../services/funnel.ts";
import {
  computeCurrentMonthSalesFen,
  listTickets,
  replyAndResolveTicket,
  requestWeaverExitAndRefundDeposit,
  runDailyDueAndStockAlerts,
  runWeeklyGovernance,
  setWeaverOrderAcceptance,
  submitTicket,
  subscribeProductRestockReminder,
  sweepOfferPreExpirySmsReminders,
} from "../services/governance.ts";
import {
  cancelWeeklyYarnClaim,
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
  unionid?: string;
  invocationSource?: "mp_client" | "timer" | "http_gateway" | "internal";
  adminJwtSecret: string;
  adminToken?: string;
  nowUtcMs?: number;
}

export type ApiResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

const DEFAULT_SELF_SHIP_REIMB_FEN = asFen(500); // ¥5.00 standard township station first-weight subsidy
const DEFAULT_YARN_SHIP_FEE_FEN = asFen(250); // ¥2.50 weekly JZH yarn shipping fee

async function requireMiniProgramUser(ctx: CloudRequestContext, expectedApp?: MiniProgramApp): Promise<UserDoc> {
  if (!ctx.openid || !ctx.app) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "请在微信小程序内打开");
  }
  if (expectedApp && ctx.app !== expectedApp) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "当前小程序端无权调用该接口");
  }
  const field = ctx.app === "mp-buyer" ? "buyerOpenid" : "weaverOpenid";
  const found = await ctx.db.find<UserDoc>(COLLECTIONS.USERS, (u) => u[field] === ctx.openid);
  if (!found[0]) {
    throw new AppError(ERROR_CODES.PHONE_REQUIRED, "请先完成手机号绑定登录");
  }
  return found[0];
}

function assertNotMiniProgramClient(ctx: CloudRequestContext): void {
  if (ctx.invocationSource === "mp_client" || Boolean(ctx.openid)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "内部回调与定时任务禁止小程序客户端直接调用");
  }
}

function assertCronCaller(ctx: CloudRequestContext, nowUtcMs: number): void {
  assertNotMiniProgramClient(ctx);
  if (ctx.invocationSource === "http_gateway") {
    verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, nowUtcMs);
  }
}

async function getServerRecruitRegions(db: DbAdapter): Promise<readonly RegionCode[]> {
  const cfg = await db.get<SystemConfigDoc>(COLLECTIONS.SYSTEM_CONFIG, "recruit");
  const raw = cfg?.activeRecruitRegions ?? (cfg?.value as Record<string, unknown> | undefined)?.activeRecruitRegions;
  return Array.isArray(raw) && raw.length > 0 ? (raw as RegionCode[]) : ["jzh"];
}

async function upsertUserAddress(
  db: DbAdapter,
  params: {
    ownerUserId: string;
    type: AddressDoc["type"];
    payload: Record<string, any>;
    nowUtcMs: number;
  },
): Promise<AddressDoc> {
  const addrId = params.payload.addressId
    ? String(params.payload.addressId)
    : `addr_${newUserId().slice(4)}`;
  const existing = await db.get<AddressDoc>(COLLECTIONS.ADDRESSES, addrId);
  if (existing && existing.ownerUserId !== params.ownerUserId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "无权修改他人地址");
  }
  const doc: AddressDoc = {
    _id: addrId,
    ownerUserId: params.ownerUserId,
    type: params.type,
    contactName: String(params.payload.contactName ?? "默认收件人").trim(),
    contactPhone: String(params.payload.contactPhone ?? "13800000000").trim(),
    province: String(params.payload.province ?? "浙江省").trim(),
    city: String(params.payload.city ?? "杭州市").trim(),
    district: String(params.payload.district ?? "西湖区").trim(),
    detail: String(params.payload.detail ?? "默认详细地址").trim(),
    isDefault: Boolean(params.payload.isDefault ?? true),
    createdAt: existing?.createdAt ?? params.nowUtcMs,
    updatedAt: params.nowUtcMs,
  };
  await db.put(COLLECTIONS.ADDRESSES, doc);
  return doc;
}

/**
 * Unified CloudBase entrypoint router dispatching actions across all domains
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
          // Never trust client-supplied unionid; only accept server-verified ctx.unionid
          unionid: ctx.unionid,
          nickname: payload.nickname,
          allowOpenidRebind: false,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }

      // ---------------- WEAVER (mp-weaver) ----------------
      case "weaver.dashboard": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
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
      case "weaver.saveAddress": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const addr = await upsertUserAddress(ctx.db, {
          ownerUserId: u._id,
          type: "weaver_send",
          payload,
          nowUtcMs: now,
        });
        if (addr.isDefault) {
          await ctx.db.atomicUpdate<UserDoc>(
            COLLECTIONS.USERS,
            u._id,
            () => true,
            (cur) => ({ ...cur, defaultSendAddrId: addr._id, updatedAt: now }),
          );
        }
        return { ok: true, data: addr };
      }
      case "weaver.respondOffer": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await respondDispatchOffer(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          action: payload.decision === "accept" ? "accept" : "reject",
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.getHeadPattern": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await getHeadPatternForWeaver(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          skuCode: payload.skuCode ? String(payload.skuCode) : undefined,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.getPatternSignedUrl": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const head = await getHeadPatternForWeaver(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          skuCode: payload.skuCode ? String(payload.skuCode) : undefined,
          nowUtcMs: now,
        });
        const signedUrls: Record<string, string> = {};
        for (const pat of head.patterns) {
          for (const part of pat.parts) {
            for (const step of part.steps) {
              if (step.imageFileId) {
                signedUrls[step.imageFileId] =
                  `https://tcb-ephemeral.wxtz.local/${encodeURIComponent(step.imageFileId)}?exp=${head.urlExpiresAt}&wm=${encodeURIComponent(head.watermarkText)}`;
              }
            }
          }
        }
        return {
          ok: true,
          data: {
            ...head,
            signedUrls,
          },
        };
      }
      case "weaver.releaseOrder": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await releaseMakingOrderVoluntarily(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.submitFinishedWork": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const mediaIds = [
          ...(Object.values(payload.photoSlots ?? {}) as string[]),
          ...(payload.sealedPhotoFileId ? [String(payload.sealedPhotoFileId)] : []),
        ];
        for (const fid of mediaIds) {
          if (fid) {
            await ctx.ports.contentSec.submitImageCheckAsync({
              openid: ctx.openid ?? "",
              mediaUrl: fid,
              scene: 2,
            });
          }
        }
        const trackingNo = payload.selfDropoffTrackingNo ? String(payload.selfDropoffTrackingNo).trim() : undefined;
        const res = await submitFinishedWork(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          photoSlots: payload.photoSlots,
          imageHashes: payload.imageHashes ?? [],
          bagStickerCode: payload.bagStickerCode,
          sealedPhotoFileId: payload.sealedPhotoFileId,
          pickupWindow: payload.pickupWindow,
          selfDropoffTrackingNo: trackingNo,
          standardSelfShipReimbFen:
            u.shippingMode === "self_dropoff" && trackingNo ? DEFAULT_SELF_SHIP_REIMB_FEN : undefined,
          logisticsPort: ctx.ports.logistics,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.sealAndSubmit": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const sealedFileId = String(payload.sealedPhotoFileId);
        if (sealedFileId) {
          await ctx.ports.contentSec.submitImageCheckAsync({
            openid: ctx.openid ?? "",
            mediaUrl: sealedFileId,
            scene: 2,
          });
        }
        const trackingNo = payload.selfDropoffTrackingNo ? String(payload.selfDropoffTrackingNo).trim() : undefined;
        // Standard self-ship subsidy is strictly determined server-side — never trust client Fen!
        const serverReimbFen =
          u.shippingMode === "self_dropoff" && trackingNo ? DEFAULT_SELF_SHIP_REIMB_FEN : undefined;

        const res = await sealAndSubmitShipment(ctx.db, {
          packageId: String(payload.packageId),
          weaverId: u._id,
          bagStickerCode: String(payload.bagStickerCode),
          sealedPhotoFileId: sealedFileId,
          pickupWindow: payload.pickupWindow,
          selfDropoffTrackingNo: trackingNo,
          standardSelfShipReimbFen: serverReimbFen,
          logisticsPort: ctx.ports.logistics,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.confirmSkeinCheck": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
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
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await submitWeeklyYarnClaim(ctx.db, {
          weaverId: u._id,
          sendAddrId: String(payload.sendAddrId),
          items: payload.items ?? [],
          shippingFeeFen: DEFAULT_YARN_SHIP_FEE_FEN,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.cancelYarnClaim": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await cancelWeeklyYarnClaim(ctx.db, {
          claimId: String(payload.claimId),
          weaverId: u._id,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.confirmYarnReceived": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await confirmYarnClaimReceived(ctx.db, {
          claimId: String(payload.claimId),
          weaverId: u._id,
          confirmPhotoFileId: payload.confirmPhotoFileId,
          nowUtcMs: now,
        });
        return { ok: true, data: { yarnInventory: res.yarnInventory } };
      }
      case "weaver.funnelStep1": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const photoIds: string[] = Array.isArray(payload.portfolioPhotoFileIds)
          ? payload.portfolioPhotoFileIds.map(String)
          : [];
        for (const fid of photoIds) {
          if (fid) {
            await ctx.ports.contentSec.submitImageCheckAsync({
              openid: ctx.openid ?? "",
              mediaUrl: fid,
              scene: 2,
            });
          }
        }
        const activeRegions = await getServerRecruitRegions(ctx.db);
        const res = await submitFunnelEntryStep1(ctx.db, {
          userId: u._id,
          province: String(payload.province),
          city: String(payload.city),
          activeRecruitRegions: activeRegions,
          quizCorrectCount: Number(payload.quizCorrectCount),
          portfolioPhotoFileIds: photoIds,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.funnelAckDeposit": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await passPortfolioAndUnlockExamSample(ctx.db, {
          userId: u._id,
          ackDepositNotice: Boolean(payload.ackDepositNotice),
          requireApprovedPortfolio: true,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.setAcceptingOrders": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await setWeaverOrderAcceptance(ctx.db, {
          weaverId: u._id,
          acceptingOrders: Boolean(payload.acceptingOrders),
          pauseUntil: payload.pauseUntil !== undefined ? Number(payload.pauseUntil) : undefined,
          restDays: payload.restDays,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.requestDepositExit": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await requestWeaverExitAndRefundDeposit(ctx.db, {
          weaverId: u._id,
          paymentPort: ctx.ports.payment,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.submitTicket": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const photoIds: string[] = Array.isArray(payload.photoFileIds) ? payload.photoFileIds.map(String) : [];
        for (const fid of photoIds) {
          if (fid) {
            await ctx.ports.contentSec.submitImageCheckAsync({
              openid: ctx.openid ?? "",
              mediaUrl: fid,
              scene: 2,
            });
          }
        }
        const safeText = await ctx.ports.contentSec.checkTextSafe({
          openid: ctx.openid ?? "",
          content: String(payload.content ?? ""),
        });
        if (!safeText.pass) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, "反馈内容包含违规敏感信息");
        }
        const res = await submitTicket(ctx.db, {
          userId: u._id,
          role: "weaver",
          type: payload.type ?? "other",
          relatedId: payload.relatedId,
          content: String(payload.content ?? ""),
          photoFileIds: photoIds,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "weaver.myTickets": {
        const u = await requireMiniProgramUser(ctx, "mp-weaver");
        const res = await listTickets(ctx.db, { userId: u._id, role: "weaver" });
        return { ok: true, data: res };
      }

      // ---------------- VOLUNTEER (mp-buyer role entry) ----------------
      case "volunteer.passExam": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
        const res = await activateFanVolunteerAfterExam(ctx.db, {
          userId: u._id,
          correctCount: Number(payload.correctCount),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "volunteer.getCard": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
        const card = await getBlindReviewCardForVolunteer(ctx.db, String(payload.reviewId), u._id);
        return { ok: true, data: card };
      }
      case "volunteer.vote": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
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
          ctx.db.find<ProductDoc>(COLLECTIONS.PRODUCTS, (p) => p.isOnSale === true),
          ctx.db.find<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, (s) => s.availableQty > 0),
        ]);
        products.sort((a, b) => a.sortOrder - b.sortOrder);
        const readyStockBySku: Record<string, number> = {};
        for (const s of stocks) {
          readyStockBySku[s.skuCode] = (readyStockBySku[s.skuCode] ?? 0) + s.availableQty;
        }
        return { ok: true, data: { products, readyStockBySku } };
      }
      case "buyer.saveAddress": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
        const addr = await upsertUserAddress(ctx.db, {
          ownerUserId: u._id,
          type: "buyer_recv",
          payload,
          nowUtcMs: now,
        });
        return { ok: true, data: addr };
      }
      case "buyer.payWeaverDeposit": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
        const depositAmountFen = asFen(20000); // 200.00 RMB cooperative performance deposit (LIAB_WEAVER_DEPOSIT)
        const mchId = String(payload.mchId ?? "MCH_DEFAULT");
        const outTradeNo = `DEP_${u._id}_${now}`;
        const payDoc: PaymentDoc = {
          _id: paymentId(outTradeNo),
          orderId: outTradeNo,
          buyerUserId: u._id,
          mchId,
          outTradeNo,
          amountFen: depositAmountFen,
          status: "init",
        };
        await ctx.db.insert(COLLECTIONS.PAYMENTS, payDoc);

        const prepay = await ctx.ports.payment.createJsapiPrepay({
          mchId,
          outTradeNo,
          buyerOpenid: ctx.openid!,
          amountFen: depositAmountFen,
          description: "无限天真·织女履约合作保证金(可全额退)",
        });
        return { ok: true, data: { userId: u._id, outTradeNo, amountFen: depositAmountFen, prepay } };
      }
      case "buyer.checkSellability": {
        const u = ctx.openid && ctx.app ? await requireMiniProgramUser(ctx, "mp-buyer").catch(() => null) : null;
        const res = await checkProductSellability(ctx.db, {
          productId: String(payload.productId),
          buyerUserId: u?._id,
          qty: Number(payload.qty ?? 1),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "buyer.createOrder": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
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
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
        const res = await requestMpBuyerRefund(ctx.db, {
          orderId: String(payload.orderId),
          buyerUserId: u._id,
          reason: String(payload.reason ?? ""),
          trigger: payload.trigger,
          paymentPort: ctx.ports.payment,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "buyer.subscribeRestock": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
        const res = await subscribeProductRestockReminder(ctx.db, {
          userId: u._id,
          productId: String(payload.productId),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "buyer.submitTicket": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
        const photoIds: string[] = Array.isArray(payload.photoFileIds) ? payload.photoFileIds.map(String) : [];
        for (const fid of photoIds) {
          if (fid) {
            await ctx.ports.contentSec.submitImageCheckAsync({
              openid: ctx.openid ?? "",
              mediaUrl: fid,
              scene: 2,
            });
          }
        }
        const safeText = await ctx.ports.contentSec.checkTextSafe({
          openid: ctx.openid ?? "",
          content: String(payload.content ?? ""),
        });
        if (!safeText.pass) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, "反馈内容包含违规敏感信息");
        }
        const res = await submitTicket(ctx.db, {
          userId: u._id,
          role: "buyer",
          type: payload.type ?? "after_sale",
          relatedId: payload.relatedId,
          content: String(payload.content ?? ""),
          photoFileIds: photoIds,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "buyer.myTickets": {
        const u = await requireMiniProgramUser(ctx, "mp-buyer");
        const res = await listTickets(ctx.db, { userId: u._id, role: "buyer" });
        return { ok: true, data: res };
      }

      // ---------------- ADMIN (Web Console, JWT Protected) ----------------
      case "admin.liveSafeStockPlan": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const [styles, yarns, liveWeavers, activePkgs, stocks, enrollments] = await Promise.all([
          ctx.db.find<StyleDoc>(COLLECTIONS.STYLES, (s) => s.status === "active"),
          ctx.db.find<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, () => true),
          ctx.db.find<UserDoc>(
            COLLECTIONS.USERS,
            (u) => u.pool === "live" && u.funnelStage === "approved" && u.acceptingOrders,
          ),
          ctx.db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) =>
            ["confirming", "waiting_dispatch", "offered", "making", "photo_review"].includes(p.status),
          ),
          ctx.db.find<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, (s) => s.availableQty > 0),
          ctx.db.find<StyleEnrollmentDoc>(COLLECTIONS.STYLE_ENROLLMENTS, (e) => e.status === "certified"),
        ]);

        const yarnWeight = new Map(yarns.map((y) => [y._id, y.unitWeightG || 50]));
        const certifiedByWeaver = new Map<string, string[]>();
        for (const e of enrollments) {
          const list = certifiedByWeaver.get(e.weaverId) ?? [];
          list.push(e.skuCode);
          certifiedByWeaver.set(e.weaverId, list);
        }

        const backlogMap = new Map<string, number>();
        const stalledWeavers = new Set<string>();
        for (const p of activePkgs) {
          if (p.assignedWeaverId) {
            if (!p.isReadyStockReuse) {
              backlogMap.set(p.assignedWeaverId, (backlogMap.get(p.assignedWeaverId) ?? 0) + p.totalMin);
            }
            if (p.status === "making" && p.queueSeq === 1 && p.stallPromptedAt) {
              stalledWeavers.add(p.assignedWeaverId);
            }
          }
        }

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
            isStalledHead: stalledWeavers.has(w._id),
            yarnInventory: w.yarnInventory,
            certifiedStyleCodes: certifiedByWeaver.get(w._id) ?? [],
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
          paymentPort: ctx.ports.payment,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.funnelPassPortfolio": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const fId = recruitFunnelId(String(payload.userId));
        const reviews = await ctx.db.find<PhotoReviewDoc>(
          COLLECTIONS.PHOTO_REVIEWS,
          (r) => r.scene === "funnel_portfolio" && r.targetId === fId && r.status !== "approved",
        );
        for (const rev of reviews) {
          if (rev.status === "pending" || rev.status === "needs_admin") {
            await transitionStatus(
              ctx.db,
              COLLECTIONS.PHOTO_REVIEWS,
              rev._id,
              PHOTO_REVIEW_STATUS_SPEC,
              rev.status,
              "approved",
              rev.version,
              () => ({ finalDecisionBy: adm.sub, decidedAt: now }),
              now,
            );
          }
        }
        return { ok: true, data: { approvedCount: reviews.length } };
      }
      case "admin.funnelApproveDeposit": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const rawChannel = String(payload.depositChannel ?? "mp_buyer_cashier");
        const channel: DepositChannel =
          rawChannel === "manual_transfer_verify" ? "manual_transfer_verify" : "mp_buyer_cashier";
        const res = await completeDepositAndApproveWeaver(ctx.db, {
          userId: String(payload.userId),
          weaverNo: String(payload.weaverNo),
          dailyCapacityMin: Number(payload.dailyCapacityMin ?? 240),
          base12Codes: payload.base12Codes ?? [],
          depositChannel: channel,
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
      case "admin.importDouyinLogistics": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await importDouyinLogisticsCsv(ctx.db, {
          rows: payload.rows ?? [],
          nowUtcMs: now,
        });
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "importDouyinLogistics",
          summary: `回导抖店ERP物流运单：发货更新 ${res.shippedUpdated} 单，签收更新 ${res.signedUpdated} 单`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.upsertYarn": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await upsertYarnCatalogItem(ctx.db, payload as YarnCatalogDoc);
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "upsertYarn",
          targetId: res._id,
          summary: `维护线材/辅料目录 ${res._id} (${res.name})`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.upsertPatternModule": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await upsertPatternModule(ctx.db, payload as any, now);
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "upsertPatternModule",
          targetId: res._id,
          summary: `维护可拼装图解部件 ${res._id} (${res.name})`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.upsertPattern": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await upsertPattern(ctx.db, payload as any, now);
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "upsertPattern",
          targetId: res._id,
          summary: `维护歌词式图解 ${res._id} (款号 ${res.skuCode})`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.upsertStyle": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await upsertStyleWithBom(ctx.db, payload as any);
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "upsertStyle",
          targetId: res._id,
          summary: `维护款式与克重BOM ${res._id} (材料费 ${res.materialCostFen} 分 / 计提 ${res.yarnPoolAccrualFen} 分)`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.upsertProduct": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await upsertProduct(ctx.db, payload as any, now);
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "upsertProduct",
          targetId: res._id,
          summary: `维护上架商品 ${res._id} (${res.title})`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.generateBagStickers": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await generateBagStickerBatch(ctx.db, {
          weaverId: String(payload.weaverId),
          batchId: String(payload.batchId),
          codes: payload.codes ?? [],
        });
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "generateBagStickers",
          targetId: String(payload.batchId),
          summary: `为织女 ${payload.weaverId} 生成封袋贴纸批次 ${payload.batchId} (${res.createdCount} 张)`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.setConfig": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await upsertSystemConfig(ctx.db, String(payload.key), payload.value ?? {}, adm.sub, now);
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "setConfig",
          targetId: res._id,
          summary: `更新系统动态配置项 ${res._id}`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.getConfig": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await getSystemConfig(ctx.db, String(payload.key));
        return { ok: true, data: res };
      }
      case "admin.reassignManualHold": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await reassignManualHoldPackage(ctx.db, {
          packageId: String(payload.packageId),
          targetWeaverId: payload.targetWeaverId ? String(payload.targetWeaverId) : undefined,
          nowUtcMs: now,
        });
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "reassignManualHold",
          targetId: res.package._id,
          summary: payload.targetWeaverId
            ? `异常包裹 ${res.package._id} 定向改派给织女 ${payload.targetWeaverId}`
            : `异常包裹 ${res.package._id} 重置回公共派单池`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.listTickets": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await listTickets(ctx.db, {
          status: payload.status,
          userId: payload.userId,
          role: payload.role,
        });
        return { ok: true, data: res };
      }
      case "admin.resolveTicket": {
        const adm = verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const res = await replyAndResolveTicket(ctx.db, {
          ticketId: String(payload.ticketId),
          handlerId: adm.sub,
          reply: String(payload.reply ?? ""),
          nextStatus: payload.nextStatus,
          nowUtcMs: now,
        });
        await recordAdminAudit(ctx.db, {
          actorUserId: adm.sub,
          action: "resolveTicket",
          targetId: res._id,
          summary: `处理工单 ${res._id} -> ${res.status}`,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "admin.overview": {
        verifyAdminJwt(ctx.adminToken, ctx.adminJwtSecret, now);
        const [readyPkgs, holdPkgs, escalatedReviews, funnelCandidates, openTickets, currentMonthSalesFen] =
          await Promise.all([
            ctx.db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.status === "ready_to_ship"),
            ctx.db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.status === "manual_hold"),
            ctx.db.find<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, (r) => r.status === "needs_admin"),
            ctx.db.find<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, (f) =>
              ["sample_inspect", "pending_deposit"].includes(f.stage),
            ),
            ctx.db.find<TicketDoc>(COLLECTIONS.TICKETS, (t) => t.status !== "resolved"),
            computeCurrentMonthSalesFen(ctx.db, now),
          ]);
        return {
          ok: true,
          data: {
            readyToShipCount: readyPkgs.length,
            readyPackages: readyPkgs,
            manualHoldPackages: holdPkgs,
            escalatedReviews,
            funnelCandidates,
            openTicketsCount: openTickets.length,
            currentMonthSalesFen,
          },
        };
      }

      // ---------------- WEBHOOKS ----------------
      case "webhook.wxpay": {
        assertNotMiniProgramClient(ctx);
        const res = await handleWxPaySuccessWebhook(ctx.db, {
          orderId: String(payload.orderId),
          wxTransactionId: String(payload.wxTransactionId),
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }
      case "webhook.kuaidi100": {
        assertNotMiniProgramClient(ctx);
        const res = await handleKuaidi100Webhook(ctx.db, {
          packageId: payload.packageId ? String(payload.packageId) : undefined,
          taskId: payload.taskId ? String(payload.taskId) : undefined,
          state: payload.state,
          trackingNo: payload.trackingNo ? String(payload.trackingNo) : undefined,
          carrierCode: payload.carrierCode ? String(payload.carrierCode) : undefined,
          shippingCostFen: payload.shippingCostFen !== undefined ? Number(payload.shippingCostFen) : undefined,
          logisticsPort: ctx.ports.logistics,
          nowUtcMs: now,
        });
        return { ok: true, data: res };
      }

      // ---------------- CRON ----------------
      case "cron.dispatchTick": {
        assertCronCaller(ctx, now);
        const res = await dispatchPoolTick(ctx.db, { nowUtcMs: now });
        return { ok: true, data: res };
      }
      case "cron.fiveMinuteWatchdog": {
        assertCronCaller(ctx, now);
        const [offers, stock, sla, smsReminders, pickupRetries] = await Promise.all([
          sweepOffersAndStalledPackages(ctx.db, now),
          releaseExpiredReservations(ctx.db, now),
          sweepPhotoReviewSla(ctx.db, now),
          sweepOfferPreExpirySmsReminders(ctx.db, ctx.ports.notify, now),
          sweepUnscheduledMpPickups(ctx.db, ctx.ports.logistics, now),
        ]);
        return { ok: true, data: { offers, stock, sla, smsReminders, pickupRetries } };
      }
      case "cron.dailySettleAndReconcile": {
        assertCronCaller(ctx, now);
        const settle = await sweepSettleEligiblePackages(ctx.db, now);
        const weavers = await ctx.db.find<UserDoc>(COLLECTIONS.USERS, (u) => u.roles.includes("weaver"));
        const mismatches: string[] = [];
        for (const w of weavers) {
          const r = await reconcileWeaverAccount(ctx.db, w._id);
          if (!r.ok) mismatches.push(w._id);
        }
        return { ok: true, data: { ...settle, reconciledWeavers: weavers.length, mismatches } };
      }
      case "cron.dailyDueAndStockAlert": {
        assertCronCaller(ctx, now);
        const res = await runDailyDueAndStockAlerts(ctx.db, now);
        return { ok: true, data: res };
      }
      case "cron.weeklyGovernance": {
        assertCronCaller(ctx, now);
        const res = await runWeeklyGovernance(ctx.db, now);
        return { ok: true, data: res };
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

export type { ProductDoc };
