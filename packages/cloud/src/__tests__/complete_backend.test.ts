import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  DAY_MS,
  HOUR_MS,
  LEDGER_ACCOUNT_CODES,
  MINUTE_MS,
  ZERO_FEN,
  asFen,
  type BagStickerDoc,
  type DispatchOfferDoc,
  type LedgerEntryDoc,
  type NotificationDoc,
  type OrderDoc,
  type OrderPackageDoc,
  type RecruitFunnelDoc,
  type ShipmentDoc,
  type SystemConfigDoc,
  type UserDoc,
  type WeaverStockDoc,
} from "@wxtz/shared";
import {
  InMemoryDb,
  bagStickerId,
  createCloudMainHandler,
  createMockExternalPorts,
  dispatchCloudAction,
  ledgerKeyDepositOut,
  ledgerKeyShipFee,
  reconcileWeaverAccount,
  recruitFunnelId,
  restockReminderId,
  shipmentId,
  signAdminJwt,
  weaverStockId,
  type WxCloudCollection,
  type WxCloudDatabase,
} from "../index.ts";

const SECRET = "wxtz-complete-backend-jwt-secret-2026";

async function onboardApprovedWeaverViaRouter(params: {
  db: InMemoryDb;
  ports: ReturnType<typeof createMockExternalPorts>;
  adminToken: string;
  openid: string;
  phone: string;
  weaverNo: string;
  province?: string;
  city?: string;
  pool?: "mp" | "live";
  nowUtcMs: number;
}): Promise<string> {
  const { db, ports, adminToken, openid, phone, weaverNo, nowUtcMs } = params;
  const login = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid, adminJwtSecret: SECRET, nowUtcMs },
    "auth.login",
    { phone, nickname: weaverNo },
  );
  assert.equal(login.ok, true);
  const weaverId = (login as any).data.user._id as string;

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid, adminJwtSecret: SECRET, nowUtcMs },
    "weaver.saveAddress",
    {
      contactName: `织女${weaverNo}`,
      contactPhone: phone,
      province: params.province ?? "浙江省",
      city: params.city ?? "杭州市",
      district: "余杭区",
      detail: "良渚文化村10号",
      isDefault: true,
    },
  );

  const s1 = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid, adminJwtSecret: SECRET, nowUtcMs },
    "weaver.funnelStep1",
    {
      province: params.province ?? "浙江省",
      city: params.city ?? "杭州市",
      quizCorrectCount: 8,
      portfolioPhotoFileIds: ["p1", "p2", "p3"],
    },
  );
  assert.equal(s1.ok, true);
  assert.equal((s1 as any).data.passedQuizAndRegion, true);

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
  const appRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.funnelApproveDeposit",
    {
      userId: weaverId,
      weaverNo,
      dailyCapacityMin: 300,
      base12Codes: ["YARN-WHITE-01", "YARN-MINT-03"],
      depositChannel: "mp_buyer_cashier",
      depositRefId: `DEP_${weaverNo}`,
    },
  );
  assert.equal(appRes.ok, true);

  // Set realName + bankCardEncrypted so 14-day bank batch payout works
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    weaverId,
    () => true,
    (u) => ({ ...u, verifyLevel: "payee", realName: `实名${weaverNo}`, bankCardEncrypted: `ENC_BANK_${weaverNo}` }),
  );

  if (params.pool === "live") {
    const prom = await dispatchCloudAction(
      { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
      "admin.promoteWeaverPool",
      { userId: weaverId, pool: "live" },
    );
    assert.equal(prom.ok, true);
  }
  return weaverId;
}

async function seedCatalogViaAdminRouter(
  db: InMemoryDb,
  ports: ReturnType<typeof createMockExternalPorts>,
  adminToken: string,
  nowUtcMs: number,
): Promise<{ productId: string }> {
  const y1 = await dispatchCloudAction(
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
  assert.equal(y1.ok, true);

  const y2 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertYarn",
    {
      _id: "YARN-MINT-03",
      name: "薄荷绿4股棉",
      brand: "江南线厂",
      itemType: "yarn",
      isBase12: true,
      isMaterialPack: false,
      unitWeightG: 50,
      unitCostFen: 600,
      supplierId: "SUP_JZH_01",
      supplierSkuCode: "JZH-4P-003",
      status: "active",
    },
  );
  assert.equal(y2.ok, true);

  const mod = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertPatternModule",
    {
      _id: "mod_body_01",
      name: "通用主体",
      category: "body",
      standardMin: 90,
      yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20, slotKey: "MAIN_COLOR" }],
      extraAccessoryCostFen: 100,
      steps: [{ rowNo: 1, text: "环起 6X", stitchCount: 6, imageFileId: "cloud://pat/step1.png" }],
      authorUserId: "usr_admin",
      status: "approved",
    },
  );
  assert.equal(mod.ok, true);

  const pat = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertPattern",
    {
      _id: "pat_sasa_mod",
      skuCode: "TZ-SASA-01",
      sourceModuleIds: ["mod_body_01"],
      colorSlotOverridesByModule: { mod_body_01: { MAIN_COLOR: "YARN-MINT-03" } },
      authorUserId: "usr_admin",
      status: "approved",
    },
  );
  assert.equal(pat.ok, true);

  const st = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertStyle",
    {
      _id: "TZ-SASA-01",
      name: "天真宝宝·薄荷sasa",
      standardMin: 90,
      patternId: "pat_sasa_mod",
      yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20 }],
      wasteRateBp: 1000,
      extraAccessoryCostFen: 100,
      yarnPoolAccrualFen: 400, // >= materialCostFen (ceil(22 * 500 / 50) + 100 = 320)
      craftFeeFen: 2800,
      weaverShipShareFen: 300,
    },
  );
  assert.equal(st.ok, true);
  assert.equal((st as any).data.materialCostFen, 320);

  const prod = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs },
    "admin.upsertProduct",
    {
      _id: "prod_sasa_01",
      skuCode: "TZ-SASA-01",
      saleType: "made_to_order",
      title: "天真宝宝·手作挂件",
      priceFen: 5800,
      buyerShipFeeFen: 0,
      isOnSale: true,
    },
  );
  assert.equal(prod.ok, true);
  return { productId: "prod_sasa_01" };
}

