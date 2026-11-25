import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  HOUR_MS,
  ZERO_FEN,
  asFen,
  type PatternDoc,
  type StyleDoc,
  type YarnCatalogDoc,
} from "@wxtz/shared";
import {
  InMemoryDb,
  WxCloudDbAdapter,
  createCloudMainHandler,
  createMockExternalPorts,
  dispatchCloudAction,
  signAdminJwt,
  verifyAdminJwt,
  type AuditLogDoc,
  type WxCloudCollection,
  type WxCloudDatabase,
} from "../index.ts";

const TEST_SECRET = "wxtz-unit-test-admin-jwt-secret-key-2026";

test("Admin JWT signing, verification, expiry, and tampering rejection", () => {
  const now = 1_760_000_000_000;
  const token = signAdminJwt({ sub: "usr_admin_01", role: "admin", exp: now + 3600_000 }, TEST_SECRET);

  const verified = verifyAdminJwt(token, TEST_SECRET, now + 10_000);
  assert.equal(verified.sub, "usr_admin_01");
  assert.equal(verified.role, "admin");

  // Expired token rejected
  assert.throws(() => verifyAdminJwt(token, TEST_SECRET, now + 3600_001), /过期/);

  // Tampered signature rejected
  const tampered = `${token.slice(0, -2)}xx`;
  assert.throws(() => verifyAdminJwt(tampered, TEST_SECRET, now), /签名无效/);

  // Missing token rejected
  assert.throws(() => verifyAdminJwt(undefined, TEST_SECRET, now), /缺少运营后台登录凭证/);
});

test("WxCloudDbAdapter + createCloudMainHandler mock CloudBase SDK integration", async () => {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const getColMap = (name: string) => {
    let m = store.get(name);
    if (!m) {
      m = new Map();
      store.set(name, m);
    }
    return m;
  };

  const mockDb: WxCloudDatabase = {
    collection(name: string): WxCloudCollection {
      const col = getColMap(name);
      return {
        doc(id: string) {
          return {
            async get() {
              const found = col.get(id);
              return found ? { data: structuredClone(found) } : {};
            },
            async set({ data }) {
              col.set(id, structuredClone(data));
            },
            async remove() {
              const existed = col.delete(id);
              return { stats: { removed: existed ? 1 : 0 } };
            },
          };
        },
        async add({ data }) {
          const id = String(data._id ?? "");
          if (col.has(id)) {
            throw new Error("errCode: -502001 duplicate key error");
          }
          const copy = structuredClone(data);
          delete copy._id;
          col.set(id, copy);
        },
        where() {
          return {
            limit(n: number) {
              return {
                async get() {
                  const arr: unknown[] = [];
                  for (const [id, doc] of col.entries()) {
                    if (arr.length >= n) break;
                    arr.push({ ...structuredClone(doc), _id: id });
                  }
                  return { data: arr };
                },
              };
            },
          };
        },
      };
    },
    async runTransaction<T>(fn: (tx: WxCloudDatabase) => Promise<T>): Promise<T> {
      return fn(mockDb);
    },
  };

  const adapter = new WxCloudDbAdapter(mockDb);
  const ins1 = await adapter.insert(COLLECTIONS.SYSTEM_CONFIG, { _id: "cfg_1", val: 1 });
  const ins2 = await adapter.insert(COLLECTIONS.SYSTEM_CONFIG, { _id: "cfg_1", val: 2 });
  assert.equal(ins1.inserted, true);
  assert.equal(ins2.inserted, false);

  const cas = await adapter.atomicUpdate<{ _id: string; val: number }>(
    COLLECTIONS.SYSTEM_CONFIG,
    "cfg_1",
    (cur) => cur.val === 1,
    (cur) => ({ ...cur, val: 42 }),
  );
  assert.equal(cas.updated, true);
  assert.equal(cas.doc?.val, 42);

  // Wire createCloudMainHandler without any hardcoded envId
  const main = createCloudMainHandler({
    wxCloud: {
      DYNAMIC_CURRENT_ENV: "DYNAMIC",
      init() {},
      database() {
        return mockDb;
      },
      getWXContext() {
        return { OPENID: "oid_mp_buyer_1", APPID: "wxtz-mp-buyer-placeholder" };
      },
    },
    adminJwtSecret: TEST_SECRET,
    appByAppId: { "wxtz-mp-buyer-placeholder": "mp-buyer" },
  });

  const loginRes = await main({
    action: "auth.login",
    payload: { phone: "13900008888", nickname: "测试买家" },
  });
  assert.equal(loginRes.ok, true);
});

