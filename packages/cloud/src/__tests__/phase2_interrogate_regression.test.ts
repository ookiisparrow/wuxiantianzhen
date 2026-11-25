import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  asFen,
  type LedgerEntryDoc,
  type OrderDoc,
  type OrderPackageDoc,
  type ShipmentDoc,
  type UserDoc,
  type WeaverAccountDoc,
  type WeaverStockDoc,
} from "@wxtz/shared";
import {
  InMemoryDb,
  createMockExternalPorts,
  dispatchCloudAction,
  ledgerKeyShipFee,
  shipmentId,
  signAdminJwt,
  weaverAccountId,
  weaverStockId,
} from "../index.ts";

const SECRET = "wxtz-phase2-adversary-jwt-secret-2026";

async function seedCatalog(
  db: InMemoryDb,
  ports: ReturnType<typeof createMockExternalPorts>,
  adminToken: string,
  nowUtcMs: number,
): Promise<{ mtoProductId: string; readyStockProductId: string }> {
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertYarn",
    {
      _id: "YARN-WHITE-01",
      name: "奶白4股棉",
      brand: "江南线厂",
      itemType: "yarn",
      isBase12: true,
      isMaterialPack: false,
      unitWeightG: 50,
      unitCostFen: 500,
      supplierId: "SUP_JZH_01",
      supplierSkuCode: "JZH-4P-001",
      status: "active",
    },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertPattern",
    {
      _id: "pat_sasa_01",
      skuCode: "TZ-SASA-01",
      parts: [{ partName: "主体", steps: [{ rowNo: 1, text: "环起 6X", stitchCount: 6 }] }],
      authorUserId: "usr_admin",
      status: "approved",
    },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertStyle",
    {
      _id: "TZ-SASA-01",
      name: "天真宝宝·sasa",
      standardMin: 90,
      patternId: "pat_sasa_01",
      yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20 }],
      wasteRateBp: 1000,
      extraAccessoryCostFen: 100,
      yarnPoolAccrualFen: 400,
      craftFeeFen: 2800,
      weaverShipShareFen: 300,
    },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertProduct",
    {
      _id: "prod_mto_01",
      skuCode: "TZ-SASA-01",
      saleType: "made_to_order",
      title: "定制sasa",
      priceFen: 5800,
      buyerShipFeeFen: 0,
      isOnSale: true,
    },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertProduct",
    {
      _id: "prod_rs_01",
      skuCode: "TZ-SASA-01",
      saleType: "ready_stock",
      title: "现货sasa",
      priceFen: 5800,
      buyerShipFeeFen: 0,
      isOnSale: true,
    },
  );
  return { mtoProductId: "prod_mto_01", readyStockProductId: "prod_rs_01" };
}

async function onboardWeaver(params: {
  db: InMemoryDb;
  ports: ReturnType<typeof createMockExternalPorts>;
  adminToken: string;
  openid: string;
  phone: string;
  weaverNo: string;
  creditScore?: number;
  pool?: "mp" | "live";
  nowUtcMs: number;
}): Promise<string> {
  const { db, ports, adminToken, openid, phone, weaverNo, nowUtcMs } = params;
  const login = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid, adminJwtSecret: SECRET, nowUtcMs },
    "auth.login",
    { phone, nickname: weaverNo },
  );
  const weaverId = (login as any).data.user._id as string;

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid, adminJwtSecret: SECRET, nowUtcMs },
    "weaver.saveAddress",
    {
      contactName: `织女${weaverNo}`,
      contactPhone: phone,
      province: "浙江省",
      city: "杭州市",
      district: "余杭区",
      detail: "良渚10号",
      isDefault: true,
    },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid, adminJwtSecret: SECRET, nowUtcMs },
    "weaver.funnelStep1",
    { province: "浙江省", city: "杭州市", quizCorrectCount: 8, portfolioPhotoFileIds: ["p1", "p2", "p3"] },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.funnelPassPortfolio",
    { userId: weaverId },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid, adminJwtSecret: SECRET, nowUtcMs },
    "weaver.funnelAckDeposit",
    { ackDepositNotice: true },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.funnelPassTrialPhotos",
    { userId: weaverId },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.funnelSampleInspect",
    { userId: weaverId, trackingNo: `SF_${weaverNo}`, passed: true, shippingModeConfirmed: "auto_pickup" },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.funnelApproveDeposit",
    {
      userId: weaverId,
      weaverNo,
      dailyCapacityMin: 300,
      base12Codes: ["YARN-WHITE-01"],
      depositChannel: "manual_transfer_verify",
      depositRefId: `BANK_DEP_${weaverNo}`,
    },
  );
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    weaverId,
    () => true,
    (u) => ({
      ...u,
      creditScore: params.creditScore ?? 130,
      verifyLevel: "payee",
      realName: `实名${weaverNo}`,
      bankCardEncrypted: `CARD_${weaverNo}`,
    }),
  );
  if (params.pool === "live") {
    await dispatchCloudAction(
      { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
      "admin.promoteWeaverPool",
      { userId: weaverId, pool: "live" },
    );
  }
  return weaverId;
}

