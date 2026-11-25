import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  DAY_MS,
  ERROR_CODES,
  HOUR_MS,
  LEDGER_ACCOUNT_CODES,
  MINUTE_MS,
  ZERO_FEN,
  asFen,
  computeSafeLiveStockPlan,
  computeWeaverStyleUnits,
  estimateAvailableGrams,
  formatCstYmd,
  type AddressDoc,
  type BagStickerDoc,
  type LedgerEntryDoc,
  type OrderDoc,
  type OrderPackageDoc,
  type PatternDoc,
  type PhotoReviewDoc,
  type ProductDoc,
  type ShipmentDoc,
  type StyleDoc,
  type StyleEnrollmentDoc,
  type UserDoc,
  type VolunteerDoc,
  type WeaverStockDoc,
  type YarnCatalogDoc,
} from "@wxtz/shared";
import {
  InMemoryDb,
  WxCloudDbAdapter,
  accrueSettledPackage,
  activateFanVolunteerAfterExam,
  bagStickerId,
  cancelWeeklyYarnClaim,
  castVolunteerVote,
  checkProductSellability,
  commitDouyinImport,
  confirmSettlementBatchPaid,
  confirmYarnClaimReceived,
  consumeYarnForPackage,
  createBase12Inventory,
  createCloudMainHandler,
  createMockExternalPorts,
  createMpBuyerOrder,
  createSettlementBatchAndExportBankCsv,
  dispatchCloudAction,
  dispatchPoolTick,
  exportSupplierCsvAndMarkDispatched,
  getHeadPatternForWeaver,
  handleWxPaySuccessWebhook,
  loginOrMergeUser,
  postLedgerEntry,
  previewDouyinImport,
  reconcileWeaverAccount,
  recordWeaverDeposit,
  refundWeaverDeposit,
  releaseExpiredReservations,
  releaseMakingOrderVoluntarily,
  requestMpBuyerRefund,
  resolvePendingRefundByAdmin,
  respondDispatchOffer,
  shipmentId,
  signAdminJwt,
  styleEnrollmentId,
  submitFinishedWork,
  submitWeeklyYarnClaim,
  sweepOffersAndStalledPackages,
  sweepPhotoReviewSla,
  sweepSettleEligiblePackages,
  verifyAdminJwt,
  volunteerId,
  weaverStockId,
  type WxCloudCollection,
  type WxCloudDatabase,
} from "../index.ts";

const SECRET = "wxtz-interrogate-regression-jwt-secret-2026";

async function seedBaseCatalog(db: InMemoryDb, t0: number): Promise<void> {
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
}

test("R01-R03: CloudBase trigger boundary, caller-app isolation, phone takeover protection, and JWT secret floor", async () => {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const getCol = (name: string) => {
    let m = store.get(name);
    if (!m) {
      m = new Map();
      store.set(name, m);
    }
    return m;
  };
  const mockDb: WxCloudDatabase = {
    collection(name: string): WxCloudCollection {
      const col = getCol(name);
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
              return { stats: { removed: col.delete(id) ? 1 : 0 } };
            },
          };
        },
        async add({ data }) {
          const id = String(data._id ?? "");
          if (col.has(id)) throw new Error("errCode: -502001 duplicate key error");
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

  let wxCtx: { OPENID?: string; UNIONID?: string; APPID?: string } = {
    OPENID: "oid_alice_weaver",
    UNIONID: "uid_alice",
    APPID: "wx_weaver_app",
  };
  const main = createCloudMainHandler({
    wxCloud: {
      DYNAMIC_CURRENT_ENV: "DYNAMIC",
      init() {},
      database: () => mockDb,
      getWXContext: () => wxCtx,
    },
    adminJwtSecret: SECRET,
    appByAppId: { wx_weaver_app: "mp-weaver", wx_buyer_app: "mp-buyer" },
  });

  // Alice registers on mp-weaver
  const alice = await main({ action: "auth.login", payload: { phone: "13800138000" } });
  assert.equal(alice.ok, true);

  // MP caller cannot invoke webhook or cron
  const mpWebhook = await main({ action: "webhook.wxpay", payload: { orderId: "ord_1", wxTransactionId: "TX" } });
  const mpCron = await main({ action: "cron.dispatchTick", payload: {} });
  assert.equal(mpWebhook.ok, false);
  assert.equal(mpCron.ok, false);

  // Attacker on mp-buyer spoofs app="mp-weaver" + Alice's phone + forged unionid -> blocked
  wxCtx = { OPENID: "oid_attacker", UNIONID: "uid_attacker", APPID: "wx_buyer_app" };
  const takeover = await main({
    action: "auth.login",
    app: "mp-weaver",
    payload: { phone: "13800138000", unionid: "uid_forged" },
  });
  assert.equal(takeover.ok, false);

  // Alice retains access
  wxCtx = { OPENID: "oid_alice_weaver", UNIONID: "uid_alice", APPID: "wx_weaver_app" };
  const aliceDash = await main({ action: "weaver.dashboard" });
  assert.equal(aliceDash.ok, true);

  // Real CloudBase Timer event (Type: "Timer", TriggerName) succeeds
  wxCtx = {};
  const timerRes = await main({ Type: "Timer", TriggerName: "dispatchTickEveryMinute" } as any);
  assert.equal(timerRes.ok, true);

  // verifyAdminJwt enforces >=16-char secret
  assert.throws(() => verifyAdminJwt("a.b.c", "short", Date.now()), /at least 16 chars/);
});