test("1. MP Kuaidi100 auto-pickup (privacyWaybill) -> picked_up (ship_fee + speedFactor) -> signed (7d + fulfilled), plus 3x pickup_failed -> manual_hold -> admin.reassignManualHold", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 24, 1, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin_01", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { productId } = await seedCatalogViaAdminRouter(db, ports, adminToken, t0);

  const w1Id = await onboardApprovedWeaverViaRouter({
    db,
    ports,
    adminToken,
    openid: "oid_w_kd1",
    phone: "13800010001",
    weaverNo: "WV001",
    nowUtcMs: t0,
  });
  // Give w1 high credit (130) to exercise reviewMode=skip 1-step direct seal + auto-pickup, and w2 standard credit
  await db.atomicUpdate<UserDoc>(COLLECTIONS.USERS, w1Id, () => true, (u) => ({ ...u, creditScore: 130 }));

  const w2Id = await onboardApprovedWeaverViaRouter({
    db,
    ports,
    adminToken,
    openid: "oid_w_kd2",
    phone: "13800010002",
    weaverNo: "WV002",
    nowUtcMs: t0,
  });

  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: w1Id, batchId: "B1", codes: ["BAG-W1-01", "BAG-W1-02"] },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: w2Id, batchId: "B2", codes: ["BAG-W2-01"] },
  );

  // Buyer logs in, saves address, creates & pays Order #1
  const bLogin = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_kd1", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "auth.login",
    { phone: "13900020001", nickname: "陈买家" },
  );
  const buyerId = (bLogin as any).data.user._id as string;

  const bAddr = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_kd1", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "buyer.saveAddress",
    {
      contactName: "陈买家",
      contactPhone: "13900020001",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
      detail: "安福路88号",
    },
  );
  const recvAddrId = (bAddr as any).data._id as string;

  const ord1Res = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_kd1", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.createOrder",
    { productId, receiverAddrId: recvAddrId, qty: 1 },
  );
  assert.equal(ord1Res.ok, true);
  const ord1Id = (ord1Res as any).data.order._id as string;

  const pay1 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "webhook.wxpay",
    { orderId: ord1Id, wxTransactionId: "WX_KD_001" },
  );
  const pkg1Id = (pay1 as any).data.packageId as string;

  // Dispatch -> w1 (credit 130 > w2 credit 100) gets offered -> accepts
  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 300 }, "cron.dispatchTick", {});
  const tAccept = t0 + 1000;
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_kd1", adminJwtSecret: SECRET, nowUtcMs: tAccept },
    "weaver.respondOffer",
    { packageId: pkg1Id, decision: "accept" },
  );

  // Head-of-queue pattern signed URL works with 5-min TTL + weaver watermark
  const patUrlRes = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_kd1", adminJwtSecret: SECRET, nowUtcMs: tAccept + 500 },
    "weaver.getPatternSignedUrl",
    { packageId: pkg1Id },
  );
  assert.equal(patUrlRes.ok, true);
  assert.equal((patUrlRes as any).data.urlExpiresAt, tAccept + 500 + 5 * MINUTE_MS);
  assert.match((patUrlRes as any).data.watermarkText, /WV001/);
  assert.match((patUrlRes as any).data.signedUrls["cloud://pat/step1.png"], /exp=/);

  // w1 finishes in 60 min (faster than 90 standardMin -> ratio 1.3) and submits 1-step skip seal -> auto-schedules Kuaidi100!
  const tShip = tAccept + 60 * MINUTE_MS;
  const sub1 = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_kd1", adminJwtSecret: SECRET, nowUtcMs: tShip },
    "weaver.submitFinishedWork",
    {
      packageId: pkg1Id,
      photoSlots: { frontOnScaleCard: "f1", backStitch: "b1", sidePlumpness: "s1" },
      imageHashes: ["h1_a", "h1_b", "h1_c"],
      bagStickerCode: "BAG-W1-01",
      sealedPhotoFileId: "seal_1",
      pickupWindow: "14:00-16:00",
    },
  );
  assert.equal(sub1.ok, true);
  assert.equal(ports.logs.pickups.length, 1);
  assert.equal((ports.logs.pickups[0] as any).privacyWaybill, true);

  const ship1Scheduled = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(pkg1Id));
  assert.equal(ship1Scheduled?.status, "pickup_scheduled");
  assert.equal(ship1Scheduled?.kuaidi100TaskId, `kd100_${pkg1Id}`);

  // Mini-Program client cannot spoof webhook.kuaidi100
  const spoofWh = await dispatchCloudAction(
    {
      db,
      ports,
      app: "mp-weaver",
      openid: "oid_w_kd1",
      invocationSource: "mp_client",
      adminJwtSecret: SECRET,
      nowUtcMs: tShip + 1000,
    },
    "webhook.kuaidi100",
    { taskId: `kd100_${pkg1Id}`, state: "picked_up", trackingNo: "FAKE" },
  );
  assert.equal(spoofWh.ok, false);
  if (!spoofWh.ok) assert.equal(spoofWh.code, "FORBIDDEN");

  // Real webhook.kuaidi100 picked_up -> moves to shipped, posts ship_fee ledger once, smooths speedFactor (1.0*0.9 + 1.3*0.1 = 1.03)
  const pickedWh = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tShip + 60_000 },
    "webhook.kuaidi100",
    {
      taskId: `kd100_${pkg1Id}`,
      state: "picked_up",
      trackingNo: "ZT9000111",
      carrierCode: "zhongtong",
      shippingCostFen: 650,
    },
  );
  assert.equal(pickedWh.ok, true);
  assert.equal((pickedWh as any).data.packageStatus, "shipped");
  assert.equal((pickedWh as any).data.shipmentStatus, "in_transit");

  // Duplicate picked_up delivery is idempotent
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tShip + 65_000 },
    "webhook.kuaidi100",
    { taskId: `kd100_${pkg1Id}`, state: "picked_up", trackingNo: "ZT9000111", shippingCostFen: 650 },
  );
  const shipFeeEntry = await db.get<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, ledgerKeyShipFee(pkg1Id));
  assert.ok(shipFeeEntry);
  assert.equal(shipFeeEntry.lines[0]?.accountCode, LEDGER_ACCOUNT_CODES.EXP_SHIPPING_PLATFORM);
  assert.equal(shipFeeEntry.lines[0]?.debitFen, 650);
  assert.equal(shipFeeEntry.lines[1]?.accountCode, LEDGER_ACCOUNT_CODES.ASSET_KD100_PREPAID);
  assert.equal(shipFeeEntry.lines[1]?.creditFen, 650);

  const w1AfterShip = await db.get<UserDoc>(COLLECTIONS.USERS, w1Id);
  assert.equal(w1AfterShip?.speedFactor, 1.03);

  // webhook.kuaidi100 signed -> sets 7d settleEligibleAt & marks OrderDoc fulfilled
  const tSign = tShip + DAY_MS;
  const signedWh = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tSign },
    "webhook.kuaidi100",
    { taskId: `kd100_${pkg1Id}`, state: "signed" },
  );
  assert.equal(signedWh.ok, true);
  const pkg1Signed = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkg1Id);
  const ord1Fulfilled = await db.get<OrderDoc>(COLLECTIONS.ORDERS, ord1Id);
  assert.equal(pkg1Signed?.status, "signed");
  assert.equal(pkg1Signed?.settleEligibleAt, tSign + 7 * DAY_MS);
  assert.equal(ord1Fulfilled?.status, "fulfilled");

  // Now Order #2: test 3x pickup_failed -> manual_hold -> admin.reassignManualHold recovery!
  const ord2Res = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_kd1", adminJwtSecret: SECRET, nowUtcMs: tSign + 100 },
    "buyer.createOrder",
    { productId, receiverAddrId: recvAddrId, qty: 1 },
  );
  const ord2Id = (ord2Res as any).data.order._id as string;
  const pay2 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tSign + 200 },
    "webhook.wxpay",
    { orderId: ord2Id, wxTransactionId: "WX_KD_002" },
  );
  const pkg2Id = (pay2 as any).data.packageId as string;

  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: tSign + 300 }, "cron.dispatchTick", {});
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_kd1", adminJwtSecret: SECRET, nowUtcMs: tSign + 400 },
    "weaver.respondOffer",
    { packageId: pkg2Id, decision: "accept" },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_kd1", adminJwtSecret: SECRET, nowUtcMs: tSign + 3600_000 },
    "weaver.submitFinishedWork",
    {
      packageId: pkg2Id,
      photoSlots: { frontOnScaleCard: "f2", backStitch: "b2", sidePlumpness: "s2" },
      imageHashes: ["h2_a", "h2_b", "h2_c"],
      bagStickerCode: "BAG-W1-02",
      sealedPhotoFileId: "seal_2",
    },
  );

  // Fail 1 & Fail 2 auto-retry and stay in pickup_scheduled / ready_to_ship
  const f1 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tSign + 3700_000 },
    "webhook.kuaidi100",
    { packageId: pkg2Id, state: "pickup_failed" },
  );
  assert.equal((f1 as any).data.movedToManualHold, false);
  assert.equal((f1 as any).data.shipmentStatus, "pickup_scheduled");

  const f2 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tSign + 3800_000 },
    "webhook.kuaidi100",
    { packageId: pkg2Id, state: "pickup_failed" },
  );
  assert.equal((f2 as any).data.movedToManualHold, false);
  assert.equal((f2 as any).data.retries, 2);

  // Fail 3 (> 2 retries) cancels shipment & escalates package to manual_hold
  const f3 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tSign + 3900_000 },
    "webhook.kuaidi100",
    { packageId: pkg2Id, state: "pickup_failed" },
  );
  assert.equal((f3 as any).data.movedToManualHold, true);
  assert.equal((f3 as any).data.shipmentStatus, "cancelled");
  assert.equal((f3 as any).data.packageStatus, "manual_hold");

  // Anti-self-order check even on manual reassignment (if buyer were approved weaver)
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    buyerId,
    () => true,
    (u) => ({ ...u, roles: ["buyer", "weaver"], funnelStage: "approved" }),
  );
  const selfReassign = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tSign + 4000_000 },
    "admin.reassignManualHold",
    { packageId: pkg2Id, targetWeaverId: buyerId },
  );
  assert.equal(selfReassign.ok, false);
  if (!selfReassign.ok) assert.equal(selfReassign.code, "SELF_ORDER_FORBIDDEN");

  // Reassign directly to w2 -> voids old bag sticker BAG-W1-02, offers to w2, w2 accepts cleanly!
  const reassignRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tSign + 4100_000 },
    "admin.reassignManualHold",
    { packageId: pkg2Id, targetWeaverId: w2Id },
  );
  assert.equal(reassignRes.ok, true);
  assert.equal((reassignRes as any).data.package.status, "offered");
  assert.equal((reassignRes as any).data.package.assignedWeaverId, w2Id);

  const oldSticker = await db.get<BagStickerDoc>(COLLECTIONS.BAG_STICKERS, bagStickerId("BAG-W1-02"));
  assert.equal(oldSticker?.status, "void");

  const w2Accept = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_kd2", adminJwtSecret: SECRET, nowUtcMs: tSign + 4200_000 },
    "weaver.respondOffer",
    { packageId: pkg2Id, decision: "accept" },
  );
  assert.equal(w2Accept.ok, true);
  assert.equal((w2Accept as any).data.status, "making");

  // Also verify reassignManualHold WITHOUT targetWeaverId keeps attemptCount monotonic (no offer ID collision) and resets attempt budget via lastManualResetAttempt
  await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_hold_pool",
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: [],
    externalOrderIds: [],
    buyerProvince: "浙江省",
    buyerCity: "杭州市",
    itemsSnapshot: [
      {
        skuCode: "TZ-SASA-01",
        qty: 1,
        standardMin: 90,
        yarnBomSnapshot: [{ yarnCode: "YARN-WHITE-01", consumedG: 22 }],
        materialCostFen: asFen(320),
        craftFeeFen: asFen(2800),
        yarnPoolAccrualFen: asFen(400),
        weaverShipShareFen: asFen(300),
        saleType: "made_to_order",
      },
    ],
    totalMin: 90,
    status: "manual_hold",
    isReadyStockReuse: false,
    attemptCount: 5,
    reviewMode: "required",
    dispatchableAt: t0,
    version: 3,
    updatedAt: t0,
  });
  const poolReset = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tSign + 4300_000 },
    "admin.reassignManualHold",
    { packageId: "pkg_hold_pool" },
  );
  assert.equal(poolReset.ok, true);
  assert.equal((poolReset as any).data.package.status, "waiting_dispatch");
  assert.equal((poolReset as any).data.package.attemptCount, 5);
  assert.equal((poolReset as any).data.package.lastManualResetAttempt, 5);
});