async function createBuyerAndAddress(
  db: InMemoryDb,
  ports: ReturnType<typeof createMockExternalPorts>,
  openid: string,
  phone: string,
  nowUtcMs: number,
): Promise<{ buyerId: string; addrId: string }> {
  const bLogin = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid, adminJwtSecret: SECRET, nowUtcMs },
    "auth.login",
    { phone, nickname: "买家" },
  );
  const buyerId = (bLogin as any).data.user._id as string;
  const bAddr = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid, adminJwtSecret: SECRET, nowUtcMs },
    "buyer.saveAddress",
    {
      contactName: "买家",
      contactPhone: phone,
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
      detail: "安福路1号",
    },
  );
  return { buyerId, addrId: (bAddr as any).data._id as string };
}

test("F01: handleKuaidi100Webhook('signed') preserves 7-day post-signoff return window while blocking post-7d settled refunds", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 1, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { mtoProductId } = await seedCatalog(db, ports, adminToken, t0);
  const wId = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w_f01",
    phone: "13810000001",
    weaverNo: "WF01",
    nowUtcMs: t0,
  });
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: wId, batchId: "BF01", codes: ["BAG-F01"] },
  );

  const { addrId } = await createBuyerAndAddress(db, ports, "oid_b_f01", "13910000001", t0);
  const ordRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f01", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.createOrder",
    { productId: mtoProductId, receiverAddrId: addrId, qty: 1 },
  );
  const orderId = (ordRes as any).data.order._id as string;
  const payRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId, wxTransactionId: "WX_F01" },
  );
  const pkgId = (payRes as any).data.packageId as string;

  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 300 }, "cron.dispatchTick", {});
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f01", adminJwtSecret: SECRET, nowUtcMs: t0 + 400 },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f01", adminJwtSecret: SECRET, nowUtcMs: t0 + HOUR_MS },
    "weaver.submitFinishedWork",
    {
      packageId: pkgId,
      photoSlots: { frontOnScaleCard: "f", backStitch: "b", sidePlumpness: "s" },
      imageHashes: ["hf01"],
      bagStickerCode: "BAG-F01",
      sealedPhotoFileId: "seal_f01",
    },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 2 * HOUR_MS },
    "webhook.kuaidi100",
    { packageId: pkgId, state: "picked_up", trackingNo: "ZT_F01", shippingCostFen: 600 },
  );
  const tSigned = t0 + DAY_MS;
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tSigned },
    "webhook.kuaidi100",
    { packageId: pkgId, state: "signed", trackingNo: "ZT_F01" },
  );

  // Buyer requests 7-day return 1 day after signoff (within 7-day after-sale window per docs/07 §4.1)
  const refundRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f01", adminJwtSecret: SECRET, nowUtcMs: tSigned + DAY_MS },
    "buyer.requestRefund",
    { orderId, trigger: "buyer_return_7d", reason: "签收后7天内无理由退货" },
  );
  assert.equal(refundRes.ok, true, `Expected 7d post-signoff refund to succeed, got: ${JSON.stringify(refundRes)}`);
  assert.equal((refundRes as any).data.status, "pending_review");

  // Reject that refund, advance past 7d settlement window, and verify online refund is blocked once settled
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tSigned + 2 * DAY_MS },
    "admin.resolveRefund",
    { refundId: (refundRes as any).data._id, approve: false },
  );
  const lateRefund = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f01", adminJwtSecret: SECRET, nowUtcMs: tSigned + 8 * DAY_MS },
    "buyer.requestRefund",
    { orderId, trigger: "buyer_return_7d", reason: "超7天试图退货" },
  );
  assert.equal(lateRefund.ok, false, "Refund after 7-day settlement window must be blocked");
});