test("R04-R07: Server-controlled self-ship tariff & EXP_SHIPPING_PLATFORM split, ledger overdraft atomicity, and versioned yarn claim resubmission", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 24, 1, 0, 0);
  await seedBaseCatalog(db, t0);

  // R06: Overdraft rejection BEFORE ledger insert preserves 100% reconciliation and allows later deposit + refund
  const wOverdraft = "usr_r06";
  await assert.rejects(
    () => refundWeaverDeposit(db, wOverdraft, LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, t0),
    /rejected negative balance delta/,
  );
  const recAfterFail = await reconcileWeaverAccount(db, wOverdraft);
  assert.equal(recAfterFail.ok, true);
  assert.equal(recAfterFail.computed.depositFen, 0);

  await recordWeaverDeposit(db, wOverdraft, LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, t0 + 10);
  const legitExit = await refundWeaverDeposit(db, wOverdraft, LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, t0 + 20);
  assert.equal(legitExit.posted, true);
  assert.equal((await reconcileWeaverAccount(db, wOverdraft)).ok, true);

  // R07: Cancelled weekly yarn claim resubmission charges versioned key and blocks overdraft
  const wLogin = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_r04", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "auth.login",
    { phone: "13600000407" },
  );
  const wId = (wLogin as any).data.user._id as string;
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    wId,
    () => true,
    (u) => ({
      ...u,
      funnelStage: "approved",
      shippingMode: "self_dropoff",
      creditScore: 130,
      acceptingOrders: true,
      dailyCapacityMin: 300,
    }),
  );
  await db.insert<AddressDoc>(COLLECTIONS.ADDRESSES, {
    _id: "addr_w_r07",
    ownerUserId: wId,
    type: "weaver_send",
    contactName: "织女",
    contactPhone: "13600000407",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    detail: "1号",
    isDefault: true,
    createdAt: t0,
    updatedAt: t0,
  });
  await accrueSettledPackage(db, {
    packageId: "pkg_seed_r07",
    weaverId: wId,
    craftFeeFen: asFen(2800),
    weaverShipShareFen: asFen(300),
    yarnPoolAccrualFen: asFen(1500),
    nowUtcMs: t0,
  });

  const c1 = await submitWeeklyYarnClaim(db, {
    weaverId: wId,
    sendAddrId: "addr_w_r07",
    items: [{ yarnCode: "YARN-WHITE-01", qty: 3 }],
    shippingFeeFen: asFen(250),
    nowUtcMs: t0 + 100,
  });
  await cancelWeeklyYarnClaim(db, { claimId: c1._id, weaverId: wId, nowUtcMs: t0 + 200 });
  await assert.rejects(
    () =>
      submitWeeklyYarnClaim(db, {
        weaverId: wId,
        sendAddrId: "addr_w_r07",
        items: [{ yarnCode: "YARN-WHITE-01", qty: 20 }],
        shippingFeeFen: asFen(250),
        nowUtcMs: t0 + 300,
      }),
    /Insufficient yarn pool balance/,
  );

  // R04 + R05: Untrusted client standardSelfShipReimbFen ignored; skip-mode self_dropoff works; EXP_CRAFT_COST pure
  for (const code of ["BAG_R04_A", "BAG_R04_B"]) {
    await db.insert<BagStickerDoc>(COLLECTIONS.BAG_STICKERS, {
      _id: bagStickerId(code),
      code,
      weaverId: wId,
      batchId: "B1",
      status: "unused",
      version: 1,
    });
  }
  await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_r04_seal",
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: ["ord_r04_1"],
    externalOrderIds: [],
    buyerProvince: "浙江省",
    buyerCity: "杭州市",
    itemsSnapshot: [
      {
        skuCode: "TZ-SASA-01",
        qty: 1,
        standardMin: 90,
        yarnBomSnapshot: [],
        materialCostFen: ZERO_FEN,
        craftFeeFen: asFen(2800),
        yarnPoolAccrualFen: ZERO_FEN,
        weaverShipShareFen: asFen(300),
        saleType: "made_to_order",
      },
    ],
    totalMin: 90,
    status: "awaiting_seal",
    assignedWeaverId: wId,
    queueSeq: 1,
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    dispatchableAt: t0,
    version: 1,
    updatedAt: t0,
  });
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_r04", adminJwtSecret: SECRET, nowUtcMs: t0 + 400 },
    "weaver.sealAndSubmit",
    {
      packageId: "pkg_r04_seal",
      bagStickerCode: "BAG_R04_A",
      sealedPhotoFileId: "cloud://seal.jpg",
      selfDropoffTrackingNo: "ZT_SELF_1",
      standardSelfShipReimbFen: 9_999_900,
    },
  );
  const shipA = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId("pkg_r04_seal"));
  assert.equal(shipA?.selfShipReimbFen, 500);

  await db.atomicUpdate<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, "pkg_r04_seal", () => true, (p) => ({
    ...p,
    status: "signed",
    signedAt: t0 + 500,
    settleEligibleAt: t0 + 500 + 7 * DAY_MS,
  }));
  await sweepSettleEligiblePackages(db, t0 + 8 * DAY_MS);
  const accrueEntry = await db.get<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, "accrue:pkg_r04_seal");
  const craftLine = accrueEntry?.lines.find((l) => l.accountCode === LEDGER_ACCOUNT_CODES.EXP_CRAFT_COST);
  const shipPlatformLine = accrueEntry?.lines.find((l) => l.accountCode === LEDGER_ACCOUNT_CODES.EXP_SHIPPING_PLATFORM);
  assert.equal(craftLine?.debitFen, 2800);
  assert.equal(shipPlatformLine?.debitFen, 500);

  // Skip-mode submitFinishedWork preserves selfDropoffTrackingNo & server reimbursement
  await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
    _id: "pkg_r04_skip",
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: ["ord_r04_2"],
    externalOrderIds: [],
    buyerProvince: "浙江省",
    buyerCity: "杭州市",
    itemsSnapshot: [],
    totalMin: 90,
    status: "making",
    assignedWeaverId: wId,
    queueSeq: 1,
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "skip",
    dispatchableAt: t0,
    version: 1,
    updatedAt: t0,
  });
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_w_r04", adminJwtSecret: SECRET, nowUtcMs: t0 + 600 },
    "weaver.submitFinishedWork",
    {
      packageId: "pkg_r04_skip",
      photoSlots: { frontOnScaleCard: "f1", backStitch: "f2", sidePlumpness: "f3" },
      bagStickerCode: "BAG_R04_B",
      sealedPhotoFileId: "cloud://seal_b.jpg",
      selfDropoffTrackingNo: "ZT_SKIP_2",
    },
  );
  const shipB = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId("pkg_r04_skip"));
  assert.equal(shipB?.trackingNo, "ZT_SKIP_2");
  assert.equal(shipB?.selfShipReimbFen, 500);
});