test("Unified router dispatchCloudAction: auth, weaver UGC check, deposit cashier, admin JWT + audit, SLA escalation & arbitration", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 24, 1, 0, 0);

  // Seed catalog & style
  await db.insert<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, {
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
  });
  await db.insert<PatternDoc>(COLLECTIONS.PATTERNS, {
    _id: "pat_sasa_01",
    skuCode: "TZ-SASA-01",
    version: 1,
    parts: [{ partName: "主体", steps: [{ rowNo: 1, text: "环起 6X", stitchCount: 6 }] }],
    authorUserId: "usr_admin",
    status: "approved",
    updatedAt: t0,
  });
  await db.insert<StyleDoc>(COLLECTIONS.STYLES, {
    _id: "TZ-SASA-01",
    name: "天真宝宝·sasa",
    riskClass: "core",
    standardMin: 90,
    patternId: "pat_sasa_01",
    yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20 }],
    wasteRateBp: 1000,
    extraAccessoryCostFen: ZERO_FEN,
    materialCostFen: asFen(176),
    yarnPoolAccrualFen: asFen(300),
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

  // 1. Cross-app login merges same phone into single usr_xxx
  const wLogin = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_01", adminJwtSecret: TEST_SECRET, nowUtcMs: t0 },
    "auth.login",
    { phone: "13812345678", nickname: "苏杭巧手" },
  );
  assert.equal(wLogin.ok, true);
  const weaverId = (wLogin as any).data.user._id as string;

  const bLogin = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_01", adminJwtSecret: TEST_SECRET, nowUtcMs: t0 + 100 },
    "auth.login",
    { phone: "13812345678" },
  );
  assert.equal(bLogin.ok, true);
  assert.equal((bLogin as any).data.user._id, weaverId);

  // 2. Weaver jumps to mp-buyer deposit cashier to pay 200 RMB cooperative deposit
  const depCashier = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_01", adminJwtSecret: TEST_SECRET, nowUtcMs: t0 + 200 },
    "buyer.payWeaverDeposit",
    {},
  );
  assert.equal(depCashier.ok, true);
  assert.equal((depCashier as any).data.amountFen, 20000);
  assert.equal(ports.logs.prepays.length, 1);

  // 3. Admin endpoint without JWT fails with FORBIDDEN
  const unauthAdmin = await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, nowUtcMs: t0 },
    "admin.liveSafeStockPlan",
    {},
  );
  assert.equal(unauthAdmin.ok, false);
  if (!unauthAdmin.ok) assert.equal(unauthAdmin.code, "FORBIDDEN");

  // 4. Complete 4-step funnel via router + Admin JWT
  const adminToken = signAdminJwt({ sub: "usr_admin_root", role: "admin", exp: t0 + 24 * HOUR_MS }, TEST_SECRET);
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_01", adminJwtSecret: TEST_SECRET, nowUtcMs: t0 },
    "weaver.funnelStep1",
    { province: "浙江省", city: "嘉兴市", quizCorrectCount: 8, portfolioPhotoFileIds: ["f1", "f2", "f3"] },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, adminToken, nowUtcMs: t0 + 500 },
    "admin.funnelPassPortfolio",
    { userId: weaverId },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_01", adminJwtSecret: TEST_SECRET, nowUtcMs: t0 + 1000 },
    "weaver.funnelAckDeposit",
    { ackDepositNotice: true },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, adminToken, nowUtcMs: t0 + 2000 },
    "admin.funnelPassTrialPhotos",
    { userId: weaverId },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, adminToken, nowUtcMs: t0 + 3000 },
    "admin.funnelSampleInspect",
    { userId: weaverId, trackingNo: "SF1001", passed: true, shippingModeConfirmed: "auto_pickup" },
  );
  const approveRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, adminToken, nowUtcMs: t0 + 4000 },
    "admin.funnelApproveDeposit",
    {
      userId: weaverId,
      weaverNo: "WV-JZH-001",
      base12Codes: ["YARN-WHITE-01"],
      depositChannel: "mp_buyer_cashier",
      depositRefId: (depCashier as any).data.outTradeNo,
    },
  );
  assert.equal(approveRes.ok, true);

  // Graduate weaver from mp trial pool to live pool
  const promRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, adminToken, nowUtcMs: t0 + 4500 },
    "admin.promoteWeaverPool",
    { userId: weaverId, pool: "live" },
  );
  assert.equal(promRes.ok, true);

  // 5. Tonight's Live Safe Stock Plan + Douyin Dual-CSV Commit + Audit Log
  const planRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, adminToken, nowUtcMs: t0 + 5000 },
    "admin.liveSafeStockPlan",
    { horizonDays: 5 },
  );
  assert.equal(planRes.ok, true);
  assert.ok((planRes as any).data["TZ-SASA-01"].totalSafeQty > 0);

  const csvRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, adminToken, nowUtcMs: t0 + 6000 },
    "admin.commitDouyinCsv",
    {
      confirmZeroRefundsToday: true,
      dispatchableAtMs: t0 + 6000,
      orderRows: [
        {
          externalOrderId: "DY99001",
          skuCode: "TZ-SASA-01",
          qty: 1,
          paidFen: 4900,
          province: "浙江省",
          city: "杭州市",
          maskedName: "林*",
          maskedPhone: "137****9999",
        },
      ],
    },
  );
  assert.equal(csvRes.ok, true);
  assert.equal((csvRes as any).data.createdPackages, 1);

  const audits = await db.find<AuditLogDoc>(COLLECTIONS.AUDIT_LOG, () => true);
  assert.equal(audits.length, 3); // funnelApproveDeposit + promoteWeaverPool + commitDouyinCsv

  // 6. Cron dispatch -> weaver accepts -> weaver submits 3-slot photos (triggers UGC image checks!)
  await dispatchCloudAction({ db, ports, adminJwtSecret: TEST_SECRET, nowUtcMs: t0 + 7000 }, "cron.dispatchTick", {});
  const dashRes = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_01", adminJwtSecret: TEST_SECRET, nowUtcMs: t0 + 7500 },
    "weaver.dashboard",
    {},
  );
  assert.equal(dashRes.ok, true);
  const pkgId = (dashRes as any).data.packages[0]._id as string;

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_01", adminJwtSecret: TEST_SECRET, nowUtcMs: t0 + 8000 },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );

  const subRes = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_01", adminJwtSecret: TEST_SECRET, nowUtcMs: t0 + 9000 },
    "weaver.submitFinishedWork",
    {
      packageId: pkgId,
      photoSlots: {
        frontOnScaleCard: "cloud://front.jpg",
        backStitch: "cloud://back.jpg",
        sidePlumpness: "cloud://side.jpg",
      },
      imageHashes: ["h1", "h2", "h3"],
    },
  );
  assert.equal(subRes.ok, true);
  assert.equal(ports.logs.imageChecks.length, 6); // 3 funnel portfolio photos + 3 finished-work QC photos checked!
  const reviewId = (subRes as any).data.reviewId as string;

  // 7. 5-minute watchdog after 2h SLA with 0 votes escalates to needs_admin -> admin arbitrates in 10s
  const watchdogRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, nowUtcMs: t0 + 9000 + 2 * HOUR_MS + 1000 },
    "cron.fiveMinuteWatchdog",
    {},
  );
  assert.equal(watchdogRes.ok, true);
  assert.equal((watchdogRes as any).data.sla.escalatedToAdmin, 1);

  const arbRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: TEST_SECRET, adminToken, nowUtcMs: t0 + 9000 + 2 * HOUR_MS + 5000 },
    "admin.arbitratePhotoReview",
    { reviewId, approve: true },
  );
  assert.equal(arbRes.ok, true);
  assert.equal((arbRes as any).data.reviewStatus, "approved");
});