test("F02: handleKuaidi100Webhook guards state==='lost' so intermediate transit callbacks never mark shipments lost_or_damaged", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 2, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { mtoProductId } = await seedCatalog(db, ports, adminToken, t0);
  const wId = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w_f02",
    phone: "13810000002",
    weaverNo: "WF02",
    nowUtcMs: t0,
  });
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: wId, batchId: "BF02", codes: ["BAG-F02"] },
  );

  const { addrId } = await createBuyerAndAddress(db, ports, "oid_b_f02", "13910000002", t0);
  const ordRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f02", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.createOrder",
    { productId: mtoProductId, receiverAddrId: addrId, qty: 1 },
  );
  const payRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId: (ordRes as any).data.order._id, wxTransactionId: "WX_F02" },
  );
  const pkgId = (payRes as any).data.packageId as string;

  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 300 }, "cron.dispatchTick", {});
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f02", adminJwtSecret: SECRET, nowUtcMs: t0 + 400 },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f02", adminJwtSecret: SECRET, nowUtcMs: t0 + HOUR_MS },
    "weaver.submitFinishedWork",
    {
      packageId: pkgId,
      photoSlots: { frontOnScaleCard: "f", backStitch: "b", sidePlumpness: "s" },
      imageHashes: ["hf02"],
      bagStickerCode: "BAG-F02",
      sealedPhotoFileId: "seal_f02",
    },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 2 * HOUR_MS },
    "webhook.kuaidi100",
    { packageId: pkgId, state: "picked_up", trackingNo: "ZT_F02", shippingCostFen: 600 },
  );

  // Kuaidi100 pushes an intermediate transit status ("in_transit" / "delivering")
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 5 * HOUR_MS },
    "webhook.kuaidi100",
    { packageId: pkgId, state: "in_transit", trackingNo: "ZT_F02" },
  );

  const shipMid = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(pkgId));
  assert.notEqual(
    shipMid?.status,
    "lost_or_damaged",
    "Intermediate 'in_transit' webhook must not mark shipment lost_or_damaged",
  );

  // Subsequent real 'signed' callback transitions shipment cleanly to 'signed'
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + DAY_MS },
    "webhook.kuaidi100",
    { packageId: pkgId, state: "signed", trackingNo: "ZT_F02" },
  );
  const shipFinal = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(pkgId));
  assert.equal(shipFinal?.status, "signed");
});

test("F03: handleKuaidi100Webhook gates ship_fee ledger & order fulfilled side effects on moved===true", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 3, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { mtoProductId } = await seedCatalog(db, ports, adminToken, t0);
  const w1Id = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w1_f03",
    phone: "13810000003",
    weaverNo: "WF03A",
    nowUtcMs: t0,
  });
  const w2Id = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w2_f03",
    phone: "13810000004",
    weaverNo: "WF03B",
    creditScore: 100,
    nowUtcMs: t0,
  });
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: w1Id, batchId: "BF03A", codes: ["BAG-F03A"] },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: w2Id, batchId: "BF03B", codes: ["BAG-F03B"] },
  );

  const { addrId } = await createBuyerAndAddress(db, ports, "oid_b_f03", "13910000003", t0);
  const ordRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f03", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.createOrder",
    { productId: mtoProductId, receiverAddrId: addrId, qty: 1 },
  );
  const orderId = (ordRes as any).data.order._id as string;
  const payRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId, wxTransactionId: "WX_F03" },
  );
  const pkgId = (payRes as any).data.packageId as string;

  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 300 }, "cron.dispatchTick", {});
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w1_f03", adminJwtSecret: SECRET, nowUtcMs: t0 + 400 },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w1_f03", adminJwtSecret: SECRET, nowUtcMs: t0 + HOUR_MS },
    "weaver.submitFinishedWork",
    {
      packageId: pkgId,
      photoSlots: { frontOnScaleCard: "f", backStitch: "b", sidePlumpness: "s" },
      imageHashes: ["hf03"],
      bagStickerCode: "BAG-F03A",
      sealedPhotoFileId: "seal_f03a",
    },
  );

  // 3x pickup_failed cancels shipment and escalates package to manual_hold -> reassigned to w2 (making)
  for (let i = 1; i <= 3; i++) {
    await dispatchCloudAction(
      { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + HOUR_MS + i * 1000 },
      "webhook.kuaidi100",
      { packageId: pkgId, state: "pickup_failed" },
    );
  }
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 2 * HOUR_MS },
    "admin.reassignManualHold",
    { packageId: pkgId, targetWeaverId: w2Id },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w2_f03", adminJwtSecret: SECRET, nowUtcMs: t0 + 2 * HOUR_MS + 1000 },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );

  // Stale Kuaidi100 webhooks arrive for cancelled package/taskId while pkg is in 'making' on w2
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 2 * HOUR_MS + 2000 },
    "webhook.kuaidi100",
    { packageId: pkgId, state: "picked_up", shippingCostFen: 600 },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 2 * HOUR_MS + 3000 },
    "webhook.kuaidi100",
    { packageId: pkgId, state: "signed" },
  );

  const prematureLedger = await db.get<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, ledgerKeyShipFee(pkgId));
  assert.equal(prematureLedger, null, "Must not post ship_fee ledger entry when shipment is cancelled (moved===false)");

  const ordDuringMake = await db.get<OrderDoc>(COLLECTIONS.ORDERS, orderId);
  assert.equal(ordDuringMake?.status, "paid", "Must not mark OrderDoc fulfilled while package is still in making");
});

