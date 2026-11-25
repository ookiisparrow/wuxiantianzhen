import type { Fen, YarnBomEntry } from "./money.ts";
import type {
  BagStickerStatus,
  DispatchOfferStatus,
  OrderPackageStatus,
  PhotoReviewStatus,
  RecruitFunnelStage,
  RefundStatus,
  YarnClaimStatus,
} from "./status.ts";

export type UserRole = "buyer" | "weaver" | "volunteer" | "creator" | "admin";
export type VerifyLevel = "none" | "phone" | "payee" | "full";
export type WeaverPool = "live" | "mp";
export type OrderChannel = "douyin_online" | "mp_wechat";
export type RegionCode = "jzh" | "north" | "sw_ygc" | "nw" | "south_central";
export type ShippingMode = "auto_pickup" | "self_dropoff";
export type DepositChannel = "mp_buyer_cashier" | "manual_transfer_verify";

export interface YarnInventorySlot {
  wholeSkeins: number;
  usedSinceCheckG: number;
  needCheck: boolean;
  status: "ok" | "low" | "empty";
  lastCheckedAt?: number;
}

// 1) users — _id MUST be internal usr_<ulid>, NEVER openid
export interface UserDoc {
  _id: string;
  buyerOpenid?: string;
  weaverOpenid?: string;
  unionid?: string;
  phone: string;
  nickname?: string;
  avatarFileId?: string;
  roles: UserRole[];
  tags: string[];
  verifyLevel: VerifyLevel;
  realName?: string;
  idCardHash?: string;
  bankCardEncrypted?: string;

  // Weaver fields
  weaverNo?: string;
  regionCode?: RegionCode;
  shippingMode?: ShippingMode;
  pool?: WeaverPool;
  poolRank?: number;
  cityQuotaKey?: string;
  funnelStage: "none" | RecruitFunnelStage;
  acceptingOrders: boolean;
  acceptsTrial: boolean;
  restDays: string[];
  dailyCapacityMin: number;
  speedFactor: number; // default 1.0, range [0.6, 1.3]
  stockQuota: Record<string, number>;
  yarnInventory: Record<string, YarnInventorySlot>;
  creditScore: number;
  consecutiveTimeouts: number;
  pauseUntil?: number;
  doudianAddressAlias?: string;
  defaultSendAddrId?: string;

  // Reserved seams
  orgId?: string;
  creatorLevel?: number;

  createdAt: number;
  updatedAt: number;
}