test("R08-R10: Paid ready-stock lock commit, stock CAS guard, duplicate/7d/loss refunds, and qty>0 validation", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 25, 1, 0, 0);
  await seedBaseCatalog(db, t0);

  await db.insert<ProductDoc>(COLLECTIONS.PRODUCTS, {
    _id: "prod_rs",
    skuCode: "TZ-SASA-01",
    saleType: "ready_stock",
    title: "现货sasa",
    coverFileIds: [],
    detailFileIds: [],
    priceFen: asFen(5800),
    buyerShipFeeFen: asFen(500),
    etaText: "48h发",
    sortOrder: 1,
    isOnSale: true,
    updatedAt: t0,
  });
  await db.insert<ProductDoc>(COLLECTIONS.PRODUCTS, {
    _id: "prod_mto",
    skuCode: "TZ-SASA-01",
    saleType: "made_to_order",
    title: "定制sasa",
    coverFileIds: [],
    detailFileIds: [],
    priceFen: asFen(5800),
    buyerShipFeeFen: asFen(500),
    etaText: "3-5天发",
    sortOrder: 2,
    isOnSale: true,
    updatedAt: t0,
  });

  // R09: Negative/zero qty rejected
  const b1 = (await loginOrMergeUser(db, { app: "mp-buyer", openid: "oid_b1_r08", phone: "13900000801", nowUtcMs: t0 })).user;
  const b2 = (await loginOrMergeUser(db, { app: "mp-buyer", openid: "oid_b2_r08", phone: "13900000802", nowUtcMs: t0 })).user;
  for (const [idx, u] of [b1, b2].entries()) {
    await db.insert<AddressDoc>(COLLECTIONS.ADDRESSES, {
      _id: `addr_r08_${idx}`,
      ownerUserId: u._id,
      type: "buyer_recv",
      contactName: "买家",
      contactPhone: u.phone,
      province: "浙江省",
      city: "杭州市",
      district: "西湖区",
      detail: "1号",
      isDefault: true,
      createdAt: t0,
      updatedAt: t0,
    });
  }
  const negOrder = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b1_r08", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "buyer.createOrder",
    { productId: "prod_mto", receiverAddrId: "addr_r08_0", qty: -1 },
  );
  assert.equal(negOrder.ok, false);

  // R08: 1 ready_stock unit -> paid reservation dispatches within 15m, survives 16m sweep, blocks Buyer 2 oversell
  const w = (await loginOrMergeUser(db, { app: "mp-weaver", openid: "oid_w_r08", phone: "13600000800", nowUtcMs: t0 })).user;
  await db.put<UserDoc>(COLLECTIONS.USERS, {
    ...w,
    pool: "mp",
    funnelStage: "approved",
    acceptingOrders: true,
    dailyCapacityMin: 400,
    realName: "陈织女",
    bankCardEncrypted: "622200008888",
    yarnInventory: { "YARN-WHITE-01": { wholeSkeins: 5, usedSinceCheckG: 0, needCheck: false, status: "ok" } },
  });
  await db.insert<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, {
    _id: weaverStockId(w._id, "TZ-SASA-01"),
    weaverId: w._id,
    skuCode: "TZ-SASA-01",
    availableQty: 1,
    reservedQty: 0,
    reservations: [],
    items: [{ sourceType: "cancelled_order", createdAt: t0 }],
    oldestCreatedAt: t0,
    version: 1,
    updatedAt: t0,
  });

  const ord1 = await createMpBuyerOrder(db, {
    buyerUserId: b1._id,
    productId: "prod_rs",
    receiverAddrId: "addr_r08_0",
    mchId: "M1",
    nowUtcMs: t0,
  });
  await handleWxPaySuccessWebhook(db, { orderId: ord1.order._id, wxTransactionId: "WX_R08_1", nowUtcMs: t0 + 100 });

  const tick = await dispatchPoolTick(db, { nowUtcMs: t0 + MINUTE_MS });
  assert.equal(tick.dispatchedCount, 1);

  const rel = await releaseExpiredReservations(db, t0 + 16 * MINUTE_MS);
  assert.equal(rel.releasedUnits, 0);
  await assert.rejects(
    () =>
      createMpBuyerOrder(db, {
        buyerUserId: b2._id,
        productId: "prod_rs",
        receiverAddrId: "addr_r08_1",
        mchId: "M1",
        nowUtcMs: t0 + 17 * MINUTE_MS,
      }),
    /暂时售罄/,
  );

  // R10: Pre-accept refund cancels offer (0 timeout penalty), calls PaymentPort, releases stock, and blocks duplicate refund
  const ref1 = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b1_r08", adminJwtSecret: SECRET, nowUtcMs: t0 + 18 * MINUTE_MS },
    "buyer.requestRefund",
    { orderId: ord1.order._id, reason: "取消" },
  );
  assert.equal(ref1.ok, true);
  assert.equal(ports.logs.refunds.length, 1);
  assert.equal((await db.get<OrderDoc>(COLLECTIONS.ORDERS, ord1.order._id))?.status, "refunded");
  assert.equal((await db.get<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, weaverStockId(w._id, "TZ-SASA-01")))?.availableQty, 1);

  const dupRef = await dispatchCloudAction(
    { db, ports, app: "mp-buyer", openid: "oid_b1_r08", adminJwtSecret: SECRET, nowUtcMs: t0 + 19 * MINUTE_MS },
    "buyer.requestRefund",
    { orderId: ord1.order._id, reason: "重复申请" },
  );
  assert.equal(dupRef.ok, false);

  const wd = await sweepOffersAndStalledPackages(db, t0 + 2 * HOUR_MS);
  assert.equal(wd.timedOutOffers, 0);
  assert.equal((await db.get<UserDoc>(COLLECTIONS.USERS, w._id))?.consecutiveTimeouts, 0);

  // R10: Multi-qty (qty=3) logistics_loss pays 3x craft & yarn accrual and settles cleanly in 14-day batch
  const ordLoss = await createMpBuyerOrder(db, {
    buyerUserId: b2._id,
    productId: "prod_mto",
    receiverAddrId: "addr_r08_1",
    qty: 3,
    mchId: "M1",
    nowUtcMs: t0 + 3 * HOUR_MS,
  });
  const whLoss = await handleWxPaySuccessWebhook(db, {
    orderId: ordLoss.order._id,
    wxTransactionId: "WX_LOSS_3",
    nowUtcMs: t0 + 3 * HOUR_MS + 100,
  });
  await dispatchPoolTick(db, { nowUtcMs: t0 + 3 * HOUR_MS + 200 });
  await respondDispatchOffer(db, {
    packageId: whLoss.packageId,
    weaverId: w._id,
    action: "accept",
    nowUtcMs: t0 + 3 * HOUR_MS + 300,
  });
  await db.atomicUpdate<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, whLoss.packageId, () => true, (p) => ({
    ...p,
    status: "shipped",
  }));
  const lossReq = await requestMpBuyerRefund(db, {
    orderId: ordLoss.order._id,
    buyerUserId: b2._id,
    reason: "快递丢件",
    trigger: "logistics_loss",
    paymentPort: ports.payment,
    nowUtcMs: t0 + 3 * HOUR_MS + 400,
  });
  await resolvePendingRefundByAdmin(db, {
    refundId: lossReq._id,
    adminUserId: "usr_admin",
    approve: true,
    paymentPort: ports.payment,
    nowUtcMs: t0 + 3 * HOUR_MS + 500,
  });
  const recLoss = await reconcileWeaverAccount(db, w._id);
  assert.equal(recLoss.computed.payableBalanceFen, 8100); // 3 * 2800 - 300
  assert.equal(recLoss.computed.yarnPoolBalanceFen, 1200); // 3 * 400

  const batch = await createSettlementBatchAndExportBankCsv(db, t0 + 4 * HOUR_MS);
  await confirmSettlementBatchPaid(db, batch.batchId, t0 + 4 * HOUR_MS + 100);
  assert.equal((await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, whLoss.packageId))?.status, "settled");
});

