import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALL_COLLECTION_NAMES,
  COLLECTIONS,
  DAY_MS,
  HOUR_MS,
  ZERO_FEN,
  asFen,
  type AddressDoc,
  type BagStickerDoc,
  type CollectionName,
  type OrderDoc,
  type OrderPackageDoc,
  type PatternDoc,
  type PhotoReviewDoc,
  type ProductDoc,
  type RecruitFunnelDoc,
  type StyleDoc,
  type SystemConfigDoc,
  type UserDoc,
  type WeaverStockDoc,
  type YarnCatalogDoc,
  type YarnClaimDoc,
} from "@wxtz/shared";
import {
  InMemoryDb,
  accrueSettledPackage,
  bagStickerId,
  createMockExternalPorts,
  dispatchCloudAction,
  recordWeaverDeposit,
  recruitFunnelId,
  signAdminJwt,
  weaverStockId,
  yarnClaimId,
} from "@wxtz/cloud";

const REPO_ROOT = process.cwd();
const ADMIN_DIR = path.join(REPO_ROOT, "packages/admin");
const DATA_DIR = path.join(REPO_ROOT, ".local-dev");
const DB_FILE = path.join(DATA_DIR, "db.json");

function parseArgs(argv: string[]): { port: number; reset: boolean; host: string } {
  let port = Number(process.env.WXTZ_DEV_PORT ?? 3880);
  let reset = false;
  let host = process.env.WXTZ_DEV_HOST ?? "0.0.0.0";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") {
      reset = true;
    } else if (a === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (a === "--host" && argv[i + 1]) {
      host = argv[++i];
    }
  }
  return { port, reset, host };
}

const { port: PORT, reset: FORCE_RESET, host: HOST } = parseArgs(process.argv.slice(2));
const JWT_SECRET = "wxtz-local-dev-jwt-secret-2026-min32chars";

let db = new InMemoryDb();
let ports = createMockExternalPorts();
let adminToken = "";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function getLanIpv4(): string | null {
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return null;
}

async function persistDbAtomic(): Promise<Record<string, number>> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const collections: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const col of ALL_COLLECTION_NAMES) {
    const docs = await db.find(col as CollectionName, () => true);
    collections[col] = docs;
    counts[col] = docs.length;
  }
  const tmpFile = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmpFile,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        counts,
        collections,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.renameSync(tmpFile, DB_FILE);
  return counts;
}

