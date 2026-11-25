import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  COLLECTIONS,
  DAY_MS,
  HOUR_MS,
  ZERO_FEN,
  asFen,
  type AddressDoc,
  type CollectionName,
  type OrderPackageDoc,
  type PatternDoc,
  type PhotoReviewDoc,
  type ProductDoc,
  type RecruitFunnelDoc,
  type StyleDoc,
  type UserDoc,
  type WeaverStockDoc,
  type YarnCatalogDoc,
} from "@wxtz/shared";
import {
  InMemoryDb,
  accrueSettledPackage,
  createMockExternalPorts,
  dispatchCloudAction,
  recruitFunnelId,
  signAdminJwt,
  submitWeeklyYarnClaim,
  weaverStockId,
} from "@wxtz/cloud";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const ADMIN_ROOT = path.join(REPO_ROOT, "packages/admin");

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]!;
    if (cur.startsWith("--")) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const portArg = Number(args.port ?? 4310);
const dataDir = path.resolve(args["data-dir"] ?? "/tmp/wxtz-verify-default");
const runId = args["run-id"] ?? "default";
const jwtSecret = args["jwt-secret"] ?? `wxtz-verify-jwt-secret-${runId}-2026-local`;
const internalKey = "wxtz-verify-internal";

fs.mkdirSync(dataDir, { recursive: true });

let gitHead = "unknown";
try {
  gitHead = execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
} catch {
  // fallback if git unavailable
}

const db = new InMemoryDb();
const ports = createMockExternalPorts();
const BASE_WEEK48_MS = Date.UTC(2026, 10, 24, 2, 0, 0); // 2026-11-24 10:00 CST -> ISO week 2026W48