test("R11-R14: Yarn depletion & packItems expansion, cross-style BOM capacity, dispatch rotation, merged patterns, and queue promotion", async () => {
  const db = new InMemoryDb();
  const t0 = Date.UTC(2026, 10, 26, 1, 0, 0);
  await seedBaseCatalog(db, t0);

  // R11: 1 skein (50g) -> consume 20g -> 30g left (never 80g); material_pack expands packItems
  const w1 = (await loginOrMergeUser(db, { app: "mp-weaver", openid: "oid_w1_r11", phone: "13600001101", nowUtcMs: t0 })).user;
  const w2 = (await loginOrMergeUser(db, { app: "mp-weaver", openid: "oid_w2_r11", phone: "13600001102", nowUtcMs: t0 })).user;
  await db.put<UserDoc>(COLLECTIONS.USERS, {
    ...w1,
    pool: "live",
    regionCode: "jzh",
    cityQuotaKey: "浙江省-杭州市",
    funnelStage: "approved",
    acceptingOrders: true,
    dailyCapacityMin: 300,
    creditScore: 130,
    yarnInventory: createBase12Inventory(["YARN-WHITE-01"]),
  });
  await db.put<UserDoc>(COLLECTIONS.USERS, {
    ...w2,
    pool: "live",
    regionCode: "jzh",
    cityQuotaKey: "浙江省-宁波市",
    funnelStage: "approved",
    acceptingOrders: true,
    dailyCapacityMin: 300,
    creditScore: 100,
    yarnInventory: { "YARN-WHITE-01": { wholeSkeins: 5, usedSinceCheckG: 0, needCheck: false, status: "ok" } },
  });

  await consumeYarnForPackage(
    db,
    w1._id,
    {
      isReadyStockReuse: false,
      itemsSnapshot: [
        {
          skuCode: "TZ-SASA-01",
          qty: 1,
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
    t0,
  );
  const after20 = estimateAvailableGrams((await db.get<UserDoc>(COLLECTIONS.USERS, w1._id))!.yarnInventory["YARN-WHITE-01"], 50);
  assert.equal(after20, 30);

  // R11 material_pack expansion
  await db.insert<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, {
    _id: "PACK-SASA-01",
    name: "材料包",
    brand: "江南线厂",
    itemType: "material_pack",
    isBase12: false,
    isMaterialPack: true,
    packItems: [{ yarnCode: "YARN-PINK-02", qty: 2 }],
    unitWeightG: 100,
    unitCostFen: asFen(800),
    supplierId: "SUP_JZH_01",
    supplierSkuCode: "JZH-PACK-01",
    status: "active",
  });
  await db.insert<AddressDoc>(COLLECTIONS.ADDRESSES, {
    _id: "addr_w1_r11",
    ownerUserId: w1._id,
    type: "weaver_send",
    contactName: "织女1",
    contactPhone: w1.phone,
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    detail: "1号",
    isDefault: true,
    createdAt: t0,
    updatedAt: t0,
  });
  await accrueSettledPackage(db, {
    packageId: "pkg_seed_r11",
    weaverId: w1._id,
    craftFeeFen: asFen(2800),
    weaverShipShareFen: ZERO_FEN,
    yarnPoolAccrualFen: asFen(2000),
    nowUtcMs: t0,
  });
  const packClaim = await submitWeeklyYarnClaim(db, {
    weaverId: w1._id,
    sendAddrId: "addr_w1_r11",
    items: [{ yarnCode: "PACK-SASA-01", qty: 1 }],
    shippingFeeFen: asFen(200),
    nowUtcMs: t0 + 10,
  });
  await exportSupplierCsvAndMarkDispatched(db, { weekKey: packClaim.weekKey, nowUtcMs: t0 + 20 });
  const recvRes = await confirmYarnClaimReceived(db, { claimId: packClaim._id, weaverId: w1._id, nowUtcMs: t0 + 30 });
  assert.equal(recvRes.yarnInventory["YARN-PINK-02"]?.wholeSkeins, 2);

  // R12: Cross-style shared yarn & multi-slot BOM
  const singleSkeinWeaver = {
    userId: "usr_cap",
    acceptingOrders: true,
    restDays: [],
    dailyCapacityMin: 480,
    speedFactor: 1.0,
    backlogMin: 0,
    yarnInventory: { "YARN-WHITE-01": { wholeSkeins: 1, usedSinceCheckG: 0, needCheck: false, status: "low" as const } },
  };
  const livePlan = computeSafeLiveStockPlan(
    [singleSkeinWeaver],
    [
      { style: { skuCode: "A", standardMin: 60, yarnBomConsumed: [{ yarnCode: "YARN-WHITE-01", consumedG: 25, unitWeightG: 50 }] }, shareWeight: 50, availableReadyStock: 0 },
      { style: { skuCode: "B", standardMin: 60, yarnBomConsumed: [{ yarnCode: "YARN-WHITE-01", consumedG: 25, unitWeightG: 50 }] }, shareWeight: 50, availableReadyStock: 0 },
    ],
    { nowUtcMs: t0, horizonDays: 5, responseRate: 1.0 },
  );
  assert.ok(livePlan["A"]!.craftCapacity + livePlan["B"]!.craftCapacity <= 2);
  const dupBomUnits = computeWeaverStyleUnits(
    singleSkeinWeaver,
    {
      skuCode: "DUP-BOM",
      standardMin: 60,
      yarnBomConsumed: [
        { yarnCode: "YARN-WHITE-01", consumedG: 30, unitWeightG: 50 },
        { yarnCode: "YARN-WHITE-01", consumedG: 30, unitWeightG: 50 },
      ],
    },
    undefined,
    { nowUtcMs: t0, horizonDays: 5 },
  );
  assert.equal(dupBomUnits.units, 0);

  // R12 StyleEnrollment sellability
  await db.insert<StyleDoc>(COLLECTIONS.STYLES, {
    _id: "KOL-STYLE-01",
    name: "联名款",
    riskClass: "core",
    standardMin: 90,
    patternId: "pat_sasa_01",
    yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20 }],
    wasteRateBp: 0,
    extraAccessoryCostFen: ZERO_FEN,
    materialCostFen: ZERO_FEN,
    yarnPoolAccrualFen: ZERO_FEN,
    craftFeeFen: asFen(3000),
    weaverShipShareFen: ZERO_FEN,
    ownerType: "creator",
    creatorUserId: "usr_kol",
    qcOwner: "creator_led",
    royaltyFen: ZERO_FEN,
    creatorQcFeeFen: ZERO_FEN,
    trafficCommissionBp: 0,
    requiresEnrollment: true,
    status: "active",
  });
  await db.insert<ProductDoc>(COLLECTIONS.PRODUCTS, {
    _id: "prod_kol_r12",
    skuCode: "KOL-STYLE-01",
    saleType: "made_to_order",
    title: "联名款",
    coverFileIds: [],
    detailFileIds: [],
    priceFen: asFen(8800),
    buyerShipFeeFen: ZERO_FEN,
    etaText: "3-5天",
    sortOrder: 1,
    isOnSale: true,
    updatedAt: t0,
  });
  await db.insert<StyleEnrollmentDoc>(COLLECTIONS.STYLE_ENROLLMENTS, {
    _id: styleEnrollmentId("KOL-STYLE-01", w2._id),
    skuCode: "KOL-STYLE-01",
    weaverId: w2._id,
    creatorUserId: "usr_kol",
    status: "certified",
    createdAt: t0,
  });
  assert.equal((await checkProductSellability(db, { productId: "prod_kol_r12", nowUtcMs: t0 })).sellable, true);

  // R13: W1 rejects -> next tick offers to W2; voluntary release restores yarn; multi-SKU pattern returns patterns[]
  await commitDouyinImport(db, {
    orderRows: [
      { externalOrderId: "DY_ROT_1", skuCode: "TZ-SASA-01", qty: 1, paidFen: 5800, province: "浙江", city: "杭州市", maskedName: "周*", maskedPhone: "138****0001" },
    ],
    confirmZeroRefundsToday: true,
    dispatchableAtMs: t0 + 100,
    nowUtcMs: t0 + 100,
  });
  await dispatchPoolTick(db, { nowUtcMs: t0 + 100 });
  const [rotPkg] = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.externalOrderIds.includes("DY_ROT_1"));
  assert.equal(rotPkg?.assignedWeaverId, w1._id);
  await respondDispatchOffer(db, { packageId: rotPkg!._id, weaverId: w1._id, action: "reject", nowUtcMs: t0 + 150 });
  await dispatchPoolTick(db, { nowUtcMs: t0 + 200 });
  const rotPkg2 = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, rotPkg!._id);
  assert.equal(rotPkg2?.assignedWeaverId, w2._id);
  await respondDispatchOffer(db, { packageId: rotPkg!._id, weaverId: w2._id, action: "accept", nowUtcMs: t0 + 250 });
  await releaseMakingOrderVoluntarily(db, { packageId: rotPkg!._id, weaverId: w2._id, nowUtcMs: t0 + 300 });
  assert.equal((await db.get<UserDoc>(COLLECTIONS.USERS, w2._id))?.yarnInventory["YARN-WHITE-01"]?.usedSinceCheckG, 0);

  // R14: Queue promotion resets lastProgressAt so newly promoted #1 is NOT stall-prompted 1 minute later
  await db.insert<BagStickerDoc>(COLLECTIONS.BAG_STICKERS, {
    _id: bagStickerId("BAG_R14"),
    code: "BAG_R14",
    weaverId: w1._id,
    batchId: "B1",
    status: "unused",
    version: 1,
  });
  await db.atomicUpdate<UserDoc>(COLLECTIONS.USERS, w1._id, () => true, (u) => ({
    ...u,
    yarnInventory: { "YARN-WHITE-01": { wholeSkeins: 5, usedSinceCheckG: 0, needCheck: false, status: "ok" } },
  }));
  await db.atomicUpdate<UserDoc>(COLLECTIONS.USERS, w2._id, () => true, (u) => ({ ...u, acceptingOrders: false }));
  await commitDouyinImport(db, {
    orderRows: [
      { externalOrderId: "DY_Q1", skuCode: "TZ-SASA-01", qty: 1, paidFen: 5800, province: "浙江省", city: "杭州市", maskedName: "甲*", maskedPhone: "138****1001" },
      { externalOrderId: "DY_Q2", skuCode: "TZ-SASA-01", qty: 1, paidFen: 5800, province: "浙江省", city: "宁波市", maskedName: "乙*", maskedPhone: "138****1002" },
    ],
    confirmZeroRefundsToday: true,
    dispatchableAtMs: t0 + 500,
    nowUtcMs: t0 + 500,
  });
  // Cancel rotPkg so only DY_Q1 & DY_Q2 dispatch
  await commitDouyinImport(db, {
    orderRows: [],
    refundRows: [{ externalOrderId: "DY_ROT_1", refundStatus: "refunded" }],
    dispatchableAtMs: t0 + 500,
    nowUtcMs: t0 + 500,
  });
  await dispatchPoolTick(db, { nowUtcMs: t0 + 500 });
  const w1Offers = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.assignedWeaverId === w1._id && p.status === "offered");
  const q1 = w1Offers[0]!;
  const q2 = w1Offers[1]!;
  await respondDispatchOffer(db, { packageId: q1._id, weaverId: w1._id, action: "accept", nowUtcMs: t0 + 600 });
  await respondDispatchOffer(db, { packageId: q2._id, weaverId: w1._id, action: "accept", nowUtcMs: t0 + 700 });

  await getHeadPatternForWeaver(db, { packageId: q1._id, weaverId: w1._id, nowUtcMs: t0 + 15 * HOUR_MS });
  await submitFinishedWork(db, {
    packageId: q1._id,
    weaverId: w1._id,
    photoSlots: { frontOnScaleCard: "f1", backStitch: "f2", sidePlumpness: "f3" },
    imageHashes: ["h_r14"],
    bagStickerCode: "BAG_R14",
    sealedPhotoFileId: "seal_r14",
    nowUtcMs: t0 + 25 * HOUR_MS,
  });
  const wdAfterPromote = await sweepOffersAndStalledPackages(db, t0 + 25 * HOUR_MS + MINUTE_MS);
  assert.equal(wdAfterPromote.promptedStalls, 0);
  const headPat = await getHeadPatternForWeaver(db, { packageId: q2._id, weaverId: w1._id, nowUtcMs: t0 + 25 * HOUR_MS + 2 * MINUTE_MS });
  assert.equal(headPat.patterns.length, 1);
});