test("F04: sweepUnscheduledMpPickups retries transient Kuaidi100 scheduling errors <=2x then escalates to manual_hold", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 4, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { mtoProductId } = await seedCatalog(db, ports, adminToken, t0);
  const wId = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w_f04",
    phone: "13810000005",
    weaverNo: "WF04",
    nowUtcMs: t0,
  });
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: wId, batchId: "BF04", codes: ["BAG-F04"] },
  );

  const { addrId } = await createBuyerAndAddress(db, ports, "oid_b_f04", "13910000005", t0);
  const ordRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f04", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.createOrder",
    { productId: mtoProductId, receiverAddrId: addrId, qty: 1 },
  );
  const payRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId: (ordRes as any).data.order._id, wxTransactionId: "WX_F04" },
  );
  const pkgId = (payRes as any).data.packageId as string;

  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 300 }, "cron.dispatchTick", {});
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f04", adminJwtSecret: SECRET, nowUtcMs: t0 + 400 },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );

  ports.logistics.scheduleDoorstepPickup = async () => {
    throw new Error("KUAIDI100_HTTP_503");
  };

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f04", adminJwtSecret: SECRET, nowUtcMs: t0 + HOUR_MS },
    "weaver.submitFinishedWork",
    {
      packageId: pkgId,
      photoSlots: { frontOnScaleCard: "f", backStitch: "b", sidePlumpness: "s" },
      imageHashes: ["hf04"],
      bagStickerCode: "BAG-F04",
      sealedPhotoFileId: "seal_f04",
    },
  );

  for (let m = 1; m <= 6; m++) {
    await dispatchCloudAction(
      { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + HOUR_MS + m * 5 * MINUTE_MS },
      "cron.fiveMinuteWatchdog",
      {},
    );
  }

  const pkgAfter = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkgId);
  assert.equal(
    pkgAfter?.status,
    "manual_hold",
    `Expected failed Kuaidi100 API scheduling to retry <=2x and escalate to manual_hold, but stuck at ${pkgAfter?.status}`,
  );
});