async function dumpDbSnapshot(): Promise<Record<string, number>> {
  const collections: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const col of Object.values(COLLECTIONS) as CollectionName[]) {
    const docs = await db.find(col, () => true);
    collections[col] = docs;
    counts[col] = docs.length;
  }
  const snapshotPath = path.join(dataDir, "db.json");
  const tmpPath = `${snapshotPath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        updatedAt: Date.now(),
        runId,
        gitHead,
        counts,
        collections,
        portLogs: ports.logs,
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpPath, snapshotPath);
  return counts;
}

async function seedVerificationBaseline(): Promise<void> {
  const t0 = BASE_WEEK48_MS;

  // 1. Yarn catalog & patterns & styles
  await db.insert<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, {
    _id: "YARN-WHITE-01",
    name: "奶白4股精梳棉",
    brand: "江南线厂",
    itemType: "yarn",
    isBase12: true,
    isMaterialPack: false,
    unitWeightG: 50,
    unitCostFen: asFen(400),
    supplierId: "SUP_JZH_01",
    supplierSkuCode: "JZH-4P-001",
    status: "active",
  });
  await db.insert<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, {
    _id: "YARN-PINK-02",
    name: "樱粉4股精梳棉",
    brand: "江南线厂",
    itemType: "yarn",
    isBase12: true,
    isMaterialPack: false,
    unitWeightG: 50,
    unitCostFen: asFen(420),
    supplierId: "SUP_JZH_01",
    supplierSkuCode: "JZH-4P-002",
    status: "active",
  });

  await db.insert<PatternDoc>(COLLECTIONS.PATTERNS, {
    _id: "pat_sasa_01",
    skuCode: "TZ-SASA-01",
    version: 1,
    parts: [{ partName: "头部主体", steps: [{ rowNo: 1, text: "环起 6X", stitchCount: 6 }] }],
    authorUserId: "usr_admin_verify",
    status: "approved",
    updatedAt: t0,
  });
  await db.insert<PatternDoc>(COLLECTIONS.PATTERNS, {
    _id: "pat_papa_01",
    skuCode: "TZ-PAPA-01",
    version: 1,
    parts: [{ partName: "身体主体", steps: [{ rowNo: 1, text: "环起 8X", stitchCount: 8 }] }],
    authorUserId: "usr_admin_verify",
    status: "approved",
    updatedAt: t0,
  });

  await db.insert<StyleDoc>(COLLECTIONS.STYLES, {
    _id: "TZ-SASA-01",
    name: "天真宝宝·sasa挂件",
    riskClass: "core",
    standardMin: 90,
    patternId: "pat_sasa_01",
    yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20 }],
    wasteRateBp: 1000,
    extraAccessoryCostFen: ZERO_FEN,
    materialCostFen: asFen(176),
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
  });
  await db.insert<StyleDoc>(COLLECTIONS.STYLES, {
    _id: "TZ-PAPA-01",
    name: "天真宝宝·papa挂件",
    riskClass: "core",
    standardMin: 110,
    patternId: "pat_papa_01",
    yarnBom: [
      { yarnCode: "YARN-WHITE-01", netWeightG: 15 },
      { yarnCode: "YARN-PINK-02", netWeightG: 15 },
    ],
    wasteRateBp: 1000,
    extraAccessoryCostFen: ZERO_FEN,
    materialCostFen: asFen(271),
    yarnPoolAccrualFen: asFen(450),
    craftFeeFen: asFen(3200),
    weaverShipShareFen: asFen(300),
    ownerType: "platform",
    qcOwner: "volunteer_or_admin",
    royaltyFen: ZERO_FEN,
    creatorQcFeeFen: ZERO_FEN,
    trafficCommissionBp: 0,
    requiresEnrollment: false,
    status: "active",
  });

  // 2. Mall products
  await db.insert<ProductDoc>(COLLECTIONS.PRODUCTS, {
    _id: "prod_sasa_ready",
    skuCode: "TZ-SASA-01",
    saleType: "ready_stock",
    title: "天真宝宝·sasa 现货闪发",
    coverFileIds: ["cloud://cover_sasa.jpg"],
    detailFileIds: ["cloud://detail_sasa.jpg"],
    priceFen: asFen(5800),
    buyerShipFeeFen: ZERO_FEN,
    etaText: "现货 48 小时内发出",
    sortOrder: 1,
    isOnSale: true,
    updatedAt: t0,
  });
  await db.insert<ProductDoc>(COLLECTIONS.PRODUCTS, {
    _id: "prod_sasa_mto",
    skuCode: "TZ-SASA-01",
    saleType: "made_to_order",
    title: "天真宝宝·sasa 手作定制",
    coverFileIds: ["cloud://cover_sasa.jpg"],
    detailFileIds: ["cloud://detail_sasa.jpg"],
    priceFen: asFen(5800),
    buyerShipFeeFen: asFen(500),
    etaText: "下单后 3-5 天内发出",
    sortOrder: 2,
    isOnSale: true,
    updatedAt: t0,
  });
  await db.insert<ProductDoc>(COLLECTIONS.PRODUCTS, {
    _id: "prod_papa_mto",
    skuCode: "TZ-PAPA-01",
    saleType: "made_to_order",
    title: "天真宝宝·papa 手作定制",
    coverFileIds: ["cloud://cover_papa.jpg"],
    detailFileIds: ["cloud://detail_papa.jpg"],
    priceFen: asFen(6800),
    buyerShipFeeFen: asFen(500),
    etaText: "下单后 3-5 天内发出",
    sortOrder: 3,
    isOnSale: true,
    updatedAt: t0,
  });

  // 3. Active weavers (`live` pool + `mp` pool) & candidate weaver at Step 4 (`pending_deposit`)
  await db.insert<UserDoc>(COLLECTIONS.USERS, {
    _id: "usr_w_live_01",
    weaverOpenid: "oid_w_live_01",
    phone: "13800001101",
    nickname: "嘉兴巧手林姐",
    realName: "林织巧",
    bankName: "招商银行嘉兴分行",
    bankCardEncrypted: "6214830012348821",
    weaverNo: "WV-JZH-001",
    roles: ["weaver"],
    tags: [],
    verifyLevel: "realname",
    pool: "live",
    regionCode: "jzh",
    cityQuotaKey: "浙江省-嘉兴市",
    shippingMode: "auto_pickup",
    doudianAddressAlias: "织女001-嘉兴南湖",
    defaultSendAddrId: "addr_w_live_01",
    funnelStage: "approved",
    acceptingOrders: true,
    acceptsTrial: false,
    restDays: [],
    dailyCapacityMin: 300,
    speedFactor: 1.0,
    stockQuota: {},
    yarnInventory: {
      "YARN-WHITE-01": { wholeSkeins: 6, usedSinceCheckG: 0, needCheck: false, status: "ok" },
      "YARN-PINK-02": { wholeSkeins: 4, usedSinceCheckG: 0, needCheck: false, status: "ok" },
    },
    creditScore: 125,
    consecutiveTimeouts: 0,
    createdAt: t0,
    updatedAt: t0,
  });
  await db.insert<AddressDoc>(COLLECTIONS.ADDRESSES, {
    _id: "addr_w_live_01",
    ownerUserId: "usr_w_live_01",
    type: "weaver_send",
    contactName: "林织巧",
    contactPhone: "13800001101",
    province: "浙江省",
    city: "嘉兴市",
    district: "南湖区",
    detail: "凌公塘路 88 号",
    isDefault: true,
    createdAt: t0,
    updatedAt: t0,
  });

  await db.insert<UserDoc>(COLLECTIONS.USERS, {
    _id: "usr_w_mp_02",
    weaverOpenid: "oid_w_mp_02",
    phone: "13800001102",
    nickname: "姑苏慢织阿青",
    realName: "苏青",
    bankName: "工商银行苏州分行",
    bankCardEncrypted: "6222021100009932",
    weaverNo: "WV-JZH-002",
    roles: ["weaver"],
    tags: [],
    verifyLevel: "realname",
    pool: "mp",
    regionCode: "jzh",
    cityQuotaKey: "江苏省-苏州市",
    shippingMode: "auto_pickup",
    doudianAddressAlias: "织女002-苏州吴中",
    funnelStage: "approved",
    acceptingOrders: true,
    acceptsTrial: false,
    restDays: [],
    dailyCapacityMin: 240,
    speedFactor: 1.0,
    stockQuota: {},
    yarnInventory: {
      "YARN-WHITE-01": { wholeSkeins: 5, usedSinceCheckG: 0, needCheck: false, status: "ok" },
    },
    creditScore: 105,
    consecutiveTimeouts: 0,
    createdAt: t0,
    updatedAt: t0,
  });

  // Candidate matching Admin Console Workspace ④ default form (`usr_hz_candidate_01` / `WV-JZH-018`)
  await db.insert<UserDoc>(COLLECTIONS.USERS, {
    _id: "usr_hz_candidate_01",
    weaverOpenid: "oid_w_candidate_01",
    phone: "13900001818",
    nickname: "杭州候选织女小周",
    roles: ["weaver"],
    tags: [],
    verifyLevel: "phone",
    regionCode: "jzh",
    cityQuotaKey: "浙江省-杭州市",
    shippingMode: "auto_pickup",
    funnelStage: "pending_deposit",
    acceptingOrders: false,
    acceptsTrial: false,
    restDays: [],
    dailyCapacityMin: 0,
    speedFactor: 1.0,
    stockQuota: {},
    yarnInventory: {},
    creditScore: 100,
    consecutiveTimeouts: 0,
    createdAt: t0,
    updatedAt: t0,
  });
  await db.insert<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, {
    _id: recruitFunnelId("usr_hz_candidate_01"),
    userId: "usr_hz_candidate_01",
    stage: "pending_deposit",
    regionCheckPassed: true,
    quizScore: 8,
    quizAttempts: 1,
    portfolioAttempts: 1,
    trialAttempts: 1,
    sampleAttempts: 1,
    sampleTrackingNo: "SF_SAMPLE_018",
    sampleInspectResult: "pass",
    depositStatus: "unpaid",
    depositAmountFen: asFen(20000),
    version: 3,
    updatedAt: t0,
  });

  // 4. Ready stock on weavers (2 units on live weaver, 1 unit on mp weaver)
  await db.insert<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, {
    _id: weaverStockId("usr_w_live_01", "TZ-SASA-01"),
    weaverId: "usr_w_live_01",
    skuCode: "TZ-SASA-01",
    availableQty: 2,
    reservedQty: 0,
    reservations: [],
    items: [{ sourceType: "cancelled_order", sourcePkgId: "pkg_hist_01", createdAt: t0 }],
    oldestCreatedAt: t0,
    version: 1,
    updatedAt: t0,
  });
  await db.insert<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, {
    _id: weaverStockId("usr_w_mp_02", "TZ-SASA-01"),
    weaverId: "usr_w_mp_02",
    skuCode: "TZ-SASA-01",
    availableQty: 1,
    reservedQty: 0,
    reservations: [],
    items: [{ sourceType: "cancelled_order", sourcePkgId: "pkg_hist_02", createdAt: t0 }],
    oldestCreatedAt: t0,
    version: 1,
    updatedAt: t0,
  });

  // 5. Workspace ③ & ④ live packages & escalated 2h SLA review
  const stdItemSnapshot: OrderPackageDoc["itemsSnapshot"] = [
    {
      skuCode: "TZ-SASA-01",
      skuName: "天真宝宝·sasa挂件",
      qty: 1,
      standardMin: 90,
      yarnBomSnapshot: [{ yarnCode: "YARN-WHITE-01", consumedG: 22 }],
      materialCostFen: asFen(176),
      craftFeeFen: asFen(2800),
      yarnPoolAccrualFen: asFen(400),
      weaverShipShareFen: asFen(300),
      saleType: "made_to_order",
    },
  ];
  await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_ready_seed_01",
    channel: "douyin_online",
    poolTarget: "live",
    orderIds: ["ord_seed_ready"],
    externalOrderIds: ["DY_SEED_READY_01"],
    buyerProvince: "浙江省",
    buyerCity: "杭州市",
    itemsSnapshot: stdItemSnapshot,
    totalMin: 90,
    status: "ready_to_ship",
    assignedWeaverId: "usr_w_live_01",
    bagQrCode: "BAG-SEED-8801",
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    dispatchableAt: t0,
    version: 3,
    updatedAt: t0,
  });
  await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_hold_seed_01",
    channel: "douyin_online",
    poolTarget: "live",
    orderIds: ["ord_seed_hold"],
    externalOrderIds: ["DY_SEED_HOLD_01"],
    buyerProvince: "江苏省",
    buyerCity: "南京市",
    itemsSnapshot: stdItemSnapshot,
    totalMin: 90,
    status: "manual_hold",
    isReadyStockReuse: false,
    attemptCount: 5,
    reviewMode: "required",
    dispatchableAt: t0,
    version: 6,
    updatedAt: t0,
  });
  await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_review_seed_01",
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: ["ord_seed_rev"],
    externalOrderIds: [],
    buyerProvince: "浙江省",
    buyerCity: "宁波市",
    itemsSnapshot: stdItemSnapshot,
    totalMin: 90,
    status: "photo_review",
    assignedWeaverId: "usr_w_mp_02",
    queueSeq: 1,
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    dispatchableAt: t0,
    version: 2,
    updatedAt: t0,
  });
  await db.insert<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, {
    _id: "rev_sla_seed_01",
    scene: "shipment_qc",
    targetId: "pkg_review_seed_01",
    weaverId: "usr_w_mp_02",
    skuCode: "TZ-SASA-01",
    photoSlots: {
      frontOnScaleCard: "cloud://seed_front.jpg",
      backStitch: "cloud://seed_back.jpg",
      sidePlumpness: "cloud://seed_side.jpg",
    },
    photoFileIds: ["cloud://seed_front.jpg", "cloud://seed_back.jpg", "cloud://seed_side.jpg"],
    imageHashes: ["h_seed_1", "h_seed_2", "h_seed_3"],
    duplicateFlag: false,
    isCalibrationSample: false,
    requiredVotes: 5,
    slaDeadlineAt: t0 - 60_000,
    voteCount: 1,
    status: "needs_admin",
    version: 2,
    createdAt: t0 - 2 * HOUR_MS,
  });

  // 6. Workspace ⑤ & ⑥: accrue 1 settled package (`2500` net craft + `2000` yarn pool) & submit 1 `2026W48` weekly yarn claim
  await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_settled_seed_01",
    channel: "douyin_online",
    poolTarget: "live",
    orderIds: ["ord_seed_settled"],
    externalOrderIds: ["DY_SEED_SETTLED_01"],
    buyerProvince: "上海市",
    buyerCity: "上海市",
    itemsSnapshot: stdItemSnapshot,
    totalMin: 90,
    status: "settled_ready",
    assignedWeaverId: "usr_w_live_01",
    signedAt: t0 - 8 * DAY_MS,
    settleEligibleAt: t0 - DAY_MS,
    settledLedgerId: "accrue:pkg_settled_seed_01",
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "skip",
    dispatchableAt: t0 - 10 * DAY_MS,
    version: 4,
    updatedAt: t0,
  });
  await accrueSettledPackage(db, {
    packageId: "pkg_settled_seed_01",
    weaverId: "usr_w_live_01",
    craftFeeFen: asFen(2800),
    weaverShipShareFen: asFen(300),
    yarnPoolAccrualFen: asFen(2000),
    nowUtcMs: t0,
  });
  await submitWeeklyYarnClaim(db, {
    weaverId: "usr_w_live_01",
    sendAddrId: "addr_w_live_01",
    items: [{ yarnCode: "YARN-WHITE-01", qty: 3 }],
    shippingFeeFen: asFen(250),
    nowUtcMs: t0, // weekKey === "2026W48"
  });
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

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

async function main() {
  if (args.seed !== "false") {
    await seedVerificationBaseline();
  }
  let counts = await dumpDbSnapshot();

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/__doctor") {
      counts = await dumpDbSnapshot();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "wxtz-verify-server",
          runId,
          pid: process.pid,
          port: (server.address() as any)?.port ?? portArg,
          dataDir,
          gitHead,
          counts,
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/wxtz-api") {
      try {
        const body = await readJsonBody(req);
        const action = String(body.action ?? "");
        const authHeader = req.headers.authorization;
        const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
        const adminToken = body.adminToken ?? bearer;
        const isInternal = body.internalKey === internalKey && !body.openid;

        const apiRes = await dispatchCloudAction(
          {
            db,
            ports,
            app: body.app,
            openid: body.openid,
            unionid: body.unionid,
            invocationSource: isInternal ? "internal" : body.openid ? "mp_client" : "http_gateway",
            adminJwtSecret: jwtSecret,
            adminToken,
            nowUtcMs: typeof body.nowUtcMs === "number" ? body.nowUtcMs : Date.now(),
          },
          action,
          body.payload ?? {},
        );
        counts = await dumpDbSnapshot();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(apiRes));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, code: "BAD_REQUEST", message: err?.message ?? "Invalid JSON" }));
      }
      return;
    }

    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const target = path.resolve(ADMIN_ROOT, rel);
      if (!target.startsWith(ADMIN_ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const ext = path.extname(target);
      res.writeHead(200, { "Content-Type": MIME_BY_EXT[ext] ?? "application/octet-stream" });
      res.end(fs.readFileSync(target));
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
  });

  server.listen(portArg, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    const actualPort = addr.port;
    const baseUrl = `http://127.0.0.1:${actualPort}`;
    const apiUrl = `${baseUrl}/wxtz-api`;
    const adminToken = signAdminJwt(
      { sub: "usr_admin_verify", role: "admin", exp: Date.now() + 12 * HOUR_MS },
      jwtSecret,
    );
    const instanceMeta = {
      runId,
      pid: process.pid,
      port: actualPort,
      baseUrl,
      apiUrl,
      dataDir,
      adminToken,
      gitHead,
      startedAt: Date.now(),
    };
    fs.writeFileSync(path.join(dataDir, "instance.json"), JSON.stringify(instanceMeta, null, 2));
    console.log(`[wxtz-verify-server] READY ${JSON.stringify(instanceMeta)}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[wxtz-verify-server] FATAL", err);
  process.exit(1);
});
