/**
 * Authoritative state machine specifications (5 core + 2 auxiliary).
 * Mirrors docs/07 §4 (including ready-stock direct seal, reviewMode=skip direct seal,
 * finalized 4-step recruit funnel with 200-Yuan deposit, and merged yarn dispatched state).
 */

export type StateSpec<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(spec: StateSpec<S>, from: S, to: S): boolean {
  const allowed = spec[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

// 1. 订单包主状态机 (orderPackages)
export type OrderPackageStatus =
  | "confirming"
  | "waiting_dispatch"
  | "offered"
  | "making"
  | "photo_review"
  | "awaiting_seal"
  | "ready_to_ship"
  | "shipped"
  | "signed"
  | "settled_ready"
  | "settled"
  | "manual_hold"
  | "cancelled_full"
  | "cancelled_made"
  | "returned"
  | "quality_refunded"
  | "lost_compensated";

export const ORDER_PACKAGE_STATUS_SPEC: StateSpec<OrderPackageStatus> = {
  confirming: ["waiting_dispatch", "cancelled_full"],
  waiting_dispatch: ["offered", "cancelled_full", "manual_hold"],
  offered: [
    "making", // 正常定制单接单
    "awaiting_seal", // 余货复用 (isReadyStockReuse=true)：跳过制作与审照直通装袋
    "waiting_dispatch", // 拒接 / 1h 超时改派
    "cancelled_full", // 接单前买家取消
  ],
  making: [
    "photo_review", // 需审单：裸拍成品照送审
    "ready_to_ship", // 高信用免审单 (reviewMode=skip)：一步完成成品+袋码封签直发
    "waiting_dispatch", // 12h 内无责主动转单 / 队首超 24h+6h 停工熔断收回改派
    "cancelled_made", // 开工后买家退款（固定款继续做完入 weaverStock）
    "manual_hold", // 队首严重卡单或超期
  ],
  photo_review: ["awaiting_seal", "making", "cancelled_made"],
  awaiting_seal: ["ready_to_ship", "manual_hold", "cancelled_made"],
  ready_to_ship: ["shipped", "manual_hold", "cancelled_made"],
  shipped: ["signed", "lost_compensated"],
  signed: ["settled_ready", "returned", "quality_refunded"],
  settled_ready: ["settled"],
  lost_compensated: ["settled"], // 快递丢损平台兜底赔买家，照常给织女结工价
  manual_hold: ["waiting_dispatch", "making", "awaiting_seal", "ready_to_ship", "cancelled_full", "cancelled_made"],
  settled: [],
  cancelled_full: [],
  cancelled_made: [],
  returned: [],
  quality_refunded: [],
};

// 2. 四步准入漏斗状态机 (recruitFunnel) — 第 9 轮正式定型
export type RecruitFunnelStage =
  | "apply_entry"
  | "trial_make"
  | "sample_inspect"
  | "pending_deposit"
  | "approved"
  | "rejected";

export const RECRUIT_FUNNEL_SPEC: StateSpec<RecruitFunnelStage> = {
  apply_entry: ["apply_entry", "trial_make", "rejected"],
  trial_make: ["trial_make", "sample_inspect", "rejected"],
  sample_inspect: ["sample_inspect", "pending_deposit", "rejected"],
  pending_deposit: ["approved", "rejected"],
  approved: [],
  rejected: ["apply_entry"], // 满 30 天冷却后可重申
};

// 3. 统一审照状态机 (photoReviews)
export type PhotoReviewStatus = "pending" | "needs_admin" | "approved" | "rejected";

export const PHOTO_REVIEW_STATUS_SPEC: StateSpec<PhotoReviewStatus> = {
  pending: ["needs_admin", "approved", "rejected"],
  needs_admin: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

// 4. 每周线材申领状态机 (yarnClaims) — exported 与 shipped 已合并为 dispatched
export type YarnClaimStatus = "reserved" | "confirmed" | "dispatched" | "received" | "cancelled";

export const YARN_CLAIM_STATUS_SPEC: StateSpec<YarnClaimStatus> = {
  reserved: ["confirmed", "cancelled"],
  confirmed: ["dispatched", "cancelled"],
  dispatched: ["received"],
  received: [],
  cancelled: [],
};

// 5. 小程序退款单状态机 (refunds)
export type RefundStatus = "pending_review" | "refunding" | "succeeded" | "rejected" | "failed";

export const REFUND_STATUS_SPEC: StateSpec<RefundStatus> = {
  pending_review: ["refunding", "rejected"],
  refunding: ["succeeded", "failed"],
  failed: ["refunding"],
  succeeded: [],
  rejected: [],
};

// 辅助状态机 6: 派单邀约 (dispatchOffers)
export type DispatchOfferStatus = "pending" | "accepted" | "rejected" | "timeout" | "cancelled";

export const DISPATCH_OFFER_STATUS_SPEC: StateSpec<DispatchOfferStatus> = {
  pending: ["accepted", "rejected", "timeout", "cancelled"],
  accepted: [],
  rejected: [],
  timeout: [],
  cancelled: [],
};

// 辅助状态机 7: 袋码贴纸 (bagStickers)
export type BagStickerStatus = "unused" | "bound" | "void";

export const BAG_STICKER_STATUS_SPEC: StateSpec<BagStickerStatus> = {
  unused: ["bound", "void"],
  bound: ["void"],
  void: [],
};

// 辅助状态机 8: 物流发货单 (shipments)
export type ShipmentStatus =
  | "awaiting_seal"
  | "ready_to_ship"
  | "pickup_scheduled"
  | "in_transit"
  | "signed"
  | "lost_or_damaged"
  | "cancelled";

export const SHIPMENT_STATUS_SPEC: StateSpec<ShipmentStatus> = {
  awaiting_seal: ["ready_to_ship", "in_transit", "cancelled"],
  ready_to_ship: ["pickup_scheduled", "in_transit", "cancelled"],
  pickup_scheduled: ["in_transit", "ready_to_ship", "cancelled"],
  in_transit: ["signed", "lost_or_damaged"],
  signed: [],
  lost_or_damaged: [],
  cancelled: [],
};

// 辅助状态机 9: 工单与售后单 (tickets)
export type TicketStatus = "open" | "processing" | "resolved";

export const TICKET_STATUS_SPEC: StateSpec<TicketStatus> = {
  open: ["processing", "resolved"],
  processing: ["resolved"],
  resolved: [],
};
