import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAdminApiClient } from "../api.ts";
import {
  InMemoryDb,
  createMockExternalPorts,
  dispatchCloudAction,
  signAdminJwt,
} from "@wxtz/cloud";

const ROOT = process.cwd();
const SECRET = "wxtz-admin-client-integration-secret-2026";

test("Admin API client integrates end-to-end with CloudBase router JWT & error contract", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const now = 1_764_000_000_000;
  let currentToken: string | undefined;

  const fakeFetch: typeof fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const result = await dispatchCloudAction(
      {
        db,
        ports,
        adminJwtSecret: SECRET,
        adminToken: body.adminToken,
        nowUtcMs: now,
      },
      body.action,
      body.payload ?? {},
    );
    return {
      async json() {
        return result;
      },
    } as Response;
  }) as typeof fetch;

  const client = createAdminApiClient({
    endpointUrl: "https://wxtz-cloudbase.example.com/wxtz-api",
    getToken: () => currentToken,
    fetchImpl: fakeFetch,
  });

  // Without JWT -> throws FORBIDDEN
  await assert.rejects(() => client.getOverview(), /FORBIDDEN/);

  // With valid short-lived JWT -> succeeds
  currentToken = signAdminJwt({ sub: "usr_admin_01", role: "admin", exp: now + 600_000 }, SECRET);
  const overview = await client.getOverview();
  assert.equal(overview.readyToShipCount, 0);

  // Douyin dual-CSV guard blocks missing refund confirmation
  const badPreview = await client.previewDouyinCsv({ orderRows: [] });
  assert.equal(badPreview.valid, false);
  await assert.rejects(() => client.commitDouyinCsv({ orderRows: [] }), /VALIDATION_ERROR/);

  const okPreview = await client.previewDouyinCsv({ orderRows: [], confirmZeroRefundsToday: true });
  assert.equal(okPreview.valid, true);
  assert.equal(okPreview.newOrderCount, 0);
});

test("mp-weaver & mp-buyer pages exist and enforce Lyric Pattern Companion & 8s Blind Review specs", () => {
  // 1. Verify all registered pages in mp-weaver/app.json exist
  const weaverAppJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packages/mp-weaver/app.json"), "utf8"),
  ) as { pages: string[]; navigateToMiniProgramAppIdList: string[] };
  assert.equal(weaverAppJson.pages.length, 5);
  for (const pg of weaverAppJson.pages) {
    for (const ext of [".ts", ".wxml", ".wxss", ".json"]) {
      assert.ok(
        fs.existsSync(path.join(ROOT, "packages/mp-weaver", `${pg}${ext}`)),
        `Missing mp-weaver file: ${pg}${ext}`,
      );
    }
  }

  // 2. Verify Lyric Pattern Companion Rules (docs/07 §2.4): screen-on, vibrateShort, anti-capture, zero audio theft
  const patternTs = fs.readFileSync(
    path.join(ROOT, "packages/mp-weaver/pages/pattern/index.ts"),
    "utf8",
  );
  const cleanCode = patternTs
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.match(cleanCode, /setKeepScreenOn\(\{\s*keepScreenOn:\s*true\s*\}\)/);
  assert.match(cleanCode, /vibrateShort\(\{\s*type:\s*"light"\s*\}\)/);
  assert.match(cleanCode, /setVisualEffectOnCapture/);
  assert.doesNotMatch(cleanCode, /createInnerAudioContext|getBackgroundAudioManager/);

  // 3. Verify all registered pages in mp-buyer/app.json exist + 8s volunteer countdown + deposit cashier
  const buyerAppJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packages/mp-buyer/app.json"), "utf8"),
  ) as { pages: string[] };
  assert.equal(buyerAppJson.pages.length, 4);
  for (const pg of buyerAppJson.pages) {
    for (const ext of [".ts", ".wxml", ".wxss", ".json"]) {
      assert.ok(
        fs.existsSync(path.join(ROOT, "packages/mp-buyer", `${pg}${ext}`)),
        `Missing mp-buyer file: ${pg}${ext}`,
      );
    }
  }

  const volunteerTs = fs.readFileSync(
    path.join(ROOT, "packages/mp-buyer/pages/volunteer/index.ts"),
    "utf8",
  );
  assert.match(volunteerTs, /countdownSec:\s*8/);
  assert.match(volunteerTs, /Math\.max\(8000,/);

  const cashierTs = fs.readFileSync(
    path.join(ROOT, "packages/mp-buyer/pages/deposit-cashier/index.ts"),
    "utf8",
  );
  assert.match(cashierTs, /buyer\.payWeaverDeposit/);

  // 4. Verify Admin HTML console exists & default weekKey matches backend YYYY-Www format without hyphen
  const adminHtml = fs.readFileSync(path.join(ROOT, "packages/admin/index.html"), "utf8");
  assert.match(adminHtml, /id="yarnWeekKey"[^>]*value="2026W48"/);
  assert.ok(fs.existsSync(path.join(ROOT, "packages/admin/src/console.js")));
});