test("F05: reassignManualHoldPackage without targetWeaverId preserves monotonic attemptCount while resetting attempt budget", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 5, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { mtoProductId } = await seedCatalog(db, ports, adminToken, t0);
  const w1Id = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w1_f05",
    phone: "13810000006",
    weaverNo: "WF05A",
    nowUtcMs: t0,
  });
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: w1Id, batchId: "BF05A", codes: ["BAG-F05A"] },
  );

  const { addrId } = await createBuyerAndAddress(db, ports, "oid_b_f05", "13910000006", t0);
  const ordRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f05", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.createOrder",
    { productId: mtoProductId, receiverAddrId: addrId, qty: 1 },
  );
  const payRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId: (ordRes as any).data.order._id, wxTransactionId: "WX_F05" },
  );
  const pkgId = (payRes as any).data.packageId as string;

  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 300 }, "cron.dispatchTick", {});
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w1_f05", adminJwtSecret: SECRET, nowUtcMs: t0 + 400 },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w1_f05", adminJwtSecret: SECRET, nowUtcMs: t0 + HOUR_MS },
    "weaver.submitFinishedWork",
    {
      packageId: pkgId,
      photoSlots: { frontOnScaleCard: "f", backStitch: "b", sidePlumpness: "s" },
      imageHashes: ["hf05"],
      bagStickerCode: "BAG-F05A",
      sealedPhotoFileId: "seal_f05a",
    },
  );
  for (let i = 1; i <= 3; i++) {
    await dispatchCloudAction(
      { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + HOUR_MS + i * 1000 },
      "webhook.kuaidi100",
      { packageId: pkgId, state: "pickup_failed" },
    );
  }

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w1_f05", adminJwtSecret: SECRET, nowUtcMs: t0 + 2 * HOUR_MS },
    "weaver.setAcceptingOrders",
    { acceptingOrders: false },
  );
  const w2Id = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w2_f05",
    phone: "13810000007",
    weaverNo: "WF05B",
    nowUtcMs: t0 + 2 * HOUR_MS,
  });

  const resetRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 2 * HOUR_MS + 100 },
    "admin.reassignManualHold",
    { packageId: pkgId },
  );
  assert.equal(resetRes.ok, true);

  const tickRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 2 * HOUR_MS + 200 },
    "cron.dispatchTick",
    {},
  );
  assert.equal((tickRes as any).data.dispatchedCount, 1, "Pool-reset package must dispatch on next dispatchTick");
  const pkgAfter = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkgId);
  assert.equal(pkgAfter?.status, "offered");
  assert.equal(pkgAfter?.assignedWeaverId, w2Id);
});

test("F06: reassignManualHoldPackage releases paid weaverStock reservation so original weaver can exit cleanly", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 6, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { readyStockProductId } = await seedCatalog(db, ports, adminToken, t0);
  const w1Id = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w1_f06",
    phone: "13810000008",
    weaverNo: "WF06A",
    nowUtcMs: t0,
  });
  const w2Id = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w2_f06",
    phone: "13810000009",
    weaverNo: "WF06B",
    nowUtcMs: t0,
  });
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: w2Id, batchId: "BF06B", codes: ["BAG-F06B"] },
  );

  await db.insert<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, {
    _id: weaverStockId(w1Id, "TZ-SASA-01"),
    weaverId: w1Id,
    skuCode: "TZ-SASA-01",
    availableQty: 1,
    reservedQty: 0,
    reservations: [],
    items: [{ sourceType: "cancelled_order", createdAt: t0 }],
    oldestCreatedAt: t0,
    version: 1,
    updatedAt: t0,
  });

  const { addrId } = await createBuyerAndAddress(db, ports, "oid_b_f06", "13910000008", t0);
  const ordRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f06", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.createOrder",
    { productId: readyStockProductId, receiverAddrId: addrId, qty: 1 },
  );
  const payRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId: (ordRes as any).data.order._id, wxTransactionId: "WX_F06" },
  );
  const pkgId = (payRes as any).data.packageId as string;

  await db.atomicUpdate<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    pkgId,
    () => true,
    (p) => ({ ...p, status: "manual_hold", attemptCount: 5, version: p.version + 1 }),
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 300 },
    "admin.reassignManualHold",
    { packageId: pkgId, targetWeaverId: w2Id },
  );

  const w1StockAfterReassign = await db.get<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, weaverStockId(w1Id, "TZ-SASA-01"));
  assert.equal(w1StockAfterReassign?.reservedQty, 0, "Reassigning with isReadyStockReuse=false must release w1's reserved stock");

  const w1Exit = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w1_f06", adminJwtSecret: SECRET, nowUtcMs: t0 + 400 },
    "weaver.requestDepositExit",
    {},
  );
  assert.equal(w1Exit.ok, true, `w1 deposit exit should succeed, got: ${JSON.stringify(w1Exit)}`);
});