test("2. Douyin admin.importDouyinLogistics advances ready_to_ship -> shipped -> signed and clamps speedFactor in [0.6, 1.3]", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 24, 2, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin_dy", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  await seedCatalogViaAdminRouter(db, ports, adminToken, t0);
  const weaverId = await onboardApprovedWeaverViaRouter({
    db,
    ports,
    adminToken,
    openid: "oid_w_dy",
    phone: "13800030001",
    weaverNo: "WVDY1",
    pool: "live",
    nowUtcMs: t0,
  });
  await db.atomicUpdate<UserDoc>(COLLECTIONS.USERS, weaverId, () => true, (u) => ({ ...u, creditScore: 130 }));
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId, batchId: "BDY", codes: ["BAG-DY-01"] },
  );

  const imp = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 100 },
    "admin.commitDouyinCsv",
    {
      confirmZeroRefundsToday: true,
      dispatchableAtMs: t0 + 100,
      orderRows: [
        {
          externalOrderId: "6912345678901234567",
          skuCode: "TZ-SASA-01",
          qty: 1,
          paidFen: 5800,
          province: "浙江省",
          city: "宁波市",
          maskedName: "王*",
          maskedPhone: "135****1234",
        },
      ],
    },
  );
  assert.equal(imp.ok, true);

  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 200 }, "cron.dispatchTick", {});
  const pkgs = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, () => true);
  const pkgId = pkgs[0]!._id;

  const tAccept = t0 + 1000;
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_dy", adminJwtSecret: SECRET, nowUtcMs: tAccept },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );

  // Weaver takes 10 hours (600 min vs 90 standardMin -> raw 0.15 clamped to floor 0.6; 1.0*0.9 + 0.6*0.1 = 0.96)
  const tSeal = tAccept + 10 * HOUR_MS;
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_dy", adminJwtSecret: SECRET, nowUtcMs: tSeal },
    "weaver.submitFinishedWork",
    {
      packageId: pkgId,
      photoSlots: { frontOnScaleCard: "f", backStitch: "b", sidePlumpness: "s" },
      imageHashes: ["hd1", "hd2", "hd3"],
      bagStickerCode: "BAG-DY-01",
      sealedPhotoFileId: "seal_dy",
    },
  );

  // Scientific notation externalOrderId is rejected
  const badCsv = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tSeal + 1000 },
    "admin.importDouyinLogistics",
    { rows: [{ externalOrderId: "6.91235E+18", trackingNo: "ZT1" }] },
  );
  assert.equal(badCsv.ok, false);
  if (!badCsv.ok) assert.equal(badCsv.code, "VALIDATION_ERROR");

  // Step 1: Import waybill trackingNo -> ready_to_ship -> shipped
  const tShip = tSeal + 30 * MINUTE_MS;
  const log1 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tShip },
    "admin.importDouyinLogistics",
    {
      rows: [
        { externalOrderId: "6912345678901234567", trackingNo: "ZT777888999", carrierCode: "zhongtong" },
        { externalOrderId: "6999999999999999999", trackingNo: "ZT000" },
      ],
    },
  );
  assert.equal(log1.ok, true);
  assert.equal((log1 as any).data.shippedUpdated, 1);
  assert.deepEqual((log1 as any).data.notFoundIds, ["6999999999999999999"]);

  const weaverAfterShip = await db.get<UserDoc>(COLLECTIONS.USERS, weaverId);
  assert.equal(weaverAfterShip?.speedFactor, 0.96);

  // Step 2: Import signoff -> shipped -> signed + OrderDoc fulfilled
  const tSigned = tShip + 2 * DAY_MS;
  const log2 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tSigned },
    "admin.importDouyinLogistics",
    { rows: [{ externalOrderId: "6912345678901234567", signedAtMs: tSigned }] },
  );
  assert.equal(log2.ok, true);
  assert.equal((log2 as any).data.signedUpdated, 1);

  const finalPkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkgId);
  const finalShip = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(pkgId));
  const ords = await db.find<OrderDoc>(COLLECTIONS.ORDERS, () => true);
  assert.equal(finalPkg?.status, "signed");
  assert.equal(finalPkg?.settleEligibleAt, tSigned + 7 * DAY_MS);
  assert.equal(finalShip?.status, "signed");
  assert.equal(ords[0]?.status, "fulfilled");
});