test("R18: Mini-Program pages execute end-to-end against router (catalog sellability, order auto-address, deposit webhook, 50g skein check & low-stock claim)", async () => {
  const { registerHooks } = await import("node:module");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const {
    COLLECTIONS,
    ZERO_FEN,
    asFen,
  } = await import("@wxtz/shared");
  const { consumeYarnForPackage, weaverStockId } = await import("@wxtz/cloud");

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        const candidateTs = path.resolve(parentDir, `${specifier}.ts`);
        if (fs.existsSync(candidateTs)) {
          return nextResolve(pathToFileURL(candidateTs).href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });

  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const now = Date.UTC(2026, 10, 24, 5, 0, 0);

  await db.insert(COLLECTIONS.YARN_CATALOG, {
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
  await db.insert(COLLECTIONS.STYLES, {
    _id: "TZ-SASA-01",
    name: "天真宝宝·sasa",
    riskClass: "core",
    standardMin: 90,
    patternId: "pat_1",
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
  await db.insert(COLLECTIONS.PRODUCTS, {
    _id: "prod_ready_1",
    skuCode: "TZ-SASA-01",
    saleType: "ready_stock",
    title: "现货·天真宝宝",
    coverFileIds: ["c1"],
    detailFileIds: ["d1"],
    priceFen: asFen(5800),
    buyerShipFeeFen: ZERO_FEN,
    etaText: "48h发",
    sortOrder: 1,
    isOnSale: true,
    updatedAt: now,
  });

  // Login weaver & buyer
  const wRes = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_r18", adminJwtSecret: SECRET, nowUtcMs: now },
    "auth.login",
    { phone: "13618181818" },
  );
  const weaverId = (wRes as any).data.user._id as string;
  await db.atomicUpdate(COLLECTIONS.USERS, weaverId, () => true, (u: any) => ({
    ...u,
    weaverNo: "WV-R18",
    pool: "mp",
    funnelStage: "approved",
    acceptingOrders: true,
    dailyCapacityMin: 300,
    yarnInventory: {
      "YARN-WHITE-01": { wholeSkeins: 1, usedSinceCheckG: 0, needCheck: false, status: "low" },
    },
  }));
  await db.insert(COLLECTIONS.WEAVER_STOCK, {
    _id: weaverStockId(weaverId, "TZ-SASA-01"),
    weaverId,
    skuCode: "TZ-SASA-01",
    availableQty: 2,
    reservedQty: 0,
    reservations: [],
    items: [{ sourceType: "cancelled_order", createdAt: now }],
    oldestCreatedAt: now,
    version: 1,
    updatedAt: now,
  });
  await consumeYarnForPackage(
    db,
    weaverId,
    {
      isReadyStockReuse: false,
      itemsSnapshot: [
        {
          skuCode: "TZ-SASA-01",
          qty: 3,
          standardMin: 90,
          yarnBomSnapshot: [{ yarnCode: "YARN-WHITE-01", consumedG: 20 }],
          materialCostFen: ZERO_FEN,
          craftFeeFen: asFen(2800),
          yarnPoolAccrualFen: ZERO_FEN,
          weaverShipShareFen: ZERO_FEN,
          saleType: "made_to_order",
        },
      ],
    },
    { "YARN-WHITE-01": 50 },
    now,
  );

  await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_r18", adminJwtSecret: SECRET, nowUtcMs: now },
    "auth.login",
    { phone: "13918181818" },
  );

  const pages: Record<string, any> = {};
  let loadingKey = "";
  let activeOpenid = "oid_b_r18";
  (globalThis as any).Page = (opts: any) => {
    pages[loadingKey] = opts;
  };
  (globalThis as any).getApp = () => ({ globalData: {} });
  (globalThis as any).wx = {
    showToast() {},
    requestPayment(opts: any) {
      if (opts?.success) opts.success();
    },
    cloud: {
      async callFunction({ data }: any) {
        const result = await dispatchCloudAction(
          { db, ports, app: data.app, openid: activeOpenid, adminJwtSecret: SECRET, nowUtcMs: now },
          data.action,
          data.payload,
        );
        return { result };
      },
    },
  };

  loadingKey = "mall";
  await import("../../../mp-buyer/pages/mall/index.ts");
  loadingKey = "order";
  await import("../../../mp-buyer/pages/order/index.ts");
  loadingKey = "workbench";
  await import("../../../mp-weaver/pages/workbench/index.ts");
  loadingKey = "yarn";
  await import("../../../mp-weaver/pages/yarn/index.ts");

  // 1. Mall page displays on-sale catalog & availableReadyUnits = 2
  const mall = {
    ...pages.mall,
    data: structuredClone(pages.mall.data),
    setData(p: any) { Object.assign(this.data, p); },
  };
  await mall.loadCatalog();
  assert.equal(mall.data.products.length, 1);
  assert.equal(mall.data.products[0].availableUnits, 2);

  // 2. Order page auto-creates buyer address and places order cleanly
  const ordPage = {
    ...pages.order,
    data: { ...structuredClone(pages.order.data), productId: "prod_ready_1" },
    setData(p: any) { Object.assign(this.data, p); },
  };
  await ordPage.onPayOrder();
  assert.ok(ordPage.data.currentOrderId.startsWith("ord_"));
  assert.equal(ordPage.data.orderStatus, "paid_waiting_dispatch");

  // 3. Deposit cashier prepay + webhook.wxpay records 20,000 Fen deposit
  const dep = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_r18", adminJwtSecret: SECRET, nowUtcMs: now },
    "buyer.payWeaverDeposit",
    {},
  );
  const depWh = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: now + 10 },
    "webhook.wxpay",
    { orderId: (dep as any).data.outTradeNo, wxTransactionId: "WX_DEP_R18" },
  );
  assert.equal(depWh.ok, true);

  // 4. Weaver workbench detects `needCheck` (50g skein check) & yarn page sets low-stock default `claimQty = 3`
  activeOpenid = "oid_w_r18";
  const wb = {
    ...pages.workbench,
    data: structuredClone(pages.workbench.data),
    setData(p: any) { Object.assign(this.data, p); },
  };
  await wb.refreshDashboard();
  assert.deepEqual(wb.data.skeinCheckItem, { yarnCode: "YARN-WHITE-01", expectedSkeins: 1 });

  const yp = {
    ...pages.yarn,
    data: structuredClone(pages.yarn.data),
    setData(p: any) { Object.assign(this.data, p); },
  };
  await yp.loadYarnState();
  assert.equal(yp.data.inventoryList[0]?.claimQty, 3);
});