test("F07: weaver.setAcceptingOrders never clears server-imposed 7-day timeout suspension via client pauseUntil", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 7, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { mtoProductId } = await seedCatalog(db, ports, adminToken, t0);
  const wId = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w_f07",
    phone: "13810000010",
    weaverNo: "WF07",
    nowUtcMs: t0,
  });

  await db.atomicUpdate<UserDoc>(COLLECTIONS.USERS, wId, () => true, (u) => ({ ...u, consecutiveTimeouts: 2 }));
  const { addrId } = await createBuyerAndAddress(db, ports, "oid_b_f07", "13910000010", t0);
  const ord1 = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f07", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.createOrder",
    { productId: mtoProductId, receiverAddrId: addrId, qty: 1 },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId: (ord1 as any).data.order._id, wxTransactionId: "WX_F07_1" },
  );
  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 300 }, "cron.dispatchTick", {});

  const tSweep = t0 + 2 * HOUR_MS;
  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: tSweep }, "cron.fiveMinuteWatchdog", {});
  const wSuspended = await db.get<UserDoc>(COLLECTIONS.USERS, wId);
  assert.equal(wSuspended?.pauseUntil, tSweep + 7 * DAY_MS);

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f07", adminJwtSecret: SECRET, nowUtcMs: tSweep + MINUTE_MS },
    "weaver.setAcceptingOrders",
    { acceptingOrders: true, pauseUntil: 0 },
  );

  const wAfterAttempt = await db.get<UserDoc>(COLLECTIONS.USERS, wId);
  assert.ok(
    (wAfterAttempt?.pauseUntil ?? 0) >= tSweep + 7 * DAY_MS,
    `Client must not be able to clear server-imposed 7d timeout suspension (got pauseUntil=${wAfterAttempt?.pauseUntil})`,
  );
});

test("F08: requestWeaverExitAndRefundDeposit initiates WeChat Pay refund even when withdrawing before admin.funnelApproveDeposit", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 8, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const wLogin = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f08", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "auth.login",
    { phone: "13810000011", nickname: "织女F08" },
  );
  const userId = (wLogin as any).data.user._id as string;
  await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f08", adminJwtSecret: SECRET, nowUtcMs: t0 + 10 },
    "auth.login",
    { phone: "13810000011" },
  );

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f08", adminJwtSecret: SECRET, nowUtcMs: t0 + 20 },
    "weaver.funnelStep1",
    { province: "浙江省", city: "杭州市", quizCorrectCount: 8, portfolioPhotoFileIds: ["p1", "p2", "p3"] },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 30 },
    "admin.funnelPassPortfolio",
    { userId },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f08", adminJwtSecret: SECRET, nowUtcMs: t0 + 40 },
    "weaver.funnelAckDeposit",
    { ackDepositNotice: true },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 50 },
    "admin.funnelPassTrialPhotos",
    { userId },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 60 },
    "admin.funnelSampleInspect",
    { userId, trackingNo: "SF_F08", passed: true },
  );

  const payDep = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_f08", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.payWeaverDeposit",
    {},
  );
  const outTradeNo = (payDep as any).data.outTradeNo as string;
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId: outTradeNo, wxTransactionId: "WX_DEP_F08_1" },
  );

  const exitRes = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f08", adminJwtSecret: SECRET, nowUtcMs: t0 + 300 },
    "weaver.requestDepositExit",
    {},
  );
  assert.equal(exitRes.ok, true);
  assert.equal(ports.logs.refunds.length, 1, "WeChat Pay initiateRefund must be called when refunding paid cashier deposit");
  assert.ok((exitRes as any).data.wxRefundId);
});