test("3. Master data CRUD enforces yarnPoolAccrualFen >= materialCostFen, deduplicates bag stickers, and setConfig unlocks new recruit regions", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 24, 3, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin_cat", role: "admin", exp: t0 + 24 * HOUR_MS }, SECRET);

  await seedCatalogViaAdminRouter(db, ports, adminToken, t0);

  // Reject style where yarnPoolAccrualFen (200) < computed materialCostFen (320)
  const deficitStyle = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.upsertStyle",
    {
      _id: "TZ-DEFICIT-01",
      name: "亏空测试款",
      standardMin: 60,
      patternId: "pat_sasa_mod",
      yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20 }],
      wasteRateBp: 1000,
      extraAccessoryCostFen: 100,
      yarnPoolAccrualFen: 200,
      craftFeeFen: 2000,
    },
  );
  assert.equal(deficitStyle.ok, false);
  if (!deficitStyle.ok) assert.equal(deficitStyle.code, "VALIDATION_ERROR");

  // Reject product referencing non-existent style
  const orphanProd = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.upsertProduct",
    { skuCode: "NO-SUCH-SKU", saleType: "made_to_order", title: "孤儿商品", priceFen: 3900 },
  );
  assert.equal(orphanProd.ok, false);
  if (!orphanProd.ok) assert.equal(orphanProd.code, "NOT_FOUND");

  // Bag sticker batch deduplication
  const wId = await onboardApprovedWeaverViaRouter({
    db,
    ports,
    adminToken,
    openid: "oid_w_stk",
    phone: "13800040001",
    weaverNo: "WVSTK",
    nowUtcMs: t0,
  });
  const b1 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId: wId, batchId: "BATCH_A", codes: ["S1", "S2", "S2"] },
  );
  assert.deepEqual((b1 as any).data, { createdCount: 2, skippedCount: 1 });

  // Dynamic recruit region config: unlock sw_ygc (Sichuan) and verify Sichuan applicant passes funnelStep1
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.setConfig",
    { key: "recruit", value: { activeRecruitRegions: ["jzh", "sw_ygc"] } },
  );
  const gotCfg = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.getConfig",
    { key: "recruit" },
  );
  assert.equal(gotCfg.ok, true);
  assert.deepEqual((gotCfg as any).data.value.activeRecruitRegions, ["jzh", "sw_ygc"]);

  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_sc", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "auth.login",
    { phone: "13800040099", nickname: "成都巧手" },
  );
  const scStep1 = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_sc", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "weaver.funnelStep1",
    { province: "四川省", city: "成都市", quizCorrectCount: 8, portfolioPhotoFileIds: ["a", "b", "c"] },
  );
  assert.equal(scStep1.ok, true);
  assert.equal((scStep1 as any).data.passedQuizAndRegion, true);
});

