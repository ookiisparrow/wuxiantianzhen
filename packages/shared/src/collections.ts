/**
 * Single source of truth for all CloudBase collection names.
 * Mirrors docs/07 §3 (25 core collections + 4 system collections).
 */
export const COLLECTIONS = {
  // 3.1 账号、地址、准入漏斗与志愿者 (4)
  USERS: "users",
  ADDRESSES: "addresses",
  RECRUIT_FUNNEL: "recruitFunnel",
  VOLUNTEERS: "volunteers",

  // 3.2 款式、商品、图解、可拼装部件与余货 (5)
  STYLES: "styles",
  PRODUCTS: "products",
  PATTERNS: "patterns",
  PATTERN_MODULES: "patternModules",
  WEAVER_STOCK: "weaverStock",

  // 3.3 订单、派单、质检与物流 (7)
  ORDERS: "orders",
  ORDER_PACKAGES: "orderPackages",
  EXTERNAL_ORDER_INDEX: "externalOrderIndex",
  DISPATCH_OFFERS: "dispatchOffers",
  PHOTO_REVIEWS: "photoReviews",
  VOLUNTEER_VOTES: "volunteerVotes",
  SHIPMENTS: "shipments",

  // 3.4 支付、退款与工单 (3)
  PAYMENTS: "payments",
  REFUNDS: "refunds",
  TICKETS: "tickets",

  // 3.5 线材、袋码、复式账本与博主报名 (7)
  YARN_CATALOG: "yarnCatalog",
  YARN_CLAIMS: "yarnClaims",
  BAG_STICKERS: "bagStickers",
  LEDGER_ACCOUNTS: "ledgerAccounts",
  LEDGER_ENTRIES: "ledgerEntries",
  WEAVER_ACCOUNTS: "weaverAccounts",
  STYLE_ENROLLMENTS: "styleEnrollments",

  // 系统支撑集合 (4)
  SETTLEMENT_BATCHES: "settlementBatches",
  NOTIFICATIONS: "notifications",
  AUDIT_LOG: "auditLog",
  CONFIG: "config",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export const ALL_COLLECTION_NAMES: readonly CollectionName[] = Object.values(COLLECTIONS);