test("F09: exited weaver re-onboarding posts cycle-versioned deposit_in ledger entry and records full 20000 Fen deposit", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 8, 30, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const userId = await onboardWeaver({
    db,
    ports,
    adminToken,
    openid: "oid_w_f09",
    phone: "13810000012",
    weaverNo: "WF09A",
    nowUtcMs: t0,
  });

  const firstExit = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f09", adminJwtSecret: SECRET, nowUtcMs: t0 + 1000 },
    "weaver.requestDepositExit",
    {},
  );
  assert.equal(firstExit.ok, true);

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f09", adminJwtSecret: SECRET, nowUtcMs: t0 + DAY_MS },
    "weaver.funnelStep1",
    { province: "浙江省", city: "杭州市", quizCorrectCount: 8, portfolioPhotoFileIds: ["p1", "p2", "p3"] },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + DAY_MS + 10 },
    "admin.funnelPassPortfolio",
    { userId },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_f09", adminJwtSecret: SECRET, nowUtcMs: t0 + DAY_MS + 20 },
    "weaver.funnelAckDeposit",
    { ackDepositNotice: true },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + DAY_MS + 30 },
    "admin.funnelPassTrialPhotos",
    { userId },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + DAY_MS + 40 },
    "admin.funnelSampleInspect",
    { userId, trackingNo: "SF_F09_2", passed: true },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + DAY_MS + 50 },
    "admin.funnelApproveDeposit",
    {
      userId,
      weaverNo: "WF09B",
      dailyCapacityMin: 300,
      base12Codes: ["YARN-WHITE-01"],
      depositChannel: "manual_transfer_verify",
      depositRefId: "BANK_F09_2",
    },
  );
  const accReonboarded = await db.get<WeaverAccountDoc>(COLLECTIONS.WEAVER_ACCOUNTS, weaverAccountId(userId));
  assert.equal(accReonboarded?.depositFen, asFen(20000), "Re-onboarded weaver must have 20000 Fen deposit recorded");
});

test("F10: importDouyinLogisticsCsv never fabricates in_transit ShipmentDoc for unmade or cancelled_full packages", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 9, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  await seedCatalog(db, ports, adminToken, t0);
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 100 },
    "admin.commitDouyinCsv",
    {
      dispatchableAtMs: t0 + HOUR_MS,
      orderRows: [
        {
          externalOrderId: "6900000000000000001",
          skuCode: "TZ-SASA-01",
          qty: 1,
          paidFen: 5800,
          province: "浙江省",
          city: "杭州市",
          maskedName: "张*",
          maskedPhone: "138****0001",
        },
        {
          externalOrderId: "6900000000000000002",
          skuCode: "TZ-SASA-01",
          qty: 1,
          paidFen: 5800,
          province: "浙江省",
          city: "宁波市",
          maskedName: "李*",
          maskedPhone: "138****0002",
        },
      ],
      refundRows: [{ externalOrderId: "6900000000000000002", refundStatus: "refunded" }],
    },
  );

  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 200 },
    "admin.importDouyinLogistics",
    {
      rows: [
        { externalOrderId: "6900000000000000001", trackingNo: "ZT_EARLY_1" },
        { externalOrderId: "6900000000000000002", trackingNo: "ZT_CANCELLED_2" },
      ],
    },
  );

  const shipments = await db.find<ShipmentDoc>(COLLECTIONS.SHIPMENTS, () => true);
  assert.equal(
    shipments.length,
    0,
    `Must not create in_transit ShipmentDoc for confirming or cancelled_full packages, got: ${JSON.stringify(shipments)}`,
  );
});

test("F11: upsertStyleWithBom rejects non-existent or unapproved patternId up front", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 10, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  await seedCatalog(db, ports, adminToken, t0);

  const orphanStyle = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 100 },
    "admin.upsertStyle",
    {
      _id: "TZ-ORPHAN-PAT-01",
      name: "悬空图解款",
      standardMin: 90,
      patternId: "pat_does_not_exist_999",
      yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20 }],
      wasteRateBp: 1000,
      extraAccessoryCostFen: 100,
      yarnPoolAccrualFen: 400,
      craftFeeFen: 2800,
      weaverShipShareFen: 300,
    },
  );

  assert.equal(
    orphanStyle.ok,
    false,
    "admin.upsertStyle must reject non-existent patternId up front rather than failing after weaver accepts order",
  );
});

test("F12: cron.* rejects unauthenticated http_gateway callers while permitting timer and authenticated admin triggers", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 11, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const anonHttp = await dispatchCloudAction(
    { db, ports, invocationSource: "http_gateway", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "cron.weeklyGovernance",
    {},
  );
  assert.equal(anonHttp.ok, false, "Unauthenticated HTTP gateway caller must not trigger cron.*");

  const timerRes = await dispatchCloudAction(
    { db, ports, invocationSource: "timer", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "cron.weeklyGovernance",
    {},
  );
  assert.equal(timerRes.ok, true);

  const adminHttp = await dispatchCloudAction(
    { db, ports, invocationSource: "http_gateway", adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "cron.weeklyGovernance",
    {},
  );
  assert.equal(adminHttp.ok, true);
});