test("4. Tickets, restock watch, order-acceptance toggle, and weaver deposit exit (blocked until 7d + payout settled, 100% ledger reconciliation)", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 24, 4, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin_gov", role: "admin", exp: t0 + 30 * DAY_MS }, SECRET);

  const { productId } = await seedCatalogViaAdminRouter(db, ports, adminToken, t0);
  const weaverId = await onboardApprovedWeaverViaRouter({
    db,
    ports,
    adminToken,
    openid: "oid_w_exit",
    phone: "13800050001",
    weaverNo: "WVEXIT",
    nowUtcMs: t0,
  });
  await db.atomicUpdate<UserDoc>(COLLECTIONS.USERS, weaverId, () => true, (u) => ({ ...u, creditScore: 130 }));
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 },
    "admin.generateBagStickers",
    { weaverId, batchId: "BEXIT", codes: ["BAG-EXIT-01"] },
  );

  // Buyer login, restock watch subscription (deterministic idempotency), and ticket workflow
  const bLogin = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_exit", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "auth.login",
    { phone: "13900050002", nickname: "苏买家" },
  );
  const buyerId = (bLogin as any).data.user._id as string;

  const sub1 = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_exit", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "buyer.subscribeRestock",
    { productId },
  );
  const sub2 = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_exit", adminJwtSecret: SECRET, nowUtcMs: t0 + 50 },
    "buyer.subscribeRestock",
    { productId },
  );
  assert.equal((sub1 as any).data._id, restockReminderId(buyerId, "TZ-SASA-01"));
  assert.equal((sub2 as any).data._id, (sub1 as any).data._id);

  const bTkt = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_exit", adminJwtSecret: SECRET, nowUtcMs: t0 + 100 },
    "buyer.submitTicket",
    { type: "after_sale", content: "想确认礼盒贺卡能否代写", photoFileIds: ["tkt_img_1"] },
  );
  const wTkt = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_exit", adminJwtSecret: SECRET, nowUtcMs: t0 + 200 },
    "weaver.submitTicket",
    { type: "pattern_bug", content: "第1行针数图示很清晰，建议加注记号扣提示" },
  );
  assert.equal(bTkt.ok, true);
  assert.equal(wTkt.ok, true);

  const myBuyerTkts = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_exit", adminJwtSecret: SECRET, nowUtcMs: t0 + 300 },
    "buyer.myTickets",
    {},
  );
  assert.equal((myBuyerTkts as any).data.length, 1);

  const ovBefore = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 300 },
    "admin.overview",
    {},
  );
  assert.equal((ovBefore as any).data.openTicketsCount, 2);

  const openList = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 350 },
    "admin.listTickets",
    { status: "open" },
  );
  assert.equal((openList as any).data.length, 2);

  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 400 },
    "admin.resolveTicket",
    { ticketId: (bTkt as any).data._id, reply: "可以免费附赠手写祝福卡", nextStatus: "resolved" },
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 450 },
    "admin.resolveTicket",
    { ticketId: (wTkt as any).data._id, reply: "已采纳并更新图解备注", nextStatus: "resolved" },
  );
  const ovAfter = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 500 },
    "admin.overview",
    {},
  );
  assert.equal((ovAfter as any).data.openTicketsCount, 0);

  // Place & fulfill an order so weaver has a `signed` package
  const addrRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_exit", adminJwtSecret: SECRET, nowUtcMs: t0 + 600 },
    "buyer.saveAddress",
    { contactName: "苏买家", contactPhone: "13900050002", province: "浙江省", city: "绍兴市", district: "越城区", detail: "鲁迅中路1号" },
  );
  const ordRes = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b_exit", adminJwtSecret: SECRET, nowUtcMs: t0 + 700 },
    "buyer.createOrder",
    { productId, receiverAddrId: (addrRes as any).data._id, qty: 1 },
  );
  const payRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 800 },
    "webhook.wxpay",
    { orderId: (ordRes as any).data.order._id, wxTransactionId: "WX_EXIT_1" },
  );
  const pkgId = (payRes as any).data.packageId as string;

  await dispatchCloudAction({ db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + 900 }, "cron.dispatchTick", {});
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_exit", adminJwtSecret: SECRET, nowUtcMs: t0 + 1000 },
    "weaver.respondOffer",
    { packageId: pkgId, decision: "accept" },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_exit", adminJwtSecret: SECRET, nowUtcMs: t0 + 3600_000 },
    "weaver.submitFinishedWork",
    {
      packageId: pkgId,
      photoSlots: { frontOnScaleCard: "f", backStitch: "b", sidePlumpness: "s" },
      imageHashes: ["he1", "he2", "he3"],
      bagStickerCode: "BAG-EXIT-01",
      sealedPhotoFileId: "seal_exit",
    },
  );
  const tSigned = t0 + DAY_MS;
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tSigned },
    "webhook.kuaidi100",
    { packageId: pkgId, state: "signed", trackingNo: "ZT_EXIT_1" },
  );

  // Weaver toggles acceptingOrders=false to prepare for exit
  const toggleRes = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_exit", adminJwtSecret: SECRET, nowUtcMs: tSigned + 100 },
    "weaver.setAcceptingOrders",
    { acceptingOrders: false, restDays: ["2026-11-30"] },
  );
  assert.equal(toggleRes.ok, true);
  assert.equal((toggleRes as any).data.acceptingOrders, false);

  // Attempt deposit exit while package is still `signed` (< 7d unsettled) -> BLOCKED!
  const prematureExit = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_exit", adminJwtSecret: SECRET, nowUtcMs: tSigned + 2 * DAY_MS },
    "weaver.requestDepositExit",
    {},
  );
  assert.equal(prematureExit.ok, false);
  if (!prematureExit.ok) assert.equal(prematureExit.code, "VALIDATION_ERROR");

  // Advance 7 days -> settle_ready -> 14d bank payout paid -> settled!
  const tSettle = tSigned + 8 * DAY_MS;
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: tSettle },
    "cron.dailySettleAndReconcile",
    {},
  );
  const batchExp = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tSettle + 100 },
    "admin.exportBankPayoutCsv",
    {},
  );
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: tSettle + 200 },
    "admin.confirmBankPayoutPaid",
    { batchId: (batchExp as any).data.batchId },
  );

  // Now weaver deposit exit SUCCEEDS, refunding 20,000 Fen with 100% zero-diff ledger reconciliation!
  const okExit = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_exit", adminJwtSecret: SECRET, nowUtcMs: tSettle + 300 },
    "weaver.requestDepositExit",
    {},
  );
  assert.equal(okExit.ok, true);
  assert.equal((okExit as any).data.refundedFen, 20000);

  const depOutEntry = await db.get<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, ledgerKeyDepositOut(weaverId));
  assert.ok(depOutEntry);
  assert.equal(depOutEntry.eventType, "deposit_out");

  const funnelAfter = await db.get<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, recruitFunnelId(weaverId));
  assert.equal(funnelAfter?.depositStatus, "refunded");

  const recon = await reconcileWeaverAccount(db, weaverId);
  assert.equal(recon.ok, true);
  assert.equal(recon.snapshot.depositFen, ZERO_FEN);
  assert.equal(recon.snapshot.payableBalanceFen, ZERO_FEN);
});