test("R15-R17: Douyin partial-merge & ready_to_ship refunds, volunteer SLA/avoidance/funnel gate, and WxCloudDbAdapter >1000 pagination", async () => {
  const db = new InMemoryDb();
  const ports = createMockExternalPorts();
  const t0 = Date.UTC(2026, 10, 27, 1, 0, 0);
  await seedBaseCatalog(db, t0);

  // R15: Scientific notation in refundRows rejected; partial refund on merged package preserves paid sibling; ready_to_ship refund -> cancelled_made
  const sci = await previewDouyinImport(db, {
    orderRows: [],
    refundRows: [{ externalOrderId: "6.91E+18", refundStatus: "refunded" }],
  });
  assert.equal(sci.valid, false);

  await commitDouyinImport(db, {
    orderRows: [
      { externalOrderId: "DY_MERGE_KEEP", skuCode: "TZ-SASA-01", qty: 1, paidFen: 5800, province: "浙江省", city: "杭州市", maskedName: "王*", maskedPhone: "138****5555" },
      { externalOrderId: "DY_MERGE_REF", skuCode: "TZ-SASA-01", qty: 1, paidFen: 5800, province: "浙江省", city: "杭州市", maskedName: "王*", maskedPhone: "138****5555" },
    ],
    confirmZeroRefundsToday: true,
    dispatchableAtMs: t0 + HOUR_MS,
    nowUtcMs: t0,
  });
  await commitDouyinImport(db, {
    orderRows: [],
    refundRows: [{ externalOrderId: "DY_MERGE_REF", refundStatus: "refunded" }],
    dispatchableAtMs: t0 + HOUR_MS,
    nowUtcMs: t0 + 100,
  });
  const kept = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) => p.externalOrderIds.includes("DY_MERGE_KEEP") && p.status !== "cancelled_full",
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.itemsSnapshot[0]!.qty, 1);

  // R16: Funnel Step 1 blocks non-JZH client spoof, creates funnel_portfolio review for JZH, blocks self-unlock until approved, and enforces volunteer SLA/avoidance
  const scLogin = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_sc", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "auth.login",
    { phone: "13500001601" },
  );
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_sc", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "weaver.funnelStep1",
    {
      province: "四川省",
      city: "成都市",
      activeRecruitRegions: ["sw_ygc"],
      quizCorrectCount: 8,
      portfolioPhotoFileIds: ["p1", "p2", "p3"],
    },
  );
  const scUnlock = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_sc", adminJwtSecret: SECRET, nowUtcMs: t0 + 10 },
    "weaver.funnelAckDeposit",
    { ackDepositNotice: true },
  );
  assert.equal(scUnlock.ok, false);

  const hzLogin = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_hz", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "auth.login",
    { phone: "13500001602" },
  );
  const hzId = (hzLogin as any).data.user._id as string;
  await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_hz", adminJwtSecret: SECRET, nowUtcMs: t0 },
    "weaver.funnelStep1",
    { province: "浙江省", city: "杭州市", quizCorrectCount: 8, portfolioPhotoFileIds: ["p1", "p2", "p3"] },
  );
  const prematureUnlock = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_hz", adminJwtSecret: SECRET, nowUtcMs: t0 + 10 },
    "weaver.funnelAckDeposit",
    { ackDepositNotice: true },
  );
  assert.equal(prematureUnlock.ok, false);

  const adminToken = signAdminJwt({ sub: "usr_admin", role: "admin", exp: t0 + HOUR_MS }, SECRET);
  await dispatchCloudAction(
    { db, ports, adminJwtSecret: SECRET, adminToken, nowUtcMs: t0 + 20 },
    "admin.funnelPassPortfolio",
    { userId: hzId },
  );
  const okUnlock = await dispatchCloudAction(
    { db, ports, app: "mp-weaver", openid: "oid_hz", adminJwtSecret: SECRET, nowUtcMs: t0 + 30 },
    "weaver.funnelAckDeposit",
    { ackDepositNotice: true },
  );
  assert.equal(okUnlock.ok, true);

  // Volunteer 0%-accuracy / revoked blocked from 2h SLA fast-pass + recentWeaverIds/dailyLimit enforced
  const fan = (await loginOrMergeUser(db, { app: "mp-buyer", openid: "oid_fan_r16", phone: "15100001600", nowUtcMs: t0 })).user;
  await activateFanVolunteerAfterExam(db, { userId: fan._id, correctCount: 5, nowUtcMs: t0 });
  await db.insert<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, {
    _id: "rev_r16",
    scene: "shipment_qc",
    targetId: "pkg_dummy",
    weaverId: (scLogin as any).data.user._id,
    photoFileIds: ["f1", "f2", "f3"],
    imageHashes: [],
    duplicateFlag: false,
    isCalibrationSample: false,
    requiredVotes: 5,
    slaDeadlineAt: t0 + 2 * HOUR_MS,
    voteCount: 0,
    status: "pending",
    version: 1,
    createdAt: t0,
  });
  await db.atomicUpdate<VolunteerDoc>(COLLECTIONS.VOLUNTEERS, volunteerId(fan._id), () => true, (v) => ({
    ...v,
    calibrationTotal: 20,
    calibrationCorrect: 0,
    dailyLimit: 1,
  }));
  await castVolunteerVote(db, {
    reviewId: "rev_r16",
    volunteerUserId: fan._id,
    score: 5,
    dwellMs: 9000,
    nowUtcMs: t0 + 100,
  });
  await assert.rejects(
    () =>
      castVolunteerVote(db, {
        reviewId: "rev_r16",
        volunteerUserId: fan._id,
        score: 5,
        dwellMs: 9000,
        nowUtcMs: t0 + 200,
      }),
    (err: any) => err?.code === ERROR_CODES.FORBIDDEN,
  );
  await db.insert<PhotoReviewDoc>(COLLECTIONS.PHOTO_REVIEWS, {
    _id: "rev_r16_other_weaver",
    scene: "shipment_qc",
    targetId: "pkg_dummy_2",
    weaverId: hzId,
    photoFileIds: ["f1", "f2", "f3"],
    imageHashes: [],
    duplicateFlag: false,
    isCalibrationSample: false,
    requiredVotes: 5,
    slaDeadlineAt: t0 + 2 * HOUR_MS,
    voteCount: 0,
    status: "pending",
    version: 1,
    createdAt: t0,
  });
  await assert.rejects(
    () =>
      castVolunteerVote(db, {
        reviewId: "rev_r16_other_weaver",
        volunteerUserId: fan._id,
        score: 5,
        dwellMs: 9000,
        nowUtcMs: t0 + 250,
      }),
    (err: any) => err?.code === ERROR_CODES.FORBIDDEN,
  );

  // Add second 0%-accuracy volunteer vote and verify 2h SLA escalates to needs_admin rather than auto-approving
  const fan2 = (await loginOrMergeUser(db, { app: "mp-buyer", openid: "oid_fan2_r16", phone: "15100001609", nowUtcMs: t0 })).user;
  await activateFanVolunteerAfterExam(db, { userId: fan2._id, correctCount: 5, nowUtcMs: t0 });
  await db.atomicUpdate<VolunteerDoc>(COLLECTIONS.VOLUNTEERS, volunteerId(fan2._id), () => true, (v) => ({
    ...v,
    calibrationTotal: 20,
    calibrationCorrect: 0,
  }));
  await castVolunteerVote(db, {
    reviewId: "rev_r16",
    volunteerUserId: fan2._id,
    score: 5,
    dwellMs: 9000,
    nowUtcMs: t0 + 300,
  });
  const sla = await sweepPhotoReviewSla(db, t0 + 2 * HOUR_MS + 1000);
  assert.equal(sla.autoApproved, 0);
  assert.equal(sla.escalatedToAdmin, 2);

  // R17: WxCloudDbAdapter paginates >1,000 docs via skip/limit and propagates transient get() errors
  const colData = new Map<string, Record<string, unknown>>();
  const paginatedDb: WxCloudDatabase = {
    collection(): WxCloudCollection {
      return {
        doc(id: string) {
          return {
            async get() {
              if (id === "THROW_TIMEOUT") throw new Error("ETIMEDOUT");
              const d = colData.get(id);
              return d ? { data: structuredClone(d) } : {};
            },
            async set({ data }) {
              colData.set(id, structuredClone(data));
            },
            async remove() {
              return { stats: { removed: colData.delete(id) ? 1 : 0 } };
            },
          };
        },
        async add({ data }) {
          const id = String(data._id ?? "");
          const copy = structuredClone(data);
          delete copy._id;
          colData.set(id, copy);
        },
        where() {
          const makeQuery = (offset: number) => ({
            skip(s: number) {
              return makeQuery(s);
            },
            limit(n: number) {
              return {
                async get() {
                  const entries = [...colData.entries()].slice(offset, offset + Math.min(n, 100));
                  return { data: entries.map(([id, doc]) => ({ ...structuredClone(doc), _id: id })) };
                },
              };
            },
          });
          return makeQuery(0);
        },
      };
    },
    async runTransaction<T>(fn: (tx: WxCloudDatabase) => Promise<T>): Promise<T> {
      return fn(paginatedDb);
    },
  };

  const adapter = new WxCloudDbAdapter(paginatedDb);
  for (let i = 0; i < 1005; i++) {
    await adapter.insert(COLLECTIONS.LEDGER_ENTRIES, {
      _id: `le_${i}`,
      eventType: "mp_pay",
      bizId: `ord_${i}`,
      lines: [
        { accountCode: LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, debitFen: asFen(100), creditFen: ZERO_FEN },
        { accountCode: LEDGER_ACCOUNT_CODES.REV_PRODUCT_SALES, debitFen: ZERO_FEN, creditFen: asFen(100) },
      ],
      memo: "seed",
      createdAt: i,
    } as LedgerEntryDoc);
  }
  const allFound = await adapter.find<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, () => true);
  assert.equal(allFound.length, 1005);
  await assert.rejects(() => adapter.get(COLLECTIONS.LEDGER_ENTRIES, "THROW_TIMEOUT"), /ETIMEDOUT/);
});