async function hydrateDbFromDisk(): Promise<boolean> {
  if (!fs.existsSync(DB_FILE)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as {
      collections?: Record<string, Array<{ _id: string }>>;
    };
    if (!raw?.collections || typeof raw.collections !== "object") return false;
    db = new InMemoryDb();
    for (const col of ALL_COLLECTION_NAMES) {
      const docs = raw.collections[col] ?? [];
      for (const doc of docs) {
        if (doc && typeof doc._id === "string") {
          await db.put(col as CollectionName, doc as any);
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function seedLocalDevBaseline(): Promise<void> {
  const now = Date.now();
  db = new InMemoryDb();
  ports = createMockExternalPorts();

  await db.put<SystemConfigDoc>(COLLECTIONS.SYSTEM_CONFIG, {
    _id: "recruit",
    activeRecruitRegions: ["jzh"],
    updatedAt: now,
  });

  const yarns: YarnCatalogDoc[] = [
    {
      _id: "YARN-WHITE-01",
      name: "奶白4股棉",
      brand: "江南线厂",
      itemType: "yarn",
      isBase12: true,
      isMaterialPack: false,
      unitWeightG: 50,
      unitCostFen: asFen(400),
      supplierId: "SUP_JZH_01",
      supplierSkuCode: "JZH-4P-001",
      status: "active",
    },
    {
      _id: "YARN-PINK-02",
      name: "樱花粉4股棉",
      brand: "江南线厂",
      itemType: "yarn",
      isBase12: true,
      isMaterialPack: false,
      unitWeightG: 50,
      unitCostFen: asFen(420),
      supplierId: "SUP_JZH_01",
      supplierSkuCode: "JZH-4P-002",
      status: "active",
    },
  ];
  for (const y of yarns) await db.put(COLLECTIONS.YARN_CATALOG, y);

  const patterns: PatternDoc[] = [
    {
      _id: "pat_sasa_01",
      skuCode: "TZ-SASA-01",
      version: 1,
      parts: [
        {
          partName: "主体",
          steps: [
            { rowNo: 1, text: "奶白 环起 6X", stitchCount: 6 },
            { rowNo: 2, text: "6V（共 12 针）", stitchCount: 12 },
            { rowNo: 3, text: "隔一加一（X, V）×6（共 18 针）", stitchCount: 18 },
            { rowNo: 4, text: "不加不减 18X，塞棉收口留长线", stitchCount: 18 },
          ],
        },
        {
          partName: "腮红与挂绳",
          steps: [
            { rowNo: 1, text: "樱花粉 锁针 18CH 做顶部挂绳", stitchCount: 18 },
            { rowNo: 2, text: "缝合双耳并粘贴安全豆豆眼", stitchCount: 4 },
          ],
        },
      ],
      authorUserId: "usr_admin_local",
      status: "approved",
      updatedAt: now,
    },
    {
      _id: "pat_papa_01",
      skuCode: "TZ-PAPA-01",
      version: 1,
      parts: [
        {
          partName: "主体",
          steps: [
            { rowNo: 1, text: "樱花粉 环起 6X", stitchCount: 6 },
            { rowNo: 2, text: "6V（共 12 针）", stitchCount: 12 },
          ],
        },
      ],
      authorUserId: "usr_admin_local",
      status: "approved",
      updatedAt: now,
    },
  ];
  for (const p of patterns) await db.put(COLLECTIONS.PATTERNS, p);

  const styles: StyleDoc[] = [
    {
      _id: "TZ-SASA-01",
      name: "天真宝宝·sasa 挂件",
      riskClass: "core",
      standardMin: 90,
      patternId: "pat_sasa_01",
      yarnBom: [
        { yarnCode: "YARN-WHITE-01", netWeightG: 20 },
        { yarnCode: "YARN-PINK-02", netWeightG: 10 },
      ],
      wasteRateBp: 1000,
      extraAccessoryCostFen: asFen(50),
      materialCostFen: asFen(319),
      yarnPoolAccrualFen: asFen(400),
      craftFeeFen: asFen(2800),
      weaverShipShareFen: asFen(300),
      ownerType: "platform",
      qcOwner: "volunteer_or_admin",
      royaltyFen: ZERO_FEN,
      creatorQcFeeFen: ZERO_FEN,
      trafficCommissionBp: 0,
      requiresEnrollment: false,
      status: "active",
    },
    {
      _id: "TZ-PAPA-01",
      name: "天真宝宝·papa 桌面摆件",
      riskClass: "core",
      standardMin: 110,
      patternId: "pat_papa_01",
      yarnBom: [{ yarnCode: "YARN-PINK-02", netWeightG: 25 }],
      wasteRateBp: 1000,
      extraAccessoryCostFen: asFen(50),
      materialCostFen: asFen(281),
      yarnPoolAccrualFen: asFen(350),
      craftFeeFen: asFen(3200),
      weaverShipShareFen: asFen(300),
      ownerType: "platform",
      qcOwner: "volunteer_or_admin",
      royaltyFen: ZERO_FEN,
      creatorQcFeeFen: ZERO_FEN,
      trafficCommissionBp: 0,
      requiresEnrollment: false,
      status: "active",
    },
  ];
  for (const s of styles) await db.put(COLLECTIONS.STYLES, s);

  const products: ProductDoc[] = [
    {
      _id: "prod_sasa_ready",
      skuCode: "TZ-SASA-01",
      saleType: "ready_stock",
      title: "天真宝宝·sasa（48h现货闪发）",
      coverFileIds: ["cloud://local/sasa_cover.jpg"],
      detailFileIds: ["cloud://local/sasa_detail.jpg"],
      priceFen: asFen(5800),
      buyerShipFeeFen: ZERO_FEN,
      etaText: "48小时内闪发",
      sortOrder: 1,
      isOnSale: true,
      updatedAt: now,
    },
    {
      _id: "prod_sasa_mto",
      skuCode: "TZ-SASA-01",
      saleType: "made_to_order",
      title: "天真宝宝·sasa（手艺人现钩）",
      coverFileIds: ["cloud://local/sasa_cover.jpg"],
      detailFileIds: ["cloud://local/sasa_detail.jpg"],
      priceFen: asFen(5800),
      buyerShipFeeFen: ZERO_FEN,
      etaText: "3-5天发出",
      sortOrder: 2,
      isOnSale: true,
      updatedAt: now,
    },
    {
      _id: "prod_papa_mto",
      skuCode: "TZ-PAPA-01",
      saleType: "made_to_order",
      title: "天真宝宝·papa（桌面摆件）",
      coverFileIds: ["cloud://local/papa_cover.jpg"],
      detailFileIds: ["cloud://local/papa_detail.jpg"],
      priceFen: asFen(6800),
      buyerShipFeeFen: ZERO_FEN,
      etaText: "3-5天发出",
      sortOrder: 3,
      isOnSale: true,
      updatedAt: now,
    },
  ];
  for (const p of products) await db.put(COLLECTIONS.PRODUCTS, p);

  const users: UserDoc[] = [
    {
      _id: "usr_w_live_01",
      phone: "13800001111",
      weaverOpenid: "oid_w_live_01",
      nickname: "林织巧（演示织女）",
      roles: ["weaver"],
      pool: "live",
      weaverNo: "WV-JZH-001",
      funnelStage: "approved",
      regionCode: "jzh",
      cityQuotaKey: "浙江省-嘉兴市",
      acceptingOrders: true,
      dailyCapacityMin: 360,
      speedFactor: 1.0,
      creditScore: 120,
      consecutiveTimeouts: 0,
      shippingMode: "auto_pickup",
      doudianAddressAlias: "嘉兴林织巧",
      verifyLevel: "payee",
      realName: "林织巧",
      bankCardEncrypted: "6214830012348821",
      yarnInventory: {
        "YARN-WHITE-01": { wholeSkeins: 3, usedSinceCheckG: 10, needCheck: false, status: "ok" },
        "YARN-PINK-02": { wholeSkeins: 2, usedSinceCheckG: 5, needCheck: false, status: "ok" },
      },
      createdAt: now - 30 * DAY_MS,
      updatedAt: now,
    },
    {
      _id: "usr_w_mp_02",
      phone: "13800002222",
      weaverOpenid: "oid_w_mp_02",
      nickname: "沈巧手（演示织女2）",
      roles: ["weaver"],
      pool: "mp",
      weaverNo: "WV-JZH-002",
      funnelStage: "approved",
      regionCode: "jzh",
      cityQuotaKey: "江苏省-苏州市",
      acceptingOrders: true,
      dailyCapacityMin: 300,
      speedFactor: 1.0,
      creditScore: 105,
      consecutiveTimeouts: 0,
      shippingMode: "auto_pickup",
      doudianAddressAlias: "苏州沈巧手",
      verifyLevel: "payee",
      realName: "沈巧手",
      bankCardEncrypted: "6214830099990002",
      yarnInventory: {
        "YARN-WHITE-01": { wholeSkeins: 2, usedSinceCheckG: 0, needCheck: false, status: "ok" },
        "YARN-PINK-02": { wholeSkeins: 2, usedSinceCheckG: 0, needCheck: false, status: "ok" },
      },
      createdAt: now - 20 * DAY_MS,
      updatedAt: now,
    },
    {
      _id: "usr_b_demo_01",
      phone: "13955556666",
      buyerOpenid: "oid_b_demo_01",
      nickname: "陈买家（演示买家与志愿者）",
      roles: ["buyer", "volunteer"],
      funnelStage: "none",
      acceptingOrders: false,
      dailyCapacityMin: 0,
      speedFactor: 1.0,
      creditScore: 100,
      consecutiveTimeouts: 0,
      verifyLevel: "none",
      yarnInventory: {},
      createdAt: now - 10 * DAY_MS,
      updatedAt: now,
    },
    {
      _id: "usr_hz_candidate_01",
      phone: "13900008888",
      weaverOpenid: "oid_w_cand_01",
      nickname: "周新织女",
      roles: ["weaver"],
      funnelStage: "pending_deposit",
      regionCode: "jzh",
      cityQuotaKey: "浙江省-杭州市",
      acceptingOrders: false,
      dailyCapacityMin: 240,
      speedFactor: 1.0,
      creditScore: 100,
      consecutiveTimeouts: 0,
      verifyLevel: "none",
      yarnInventory: {},
      createdAt: now - 3 * DAY_MS,
      updatedAt: now,
    },
  ];
  for (const u of users) await db.put(COLLECTIONS.USERS, u);

  const addresses: AddressDoc[] = [
    {
      _id: "addr_w_live_01",
      ownerUserId: "usr_w_live_01",
      type: "weaver_ship",
      contactName: "林织巧",
      contactPhone: "13800001111",
      province: "浙江省",
      city: "嘉兴市",
      district: "南湖区",
      detail: "凌公塘路 88 号",
      isDefault: true,
      updatedAt: now,
    },
    {
      _id: "addr_w_mp_02",
      ownerUserId: "usr_w_mp_02",
      type: "weaver_ship",
      contactName: "沈巧手",
      contactPhone: "13800002222",
      province: "江苏省",
      city: "苏州市",
      district: "吴中区",
      detail: "东吴北路 66 号",
      isDefault: true,
      updatedAt: now,
    },
    {
      _id: "addr_b_demo_01",
      ownerUserId: "usr_b_demo_01",
      type: "buyer_recv",
      contactName: "陈买家",
      contactPhone: "13955556666",
      province: "浙江省",
      city: "杭州市",
      district: "西湖区",
      detail: "文三路 99 号",
      isDefault: true,
      updatedAt: now,
    },
  ];
  for (const a of addresses) await db.put(COLLECTIONS.ADDRESSES, a);

  await recordWeaverDeposit(db, "usr_w_live_01", undefined, now - 30 * DAY_MS);
  await recordWeaverDeposit(db, "usr_w_mp_02", undefined, now - 20 * DAY_MS);

  await db.put<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, {
    _id: recruitFunnelId("usr_hz_candidate_01"),
    userId: "usr_hz_candidate_01",
    stage: "pending_deposit",
    regionCheckPassed: true,
    quizAttempts: 1,
    portfolioAttempts: 1,
    trialAttempts: 1,
    sampleAttempts: 1,
    depositStatus: "unpaid",
    depositAmountFen: asFen(20000),
    samplePassedAt: now - DAY_MS,
    version: 4,
    updatedAt: now,
  });

  await db.put<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, {
    _id: weaverStockId("usr_w_live_01", "TZ-SASA-01"),
    weaverId: "usr_w_live_01",
    skuCode: "TZ-SASA-01",
    availableQty: 2,
    reservedQty: 0,
    reservations: [],
    items: [
      { sourceType: "cancelled_order", createdAt: now - 2 * DAY_MS },
      { sourceType: "cancelled_order", createdAt: now - DAY_MS },
    ],
    oldestCreatedAt: now - 2 * DAY_MS,
    version: 1,
    updatedAt: now,
  });
  await db.put<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, {
    _id: weaverStockId("usr_w_mp_02", "TZ-SASA-01"),
    weaverId: "usr_w_mp_02",
    skuCode: "TZ-SASA-01",
    availableQty: 1,
    reservedQty: 0,
    reservations: [],
    items: [{ sourceType: "cancelled_order", createdAt: now - DAY_MS }],
    oldestCreatedAt: now - DAY_MS,
    version: 1,
    updatedAt: now,
  });

  const stickers: BagStickerDoc[] = [
    { _id: bagStickerId("BAG-DEV-001"), weaverId: "usr_w_live_01", batchId: "BATCH_DEV_01", status: "unused", createdAt: now },
    { _id: bagStickerId("BAG-DEV-002"), weaverId: "usr_w_live_01", batchId: "BATCH_DEV_01", status: "unused", createdAt: now },
    { _id: bagStickerId("BAG-DEV-003"), weaverId: "usr_w_live_01", batchId: "BATCH_DEV_01", status: "unused", createdAt: now },
    { _id: bagStickerId("BAG-DEV-004"), weaverId: "usr_w_mp_02", batchId: "BATCH_DEV_01", status: "unused", createdAt: now },
  ];
  for (const stk of stickers) await db.put(COLLECTIONS.BAG_STICKERS, stk);

  const sasaSnap = [
    {
      skuCode: "TZ-SASA-01",
      skuName: "天真宝宝·sasa 挂件",
      qty: 1,
      standardMin: 90,
      yarnBomSnapshot: [
        { yarnCode: "YARN-WHITE-01", consumedG: 22 },
        { yarnCode: "YARN-PINK-02", consumedG: 11 },
      ],
      materialCostFen: asFen(319),
      craftFeeFen: asFen(2800),
      yarnPoolAccrualFen: asFen(400),
      weaverShipShareFen: asFen(300),
      saleType: "made_to_order" as const,
    },
  ];

  // Give weaver usr_w_live_01 one active head-of-queue making package so Lyric Pattern Companion works immediately!
  await db.put<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_making_demo_01",
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: ["ord_making_demo_01"],
    externalOrderIds: [],
    buyerUserId: "usr_b_demo_01",
    buyerProvince: "浙江省",
    buyerCity: "杭州市",
    itemsSnapshot: sasaSnap,
    totalMin: 90,
    status: "making",
    assignedWeaverId: "usr_w_live_01",
    queueSeq: 1,
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    dispatchableAt: now - 3 * HOUR_MS,
    acceptedAt: now - 2 * HOUR_MS,
    lastProgressAt: now - HOUR_MS,
    dueAt: now + 3 * DAY_MS,
    version: 2,
    updatedAt: now,
  });

  await db.put<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_ready_seed_01",
    channel: "douyin_online",
    poolTarget: "live",
    orderIds: ["ord_seed_ready_01"],
    externalOrderIds: ["DY_SEED_READY_01"],
    buyerProvince: "浙江省",
    buyerCity: "杭州市",
    itemsSnapshot: sasaSnap,
    totalMin: 90,
    status: "ready_to_ship",
    assignedWeaverId: "usr_w_live_01",
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    bagQrCode: "BAG-SEED-READY-01",
    dispatchableAt: now - 6 * HOUR_MS,
    version: 3,
    updatedAt: now,
  });

  await db.put<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_hold_seed_01",
    channel: "douyin_online",
    poolTarget: "live",
    orderIds: ["ord_seed_hold_01"],
    externalOrderIds: ["DY_SEED_HOLD_01"],
    buyerProvince: "上海市",
    buyerCity: "上海市",
    itemsSnapshot: sasaSnap,
    totalMin: 90,
    status: "manual_hold",
    isReadyStockReuse: false,
    attemptCount: 3,
    reviewMode: "required",
    dispatchableAt: now - 2 * DAY_MS,
    version: 4,
    updatedAt: now,
  });

  await db.put<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_review_seed_01",
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: ["ord_seed_rev_01"],
    externalOrderIds: [],
    buyerProvince: "江苏省",
    buyerCity: "南京市",
    itemsSnapshot: sasaSnap,
    totalMin: 90,
    status: "photo_review",
    assignedWeaverId: "usr_w_mp_02",
    queueSeq: 1,
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    dispatchableAt: now - DAY_MS,
    version: 2,
    updatedAt: now,
  });

  await db.put<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, {
    _id: "rev_sla_seed_01",
    scene: "order_finish",
    targetId: "pkg_review_seed_01",
    weaverId: "usr_w_mp_02",
    photoFileIds: [
      "cloud://local/front.jpg",
      "cloud://local/back.jpg",
      "cloud://local/side.jpg",
    ],
    imageHashes: ["hash_dev_01"],
    duplicateFlag: false,
    isCalibrationSample: false,
    requiredVotes: 5,
    slaDeadlineAt: now - HOUR_MS,
    voteCount: 1,
    status: "needs_admin",
    version: 2,
    createdAt: now - 3 * HOUR_MS,
  });

  // Also seed a pending volunteer blind review card so mp-buyer volunteer page can test 8s review!
  await db.put<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, {
    _id: "rev_vol_demo_01",
    scene: "order_finish",
    targetId: "pkg_making_demo_01",
    weaverId: "usr_w_live_01",
    photoFileIds: [
      "cloud://local/vol_front.jpg",
      "cloud://local/vol_back.jpg",
      "cloud://local/vol_side.jpg",
    ],
    imageHashes: ["hash_vol_01"],
    duplicateFlag: false,
    isCalibrationSample: false,
    requiredVotes: 5,
    slaDeadlineAt: now + 2 * HOUR_MS,
    voteCount: 0,
    status: "pending",
    version: 1,
    createdAt: now - 5 * 60_000,
  });

  await db.put<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_settled_seed_01",
    channel: "mp_wechat",
    poolTarget: "live",
    orderIds: ["ord_seed_settled_01"],
    externalOrderIds: [],
    buyerProvince: "浙江省",
    buyerCity: "宁波市",
    itemsSnapshot: sasaSnap,
    totalMin: 90,
    status: "settled_ready",
    assignedWeaverId: "usr_w_live_01",
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    dispatchableAt: now - 10 * DAY_MS,
    signedAt: now - 8 * DAY_MS,
    settleEligibleAt: now - DAY_MS,
    version: 5,
    updatedAt: now - DAY_MS,
  });

  await accrueSettledPackage(db, {
    packageId: "pkg_settled_seed_01",
    weaverId: "usr_w_live_01",
    craftFeeFen: asFen(2800),
    weaverShipShareFen: asFen(300),
    yarnPoolAccrualFen: asFen(400),
    nowUtcMs: now - DAY_MS,
  });

  await db.put<YarnClaimDoc>(COLLECTIONS.YARN_CLAIMS, {
    _id: yarnClaimId("usr_w_live_01", "2026W48"),
    weaverId: "usr_w_live_01",
    weekKey: "2026W48",
    items: [
      { yarnCode: "YARN-WHITE-01", supplierSkuCode: "JZH-4P-001", qty: 3, unitCostFen: asFen(400) },
    ],
    totalSkeins: 3,
    materialsCostFen: asFen(1200),
    shippingFeeFen: asFen(250),
    totalDeductionFen: asFen(1450),
    receiverAddressId: "addr_w_live_01",
    status: "confirmed",
    version: 2,
    createdAt: now - DAY_MS,
    updatedAt: now,
  });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function renderDevPanelHtml(lanIp: string | null): string {
  const lanHint = lanIp ? `http://${lanIp}:${PORT}/wxtz-api` : "未检测到局域网 IP";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>无限天真 · 本机三端联调控制台</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #faf7f2; color: #2b2520; margin: 0; padding: 24px; }
    .wrap { max-width: 980px; margin: 0 auto; display: grid; gap: 16px; }
    .card { background: #fff; border: 1px solid #e7dfd5; border-radius: 12px; padding: 18px; }
    h1 { margin: 0 0 6px; font-size: 20px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    .muted { color: #756b62; font-size: 13px; margin: 0 0 12px; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    button { background: #c96846; color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
    button.ghost { background: #f2ebe1; color: #3c342d; }
    button.danger { background: #b53a32; }
    input, select { border: 1px solid #d9cfc3; border-radius: 8px; padding: 7px 10px; font-size: 13px; }
    pre { background: #1e1b18; color: #f1ebe3; padding: 12px; border-radius: 8px; font-size: 12px; overflow: auto; max-height: 280px; }
    code { background: #f2ebe1; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    a { color: #c96846; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>无限天真 · 本机三端联调模拟器</h1>
      <p class="muted">持久化数据文件：<code>.local-dev/db.json</code> | <a href="/">运营总控台 (packages/admin)</a> | <a href="/design/weaver-funnel">织女筛选原型 (Arena 终版)</a></p>
      <div class="row">
        <span>本机 API：<code>http://127.0.0.1:${PORT}/wxtz-api</code></span>
        <span>手机真机局域网 API：<code>${lanHint}</code></span>
      </div>
    </div>

    <div class="card">
      <h2>1. 手动触发定时任务（Cron）</h2>
      <div class="row">
        <button onclick="runCron('cron.dispatchTick')">整点派单 (dispatchTick)</button>
        <button onclick="runCron('cron.fiveMinuteWatchdog')">5分钟巡检 (watchdog)</button>
        <button onclick="runCron('cron.dailySettleAndReconcile')">每日结款与账本对账</button>
        <button onclick="runCron('cron.dailyDueAndStockAlert')">09:00 临期与免税预警</button>
        <button onclick="runCron('cron.weeklyGovernance')">周一招募阀门与现金流</button>
      </div>
    </div>

    <div class="card">
      <h2>2. 模拟外部回调（微信支付 / 快递100）</h2>
      <div class="row" style="margin-bottom:10px">
        <input id="wxOrderId" placeholder="输入待支付 orderId 或 DEP_xxx" style="width:260px" />
        <button onclick="simWxPay()">模拟微信支付成功 (webhook.wxpay)</button>
      </div>
      <div class="row">
        <input id="kdPkgId" placeholder="输入待发货/已发货 packageId" style="width:220px" />
        <select id="kdState">
          <option value="picked_up">picked_up (已揽收)</option>
          <option value="signed">signed (已签收)</option>
          <option value="pickup_failed">pickup_failed (取件失败)</option>
          <option value="lost">lost (丢件)</option>
        </select>
        <button onclick="simKd100()">触发快递100回调</button>
      </div>
    </div>

    <div class="card">
      <h2>3. 实时库状态与一键重置</h2>
      <div class="row" style="margin-bottom:10px">
        <button class="ghost" onclick="refreshState()">刷新数据库摘要</button>
        <button class="danger" onclick="resetDb()">重置全部测试种子数据</button>
      </div>
      <pre id="out">点击上方按钮开始本机联调...</pre>
    </div>
  </div>
  <script>
    const out = document.getElementById("out");
    async function postJson(url, body) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      const j = await r.json();
      out.textContent = JSON.stringify(j, null, 2);
      return j;
    }
    async function runCron(action) { await postJson("/__dev/cron", { action }); }
    async function simWxPay() {
      const orderId = document.getElementById("wxOrderId").value.trim();
      if (!orderId) { out.textContent = "请先填写 orderId"; return; }
      await postJson("/__dev/simulate-wxpay", { orderId });
    }
    async function simKd100() {
      const packageId = document.getElementById("kdPkgId").value.trim();
      const state = document.getElementById("kdState").value;
      if (!packageId) { out.textContent = "请先填写 packageId"; return; }
      await postJson("/__dev/simulate-kuaidi100", { packageId, state });
    }
    async function refreshState() {
      const r = await fetch("/__dev/state");
      out.textContent = JSON.stringify(await r.json(), null, 2);
    }
    async function resetDb() {
      if (!confirm("确认清空并重建本机测试种子数据？")) return;
      await postJson("/__dev/reset", {});
    }
    refreshState();
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const hydrated = !FORCE_RESET && (await hydrateDbFromDisk());
  if (!hydrated) {
    await seedLocalDevBaseline();
  }
  await persistDbAtomic();

  adminToken = signAdminJwt(
    { sub: "usr_admin_local", role: "admin", exp: Date.now() + 30 * DAY_MS },
    JWT_SECRET,
  );
  const lanIp = getLanIpv4();

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/dev") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDevPanelHtml(lanIp));
      return;
    }

    if (req.method === "GET" && (url.pathname === "/design/weaver-funnel" || url.pathname === "/design/weaver-funnel-prototype.html")) {
      const protoFile = path.join(REPO_ROOT, "design/weaver-funnel-prototype.html");
      if (fs.existsSync(protoFile)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(protoFile).pipe(res);
        return;
      }
    }

    if (req.method === "GET" && (url.pathname === "/design/weaver-funnel-v2" || url.pathname === "/design/weaver-funnel-prototype-v2.html")) {
      const protoV2File = path.join(REPO_ROOT, "design/weaver-funnel-prototype-v2.html");
      if (fs.existsSync(protoV2File)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(protoV2File).pipe(res);
        return;
      }
    }

    if (req.method === "GET" && (url.pathname === "/design/weaver-funnel-v3" || url.pathname === "/design/weaver-funnel-prototype-v3.html")) {
      const protoV3File = path.join(REPO_ROOT, "design/weaver-funnel-prototype-v3.html");
      if (fs.existsSync(protoV3File)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(protoV3File).pipe(res);
        return;
      }
    }

    if (req.method === "GET" && url.pathname.startsWith("/design/")) {
      const safeName = path.basename(url.pathname);
      const ext = path.extname(safeName) || ".html";
      const candidate = path.join(REPO_ROOT, "design", path.extname(safeName) ? safeName : `${safeName}.html`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/html; charset=utf-8" });
        fs.createReadStream(candidate).pipe(res);
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/__dev/bootstrap") {
      const counts = await persistDbAtomic();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          mode: "local-dev",
          apiUrl: `http://127.0.0.1:${PORT}/wxtz-api`,
          lanApiUrl: lanIp ? `http://${lanIp}:${PORT}/wxtz-api` : null,
          devPanelUrl: `http://127.0.0.1:${PORT}/dev`,
          adminToken,
          demoAccounts: {
            weaverPrimary: { userId: "usr_w_live_01", openid: "oid_w_live_01", weaverNo: "WV-JZH-001" },
            weaverSecond: { userId: "usr_w_mp_02", openid: "oid_w_mp_02", weaverNo: "WV-JZH-002" },
            buyerAndVolunteer: { userId: "usr_b_demo_01", openid: "oid_b_demo_01", phone: "13955556666" },
          },
          counts,
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/__dev/state") {
      const [orders, pkgs, reviews, counts] = await Promise.all([
        db.find<OrderDoc>(COLLECTIONS.ORDERS, () => true),
        db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, () => true),
        db.find<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, () => true),
        persistDbAtomic(),
      ]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          counts,
          recentOrders: orders.slice(-10).map((o) => ({ _id: o._id, status: o.status, totalPaidFen: o.totalPaidFen })),
          packages: pkgs.map((p) => ({
            _id: p._id,
            status: p.status,
            assignedWeaverId: p.assignedWeaverId,
            queueSeq: p.queueSeq,
          })),
          reviews: reviews.map((r) => ({ _id: r._id, targetId: r.targetId, status: r.status, voteCount: r.voteCount })),
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/__dev/simulate-wxpay") {
      try {
        const body = await readJsonBody(req);
        const orderId = String(body.orderId ?? "").trim();
        const apiRes = await dispatchCloudAction(
          { db, ports, invocationSource: "internal", adminJwtSecret: JWT_SECRET, nowUtcMs: Date.now() },
          "webhook.wxpay",
          { orderId, wxTransactionId: `WX_LOCAL_${Date.now()}` },
        );
        await persistDbAtomic();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(apiRes));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: err?.message ?? String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/__dev/simulate-kuaidi100") {
      try {
        const body = await readJsonBody(req);
        const apiRes = await dispatchCloudAction(
          { db, ports, invocationSource: "internal", adminJwtSecret: JWT_SECRET, nowUtcMs: Date.now() },
          "webhook.kuaidi100",
          {
            packageId: String(body.packageId ?? "").trim(),
            state: String(body.state ?? "picked_up"),
            trackingNo: body.trackingNo ? String(body.trackingNo) : `ZT_LOCAL_${Date.now()}`,
            shippingCostFen: body.shippingCostFen !== undefined ? Number(body.shippingCostFen) : 550,
          },
        );
        await persistDbAtomic();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(apiRes));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: err?.message ?? String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/__dev/cron") {
      try {
        const body = await readJsonBody(req);
        const action = String(body.action ?? "");
        const apiRes = await dispatchCloudAction(
          { db, ports, invocationSource: "timer", adminJwtSecret: JWT_SECRET, nowUtcMs: Date.now() },
          action,
          body.payload ?? {},
        );
        await persistDbAtomic();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(apiRes));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: err?.message ?? String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/__dev/reset") {
      await seedLocalDevBaseline();
      const counts = await persistDbAtomic();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, reset: true, counts }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/wxtz-api") {
      try {
        const body = await readJsonBody(req);
        const action = String(body.action ?? "");
        const authHeader = req.headers.authorization;
        const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
        const token = body.adminToken ?? bearer;

        const apiRes = await dispatchCloudAction(
          {
            db,
            ports,
            app: body.app,
            openid: body.openid,
            unionid: body.unionid,
            invocationSource: body.openid ? "mp_client" : "http_gateway",
            adminJwtSecret: JWT_SECRET,
            adminToken: token,
            nowUtcMs: typeof body.nowUtcMs === "number" ? body.nowUtcMs : Date.now(),
          },
          action,
          body.payload ?? {},
        );
        await persistDbAtomic();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(apiRes));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, code: "LOCAL_DEV_ERROR", message: err?.message ?? String(err) }));
      }
      return;
    }

    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const target = path.resolve(ADMIN_DIR, rel);
      if (target.startsWith(ADMIN_DIR) && fs.existsSync(target) && fs.statSync(target).isFile()) {
        const ext = path.extname(target);
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        fs.createReadStream(target).pipe(res);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, code: "NOT_FOUND", message: `Unknown route ${req.method} ${url.pathname}` }));
  });

  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
    console.log("");
    console.log("[wxtz-local-dev] 本机三端持久联调服务已启动");
    console.log(`  运营总控台 (浏览器打开) : http://127.0.0.1:${actualPort}/`);
    console.log(`  本机模拟控制台 (Cron/回调): http://127.0.0.1:${actualPort}/dev`);
    console.log(`  小程序本地 API (电脑模拟器): http://127.0.0.1:${actualPort}/wxtz-api`);
    if (lanIp) {
      console.log(`  小程序局域网 API (手机真机): http://${lanIp}:${actualPort}/wxtz-api`);
    }
    console.log(`  持久化数据库文件          : ${DB_FILE} (${hydrated ? "已加载历史数据" : "已初始化演示种子"})`);
    console.log("");
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[wxtz-local-dev] Fatal:", err);
  process.exit(1);
});