test("5. Watchdog 10m SMS (idempotent), dailyDueAndStockAlert (¥80k tax alert + 7d stock + 48h due), weeklyGovernance, and Timer triggers", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  // 2026-11-23 01:00 UTC = Monday 09:00 CST
  const t0 = Date.UTC(2026, 10, 23, 1, 0, 0);
  const adminToken = signAdminJwt({ sub: "usr_admin_cron", role: "admin", exp: t0 + 7 * DAY_MS }, SECRET);

  await seedCatalogViaAdminRouter(db, ports, adminToken, t0);
  const weaverId = await onboardApprovedWeaverViaRouter({
    db,
    ports,
    adminToken,
    openid: "oid_w_cron",
    phone: "13800060001",
    weaverNo: "WVCRON",
    pool: "live",
    nowUtcMs: t0,
  });

  // 1. Seed a pending offer with 8 minutes remaining -> fiveMinuteWatchdog sends SMS once and never duplicates
  await db.insert<DispatchOfferDoc>(COLLECTIONS.DISPATCH_OFFERS, {
    _id: "offer_pkg_sms_1",
    packageId: "pkg_sms",
    attemptNo: 1,
    weaverId,
    matchTier: "same_region",
    status: "pending",
    offeredAt: t0 - 52 * MINUTE_MS,
    expireAt: t0 + 8 * MINUTE_MS,
    yarnAvailabilityConfirmed: false,
    version: 1,
  });

  const wd1 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 },
    "cron.fiveMinuteWatchdog",
    {},
  );
  assert.equal(wd1.ok, true);
  assert.equal((wd1 as any).data.smsReminders.smsSentCount, 1);

  const wd2 = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 + MINUTE_MS },
    "cron.fiveMinuteWatchdog",
    {},
  );
  assert.equal((wd2 as any).data.smsReminders.smsSentCount, 0);
  const smsLogs = await db.find<NotificationDoc>(COLLECTIONS.NOTIFICATIONS, (n) => n.scene === "offer_10m_reminder");
  assert.equal(smsLogs.length, 1);

  // 2. Seed near-due package (due in 20h <= 48h), 8-day-old ready stock, and ¥82,000 paid sales in current CST month
  await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_near_due_1",
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: ["ord_big_1"],
    externalOrderIds: [],
    buyerProvince: "浙江省",
    buyerCity: "杭州市",
    itemsSnapshot: [
      {
        skuCode: "TZ-SASA-01",
        qty: 2,
        standardMin: 90,
        yarnBomSnapshot: [],
        materialCostFen: asFen(320),
        craftFeeFen: asFen(2800),
        yarnPoolAccrualFen: asFen(400),
        weaverShipShareFen: asFen(300),
        saleType: "made_to_order",
      },
    ],
    totalMin: 180,
    status: "making",
    assignedWeaverId: weaverId,
    queueSeq: 1,
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    dispatchableAt: t0 - DAY_MS,
    dueAt: t0 + 20 * HOUR_MS,
    version: 1,
    updatedAt: t0,
  });

  // Seed 20 completed packages in last 28 days for 1 active weaver -> avgWeekly = 20 / 1 / 4 = 5.0 >= 4 -> recommendOpenRecruitment = true!
  for (let i = 0; i < 20; i++) {
    await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
      _id: `pkg_done_${i}`,
      channel: "mp_wechat",
      poolTarget: "mp",
      orderIds: [],
      externalOrderIds: [],
      buyerProvince: "浙江省",
      buyerCity: "杭州市",
      itemsSnapshot: [],
      totalMin: 90,
      status: "settled",
      assignedWeaverId: weaverId,
      isReadyStockReuse: false,
      attemptCount: 1,
      reviewMode: "skip",
      dispatchableAt: t0 - 10 * DAY_MS,
      shippedAt: t0 - 5 * DAY_MS,
      version: 4,
      updatedAt: t0 - 5 * DAY_MS,
    });
  }

  await db.insert<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, {
    _id: weaverStockId(weaverId, "TZ-SASA-01"),
    weaverId,
    skuCode: "TZ-SASA-01",
    availableQty: 1,
    reservedQty: 0,
    reservations: [],
    items: [{ sourceType: "cancelled_order", createdAt: t0 - 8 * DAY_MS }],
    oldestCreatedAt: t0 - 8 * DAY_MS,
    version: 1,
    updatedAt: t0 - 8 * DAY_MS,
  });

  await db.insert<OrderDoc>(COLLECTIONS.ORDERS, {
    _id: "ord_big_1",
    channel: "douyin_online",
    skuCode: "TZ-SASA-01",
    qty: 100,
    totalPaidFen: asFen(8_200_000), // ¥82,000.00 >= ¥80,000.00 alert threshold
    buyerShipFeeFen: ZERO_FEN,
    status: "paid",
    paidAt: t0 - DAY_MS,
    createdAt: t0 - DAY_MS,
    updatedAt: t0 - DAY_MS,
  });

  // Mini-program client blocked from both new crons
  const mpCronBlocked = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_x", invocationSource: "mp_client", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "cron.dailyDueAndStockAlert",
    {},
  );
  assert.equal(mpCronBlocked.ok, false);

  const alertRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 },
    "cron.dailyDueAndStockAlert",
    {},
  );
  assert.equal(alertRes.ok, true);
  assert.deepEqual((alertRes as any).data.nearDuePackageIds, ["pkg_near_due_1"]);
  assert.deepEqual((alertRes as any).data.staleStockDocIds, [weaverStockId(weaverId, "TZ-SASA-01")]);
  assert.equal((alertRes as any).data.currentMonthSalesFen, 8_200_000);
  assert.equal((alertRes as any).data.taxAlertTriggered, true);

  const govRes = await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, nowUtcMs: t0 },
    "cron.weeklyGovernance",
    {},
  );
  assert.equal(govRes.ok, true);
  assert.equal((govRes as any).data.activeWeaverCount, 1);
  assert.equal((govRes as any).data.recent4WeekPackages, 20);
  assert.equal((govRes as any).data.avgWeeklyOrdersPerWeaver, 5);
  assert.equal((govRes as any).data.recommendOpenRecruitment, true);
  assert.equal((govRes as any).data.unaccruedInFlightCraftFen, 5600); // 2 * 2800 Fen

  const savedGate = await db.get<SystemConfigDoc>(COLLECTIONS.CONFIG, "recruitGate");
  assert.equal(savedGate?.recommendOpenRecruitment, true);

  // 3. Verify createCloudMainHandler Timer trigger mapping for dueAndStockAlertDaily9am & weeklyGovernanceMonday9am
  const rawStore = new Map<string, Map<string, Record<string, unknown>>>();
  const colOf = (name: string) => {
    let m = rawStore.get(name);
    if (!m) {
      m = new Map();
      rawStore.set(name, m);
    }
    return m;
  };
  const mockWxDb: WxCloudDatabase = {
    collection(name: string): WxCloudCollection {
      const c = colOf(name);
      return {
        doc(id: string) {
          return {
            async get() {
              const v = c.get(id);
              return v ? { data: structuredClone(v) } : {};
            },
            async set({ data }) {
              c.set(id, structuredClone(data));
            },
            async remove() {
              return { stats: { removed: c.delete(id) ? 1 : 0 } };
            },
          };
        },
        async add({ data }) {
          const id = String(data._id ?? "");
          if (c.has(id)) throw new Error("duplicate -502001");
          const cp = structuredClone(data);
          delete cp._id;
          c.set(id, cp);
        },
        where() {
          return {
            limit(n: number) {
              return {
                async get() {
                  const arr: unknown[] = [];
                  for (const [id, doc] of c.entries()) {
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
      return fn(mockWxDb);
    },
  };

  const main = createCloudMainHandler({
    wxCloud: {
      DYNAMIC_CURRENT_ENV: "DYNAMIC",
      init() {},
      database() {
        return mockWxDb;
      },
      getWXContext() {
        return {}; // Timer trigger has empty OPENID
      },
    },
    ports,
    adminJwtSecret: SECRET,
  });

  const timerDaily = await main({ Type: "Timer", TriggerName: "dueAndStockAlertDaily9am" });
  assert.equal(timerDaily.ok, true);
  assert.equal((timerDaily as any).data.taxAlertThresholdFen, 8_000_000);

  const timerWeekly = await main({ Type: "Timer", TriggerName: "weeklyGovernanceMonday9am" });
  assert.equal(timerWeekly.ok, true);
  assert.equal((timerWeekly as any).data.activeWeaverCount, 0);
});
