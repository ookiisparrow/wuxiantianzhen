import crypto from "node:crypto";
import type { OrderChannel } from "@wxtz/shared";

function randomHex(bytes = 8): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function prefixedId(prefix: string): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  return `${prefix}_${ts}${randomHex(5)}`;
}

// Random internal entity IDs
export const newUserId = (): string => prefixedId("usr");
export const newAddressId = (): string => prefixedId("addr");
export const newOrderId = (): string => prefixedId("ord");
export const newPackageId = (): string => prefixedId("pkg");
export const newReviewId = (): string => prefixedId("rev");
export const newTicketId = (): string => prefixedId("tkt");
export const newAuditId = (): string => prefixedId("aud");
export const newNotificationId = (): string => prefixedId("ntf");
export const newProductId = (): string => prefixedId("prod");
export const newPatternId = (): string => prefixedId("pat");

// Deterministic primary / idempotency keys (docs/07 §3 & §6)
export const recruitFunnelId = (userId: string): string => `funnel_${userId}`;
export const volunteerId = (userId: string): string => `vol_${userId}`;
export const weaverAccountId = (userId: string): string => `acc_${userId}`;
export const weaverStockId = (weaverId: string, skuCode: string): string => `stock_${weaverId}_${skuCode}`;
export const styleEnrollmentId = (skuCode: string, weaverId: string): string => `enroll_${skuCode}_${weaverId}`;
export const externalOrderIndexId = (channel: OrderChannel, externalOrderId: string): string =>
  `${channel}:${externalOrderId}`;
export const dispatchOfferId = (packageId: string, attemptNo: number): string => `offer_${packageId}_${attemptNo}`;
export const volunteerVoteId = (reviewId: string, volunteerUserId: string): string =>
  `vote_${reviewId}_${volunteerUserId}`;
export const shipmentId = (packageId: string): string => `ship_${packageId}`;
export const paymentId = (orderId: string): string => `pay_${orderId}`;
export const refundId = (orderId: string, seq: number): string => `ref_${orderId}_${seq}`;
export const yarnClaimId = (weaverId: string, weekKey: string): string => `claim_${weaverId}_${weekKey}`;
export const bagStickerId = (code: string): string => `stk_${code}`;
export const restockReminderId = (userId: string, skuCode: string): string => `ntf_restock_${userId}_${skuCode}`;

// Ledger entry deterministic keys
export const ledgerKeyPay = (orderId: string): string => `pay:${orderId}`;
export const ledgerKeyFee = (orderId: string): string => `fee:${orderId}`;
export const ledgerKeyAccrue = (pkgId: string): string => `accrue:${pkgId}`;
export const ledgerKeyYarnOut = (claimId: string): string => `yarn_out:${claimId}`;
export const ledgerKeyYarnRefund = (claimId: string): string => `yarn_refund:${claimId}`;
export const ledgerKeyDepositIn = (userId: string, cycle = 1): string =>
  cycle <= 1 ? `deposit_in:${userId}` : `deposit_in:${userId}:c${cycle}`;
export const ledgerKeyDepositOut = (userId: string, cycle = 1): string =>
  cycle <= 1 ? `deposit_out:${userId}` : `deposit_out:${userId}:c${cycle}`;
export const ledgerKeyQualityRefund = (refId: string): string => `qual_ref:${refId}`;
export const ledgerKeyLossComp = (pkgId: string): string => `loss_comp:${pkgId}`;
export const ledgerKeyPayout = (batchId: string, payeeId: string): string => `payout:${batchId}:${payeeId}`;
export const ledgerKeyShipFee = (pkgId: string): string => `ship_fee:${pkgId}`;