// 2) addresses — cloud-function-only access
export interface AddressDoc {
  _id: string;
  ownerUserId: string;
  type: "buyer_recv" | "weaver_send";
  contactName: string;
  contactPhone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

// 3) recruitFunnel — finalized 4-step funnel + 200 Yuan deposit
export interface RecruitFunnelDoc {
  _id: string; // funnel_${userId}
  userId: string;
  stage: RecruitFunnelStage;
  regionCheckPassed: boolean;
  quizAttempts: number;
  portfolioAttempts: number;
  portfolioReviewId?: string;
  depositNoticeAckAt?: number;
  examSampleCode?: string;
  trialAttempts: number;
  trialReviewId?: string;
  trialPassedAt?: number;
  sampleAttempts: number;
  sampleTrackingNo?: string;
  sampleReceivedAt?: number;
  sampleInspectResult?: "pass" | "fail";
  depositStatus: "unpaid" | "paid" | "refunded";
  depositAmountFen: Fen;
  depositChannel?: DepositChannel;
  depositPaidAt?: number;
  depositRefId?: string;
  cooldownUntil?: number;
  firstOrderPkgId?: string;
  version: number;
  updatedAt: number;
}

// 4) volunteers — fan volunteers ready pre-launch
export interface VolunteerDoc {
  _id: string; // vol_${userId}
  userId: string;
  source: "fan" | "weaver" | "staff";
  status: "examining" | "active" | "paused" | "revoked";
  onboardingExamPassedAt?: number;
  dailyLimit: number;
  todayCount: number;
  todayDate: string;
  points: number;
  calibrationTotal: number;
  calibrationCorrect: number;
  recentWeaverIds: string[];
  joinedAt: number;
}

// 5) styles — BOM + Craft-KOL seams
export interface StyleDoc {
  _id: string; // skuCode
  name: string;
  riskClass: "core" | "trial";
  standardMin: number;
  patternId: string;
  yarnBom: YarnBomEntry[];
  wasteRateBp: number;
  extraAccessoryCostFen: Fen;
  materialCostFen: Fen;
  yarnPoolAccrualFen: Fen; // >= materialCostFen, baked into product price
  craftFeeFen: Fen; // pure labor fee
  weaverShipShareFen: Fen;
  // Craft-KOL & copyright seams
  ownerType: "platform" | "creator";
  creatorUserId?: string;
  tutorialVideoUrl?: string;
  qcOwner: "volunteer_or_admin" | "creator_led";
  royaltyFen: Fen;
  creatorQcFeeFen: Fen;
  trafficCommissionBp: number;
  requiresEnrollment: boolean;
  enrollmentQuota?: number;
  enrollmentMinOrderCount?: number;
  licenseDocId?: string;
  status: "draft" | "active" | "archived";
}

// 6) products
export interface ProductDoc {
  _id: string;
  skuCode: string;
  saleType: "made_to_order" | "ready_stock";
  title: string;
  coverFileIds: string[];
  detailFileIds: string[];
  priceFen: Fen;
  buyerShipFeeFen: Fen;
  etaText: string;
  sortOrder: number;
  isOnSale: boolean;
  updatedAt: number;
}

// 7) patterns
export interface PatternDoc {
  _id: string;
  skuCode: string;
  version: number;
  parts: Array<{
    partName: string;
    steps: Array<{
      rowNo: number;
      text: string;
      stitchCount?: number;
      note?: string;
      imageFileId?: string;
    }>;
  }>;
  authorUserId: string;
  copyrightDocId?: string;
  status: "draft" | "approved";
  updatedAt: number;
}

// 8) weaverStock — ready stock with atomic 15-min reservation lock
export interface WeaverStockDoc {
  _id: string; // stock_${weaverId}_${skuCode}
  weaverId: string;
  skuCode: string;
  availableQty: number;
  reservedQty: number;
  reservations: Array<{ orderId: string; qty: number; expireAt: number }>;
  items: Array<{
    sourceType: "cancelled_order" | "premade_quota";
    sourcePkgId?: string;
    reviewId?: string;
    createdAt: number;
    clearedAt?: number;
  }>;
  oldestCreatedAt: number;
  version: number;
  updatedAt: number;
}

// 9) orders
export interface OrderDoc {
  _id: string;
  channel: OrderChannel;
  externalOrderId?: string;
  buyerUserId?: string;
  referrerCreatorId?: string; // Craft-KOL traffic attribution seam
  receiverAddrId?: string;
  productId?: string;
  skuCode: string;
  qty: number;
  totalPaidFen: Fen;
  buyerShipFeeFen: Fen;
  paymentId?: string;
  status: "unpaid" | "paid" | "fulfilled" | "refunding" | "refunded" | "closed";
  paidAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PackageItemSnapshot {
  skuCode: string;
  qty: number;
  standardMin: number;
  yarnBomSnapshot: Array<{ yarnCode: string; consumedG: number }>;
  materialCostFen: Fen;
  craftFeeFen: Fen;
  yarnPoolAccrualFen: Fen;
  weaverShipShareFen: Fen;
  saleType: "made_to_order" | "ready_stock";
}

// 10) orderPackages
export interface OrderPackageDoc {
  _id: string;
  channel: OrderChannel;
  poolTarget: WeaverPool;
  orderIds: string[];
  externalOrderIds: string[];
  buyerUserId?: string;
  buyerProvince: string;
  buyerCity: string;
  mergeKey?: string;
  itemsSnapshot: PackageItemSnapshot[];
  totalMin: number;
  status: OrderPackageStatus;
  assignedWeaverId?: string;
  queueSeq?: number;
  isReadyStockReuse: boolean;
  attemptCount: number;
  reviewMode: "required" | "sampled" | "skip";
  bagQrCode?: string;
  dispatchableAt: number;
  acceptedAt?: number;
  lastProgressAt?: number;
  stallPromptedAt?: number;
  dueAt?: number;
  shippedAt?: number;
  signedAt?: number;
  settleEligibleAt?: number;
  settledBatchId?: string;
  version: number;
  updatedAt: number;
}

// 11) externalOrderIndex
export interface ExternalOrderIndexDoc {
  _id: string; // ${channel}:${externalOrderId}
  orderId: string;
  packageId: string;
  createdAt: number;
}

// 12) dispatchOffers
export interface DispatchOfferDoc {
  _id: string; // offer_${packageId}_${attemptNo}
  packageId: string;
  attemptNo: number;
  weaverId: string;
  matchTier: "stock" | "repeat" | "same_province" | "same_region" | "national";
  status: DispatchOfferStatus;
  offeredAt: number;
  smsReminderSentAt?: number;
  expireAt: number;
  respondedAt?: number;
  yarnAvailabilityConfirmed: boolean;
  version: number;
}

// 13) photoReviews
export interface PhotoReviewDoc {
  _id: string;
  scene: "shipment_qc" | "funnel_portfolio" | "funnel_trial";
  targetId: string;
  weaverId: string;
  skuCode?: string;
  photoSlots?: {
    frontOnScaleCard: string;
    backStitch: string;
    sidePlumpness: string;
  };
  photoFileIds: string[];
  imageHashes: string[];
  duplicateFlag: boolean;
  exifMeta?: Record<string, unknown>;
  isCalibrationSample: boolean;
  isPublicStandard?: boolean;
  requiredVotes: number;
  slaDeadlineAt: number;
  voteCount: number;
  avgScore?: number;
  scoreSpread?: number;
  status: PhotoReviewStatus;
  rejectReason?: string;
  finalDecisionBy?: string;
  version: number;
  createdAt: number;
  decidedAt?: number;
}

// 14) volunteerVotes
export interface VolunteerVoteDoc {
  _id: string; // vote_${reviewId}_${volunteerUserId}
  reviewId: string;
  volunteerUserId: string;
  score: number;
  tags: string[];
  dwellMs: number;
  isCalibrationHit?: boolean;
  createdAt: number;
}

// 15) shipments
export interface ShipmentDoc {
  _id: string; // ship_${packageId}
  packageId: string;
  fulfillMode: "douyin_online" | "douyin_erp" | "kuaidi100_pickup" | "weaver_self_ship";
  hubId?: string;
  pickupWindow?: string;
  sealedPhotoFileId?: string;
  doudianAddressAlias?: string;
  senderAddrId?: string;
  receiverAddrId?: string;
  kuaidi100TaskId?: string;
  carrierCode?: string;
  trackingNo?: string;
  shippingCostFen?: Fen;
  selfShipReimbFen?: Fen;
  insuredFeeFen?: Fen;
  pickupRetryCount: number;
  status:
    | "awaiting_seal"
    | "ready_to_ship"
    | "pickup_scheduled"
    | "in_transit"
    | "signed"
    | "lost_or_damaged"
    | "cancelled";
  updatedAt: number;
}

// 16) payments
export interface PaymentDoc {
  _id: string; // pay_${orderId}
  orderId: string;
  buyerUserId: string;
  mchId: string;
  outTradeNo: string;
  wxTransactionId?: string;
  amountFen: Fen;
  wxFeeFen?: Fen;
  status: "init" | "paid" | "closed";
  paidAt?: number;
  rawNotifyAt?: number;
}

// 17) refunds
export interface RefundDoc {
  _id: string; // ref_${orderId}_${seq}
  orderId: string;
  packageId: string;
  channel: OrderChannel;
  trigger: "buyer_pre_dispatch" | "buyer_in_making" | "buyer_return_7d" | "quality_defect" | "logistics_loss";
  autoApproved: boolean;
  amountFen: Fen;
  wxRefundId?: string;
  weaverCraftPolicy: "none" | "keep_as_stock" | "keep_paid" | "forfeit_craft_only";
  status: RefundStatus;
  operatorId?: string;
  reason: string;
  version: number;
  createdAt: number;
  completedAt?: number;
}

// 18) tickets
export interface TicketDoc {
  _id: string;
  userId: string;
  role: "buyer" | "weaver";
  type: "order_issue" | "after_sale" | "yarn_issue" | "pattern_bug" | "other";
  relatedId?: string;
  content: string;
  photoFileIds: string[];
  status: "open" | "processing" | "resolved";
  reply?: string;
  handlerId?: string;
  createdAt: number;
  updatedAt: number;
}

// 19) yarnCatalog
export interface YarnCatalogDoc {
  _id: string; // yarnCode
  name: string;
  brand: string;
  itemType: "yarn" | "accessory_kit" | "material_pack";
  isBase12: boolean;
  isMaterialPack: boolean;
  packItems?: Array<{ yarnCode: string; qty: number }>;
  unitWeightG: number;
  unitCostFen: Fen;
  supplierId: string;
  supplierSkuCode: string;
  status: "active" | "out_of_stock" | "archived";
}

// 20) yarnClaims
export interface YarnClaimDoc {
  _id: string; // claim_${weaverId}_${weekKey}
  weaverId: string;
  weekKey: string;
  sendAddrId: string;
  items: Array<{
    yarnCode: string;
    supplierSkuCode: string;
    qty: number;
    unitWeightG: number;
    unitCostFen: Fen;
  }>;
  totalQty: number;
  materialsCostFen: Fen;
  shippingFeeFen: Fen;
  status: YarnClaimStatus;
  exportBatchId?: string;
  receivedConfirmedAt?: number;
  confirmPhotoFileId?: string;
  version: number;
  createdAt: number;
}

// 21) bagStickers
export interface BagStickerDoc {
  _id: string; // stk_<code>
  code: string;
  weaverId: string;
  batchId: string;
  status: BagStickerStatus;
  boundPackageId?: string;
  boundAt?: number;
  version: number;
}

// 22) ledgerAccounts
export const LEDGER_ACCOUNT_CODES = {
  ASSET_WXPAY_CASH: "ASSET_WXPAY_CASH",
  ASSET_DOUYIN_AR: "ASSET_DOUYIN_AR",
  ASSET_BANK_CASH: "ASSET_BANK_CASH",
  ASSET_KD100_PREPAID: "ASSET_KD100_PREPAID",
  LIAB_WEAVER_PAYABLE: "LIAB_WEAVER_PAYABLE",
  LIAB_YARN_POOL: "LIAB_YARN_POOL",
  LIAB_WEAVER_DEPOSIT: "LIAB_WEAVER_DEPOSIT",
  LIAB_CREATOR_PAYABLE: "LIAB_CREATOR_PAYABLE",
  LIAB_SUPPLIER_PAYABLE: "LIAB_SUPPLIER_PAYABLE",
  REV_PRODUCT_SALES: "REV_PRODUCT_SALES",
  EXP_CRAFT_COST: "EXP_CRAFT_COST",
  EXP_MATERIAL_COST: "EXP_MATERIAL_COST",
  EXP_SHIPPING_PLATFORM: "EXP_SHIPPING_PLATFORM",
  EXP_PAYMENT_FEE: "EXP_PAYMENT_FEE",
  EXP_LOSS_COMP: "EXP_LOSS_COMP",
} as const;

export type LedgerAccountCode = (typeof LEDGER_ACCOUNT_CODES)[keyof typeof LEDGER_ACCOUNT_CODES];

export interface LedgerAccountDoc {
  _id: LedgerAccountCode;
  name: string;
  category: "asset" | "liability" | "equity" | "revenue" | "expense";
  normalSide: "debit" | "credit";
}

export interface LedgerLine {
  accountCode: LedgerAccountCode;
  subAccountId?: string; // e.g., weaverId for LIAB_YARN_POOL / LIAB_WEAVER_PAYABLE / LIAB_WEAVER_DEPOSIT
  debitFen: Fen;
  creditFen: Fen;
}

// 23) ledgerEntries — immutable double-entry fact table
export interface LedgerEntryDoc {
  _id: string; // deterministic idempotency key
  eventType:
    | "mp_pay"
    | "pay_fee"
    | "pkg_accrue"
    | "yarn_out"
    | "yarn_refund"
    | "deposit_in"
    | "deposit_out"
    | "quality_refund"
    | "loss_comp"
    | "payout"
    | "adjustment";
  bizId: string;
  payeeId?: string;
  settlementBatchId?: string;
  lines: LedgerLine[];
  memo: string;
  createdAt: number;
}

// 24) weaverAccounts — atomic balance concurrency gatekeeper
export interface WeaverAccountDoc {
  _id: string; // acc_${userId}
  userId: string;
  yarnPoolBalanceFen: Fen;
  payableBalanceFen: Fen;
  depositFen: Fen;
  version: number;
  updatedAt: number;
}

// 25) styleEnrollments — Craft-KOL special-material limited enrollment seam
export interface StyleEnrollmentDoc {
  _id: string; // enroll_${skuCode}_${weaverId}
  skuCode: string;
  weaverId: string;
  creatorUserId: string;
  status: "applied" | "materials_ready" | "certified" | "revoked";
  certifiedBy?: string;
  certifiedAt?: number;
  createdAt: number;
}
