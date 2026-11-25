import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  LEDGER_ACCOUNT_CODES,
  MINUTE_MS,
  ORDER_PACKAGE_STATUS_SPEC,
  ZERO_FEN,
  asFen,
  type OrderPackageDoc,
  type WeaverStockDoc,
} from "@wxtz/shared";
import {
  InMemoryDb,
  accrueSettledPackage,
  assertNotSelfOrder,
  confirmWeaverSkeinCheck,
  consumeYarnForPackage,
  debitYarnPoolAtomic,
  loginOrMergeUser,
  postLedgerEntry,
  receiveYarnClaimToInventory,
  reconcileWeaverAccount,
  recordWeaverDeposit,
  refundWeaverDeposit,
  releaseExpiredReservations,
  reserveReadyStock,
  transitionStatus,
  weaverStockId,
} from "../index.ts";

test("CAS state transition succeeds once, rejects stale version, and throws on illegal edge", async () => {
  const db = new InMemoryDb();
  const pkg: OrderPackageDoc = {
    _id: "pkg_001",
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: ["ord_001"],
    externalOrderIds: [],
    buyerProvince: "浙江省",
    buyerCity: "杭州市",
    itemsSnapshot: [],
    totalMin: 120,
    status: "offered",
    isReadyStockReuse: false,
    attemptCount: 1,
    reviewMode: "required",
    dispatchableAt: 1000,
    version: 1,
    updatedAt: 1000,
  };
  await db.insert(COLLECTIONS.ORDER_PACKAGES, pkg);

  // Legal transition v1 -> v2
  const r1 = await transitionStatus(db, COLLECTIONS.ORDER_PACKAGES, "pkg_001", ORDER_PACKAGE_STATUS_SPEC, "offered", "making", 1);
  assert.equal(r1.moved, true);
  assert.equal(r1.doc?.status, "making");
  assert.equal(r1.doc?.version, 2);

  // Concurrent stale transition with v1 must return moved=false (no duplicate side effect!)
  const r2 = await transitionStatus(db, COLLECTIONS.ORDER_PACKAGES, "pkg_001", ORDER_PACKAGE_STATUS_SPEC, "offered", "making", 1);
  assert.equal(r2.moved, false);

  // Illegal edge making -> settled must throw
  await assert.rejects(
    () => transitionStatus(db, COLLECTIONS.ORDER_PACKAGES, "pkg_001", ORDER_PACKAGE_STATUS_SPEC, "making", "settled", 2),
    /Illegal state transition/,
  );
});

test("Double-entry ledger separates pure craft fee from material cost, blocks overdraft, and reconciles 100%", async () => {
  const db = new InMemoryDb();
  const weaverId = "usr_weaver_01";

  // Unbalanced entry must be rejected
  await assert.rejects(
    () =>
      postLedgerEntry(db, {
        _id: "bad_entry",
        eventType: "adjustment",
        bizId: "test",
        lines: [
          { accountCode: LEDGER_ACCOUNT_CODES.ASSET_BANK_CASH, debitFen: asFen(100), creditFen: ZERO_FEN },
          { accountCode: LEDGER_ACCOUNT_CODES.REV_PRODUCT_SALES, debitFen: ZERO_FEN, creditFen: asFen(90) },
        ],
        memo: "unbalanced",
        createdAt: 1000,
      }),
    /Ledger unbalanced/,
  );

  // 1. Weaver pays 200 Yuan cooperative deposit (strict liability)
  const dep = await recordWeaverDeposit(db, weaverId, LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, 1000);
  assert.equal(dep.posted, true);

  // 2. Accrue 3 settled packages: pure craft ¥28 (2800), ship share ¥3 (300), material BOM ¥6 (600)
  // Weaver payable = 2800 - 300 = 2500/pkg (material 600 NEVER deducted from pure craft fee!)
  for (const pkgId of ["pkg_a", "pkg_b", "pkg_c"]) {
    const res = await accrueSettledPackage(db, {
      packageId: pkgId,
      weaverId,
      craftFeeFen: asFen(2800),
      weaverShipShareFen: asFen(300),
      yarnPoolAccrualFen: asFen(600),
      nowUtcMs: 2000,
    });
    assert.equal(res.posted, true);
  }
  // Idempotent retry on pkg_a must not double credit
  const dup = await accrueSettledPackage(db, {
    packageId: "pkg_a",
    weaverId,
    craftFeeFen: asFen(2800),
    weaverShipShareFen: asFen(300),
    yarnPoolAccrualFen: asFen(600),
    nowUtcMs: 2001,
  });
  assert.equal(dup.posted, false);
  assert.equal(dup.alreadyExists, true);

  // Check balances: payable = 7500, yarnPool = 1800, deposit = 20000
  const rec1 = await reconcileWeaverAccount(db, weaverId);
  assert.equal(rec1.ok, true);
  assert.equal(rec1.computed.payableBalanceFen, 7500);
  assert.equal(rec1.computed.yarnPoolBalanceFen, 1800);
  assert.equal(rec1.computed.depositFen, 20000);

  // 3. Reject yarn claim < 3 skeins without material pack
  await assert.rejects(
    () =>
      debitYarnPoolAtomic(db, {
        claimId: "claim_too_small",
        weaverId,
        totalQty: 2,
        hasMaterialPack: false,
        materialsCostFen: asFen(1000),
        shippingFeeFen: asFen(300),
      }),
    /at least 3 skeins/,
  );

  // 4. Reject overdraft (> 1800 Fen)
  await assert.rejects(
    () =>
      debitYarnPoolAtomic(db, {
        claimId: "claim_overdraft",
        weaverId,
        totalQty: 4,
        hasMaterialPack: false,
        materialsCostFen: asFen(2000),
        shippingFeeFen: asFen(300),
      }),
    /Insufficient yarn pool balance/,
  );

  // 5. Valid 3-skein claim: 1500 materials + 300 shipping = 1800 (exact balance -> 0)
  const claimOk = await debitYarnPoolAtomic(db, {
    claimId: "claim_usr_weaver_01_2026W48",
    weaverId,
    totalQty: 3,
    hasMaterialPack: false,
    materialsCostFen: asFen(1500),
    shippingFeeFen: asFen(300),
    nowUtcMs: 3000,
  });
  assert.equal(claimOk.posted, true);

  // 6. Weaver exits with no breach -> full 200 Yuan deposit refunded
  const ref = await refundWeaverDeposit(db, weaverId, LEDGER_ACCOUNT_CODES.ASSET_BANK_CASH, 4000);
  assert.equal(ref.posted, true);

  const rec2 = await reconcileWeaverAccount(db, weaverId);
  assert.equal(rec2.ok, true);
  assert.equal(rec2.computed.yarnPoolBalanceFen, 0);
  assert.equal(rec2.computed.depositFen, 0);
  assert.equal(rec2.computed.payableBalanceFen, 7500);
});

test("Cross-MP unified identity merges by phone, survives company openid reset, and blocks self-orders", async () => {
  const db = new InMemoryDb();

  // First login on mp-weaver (个体户 AppID)
  const r1 = await loginOrMergeUser(db, {
    app: "mp-weaver",
    openid: "oid_weaver_soleprop_1",
    phone: "13800138000",
  });
  assert.equal(r1.created, true);
  assert.ok(r1.user._id.startsWith("usr_"));

  // Same person opens mp-buyer -> merges into SAME usr_<id> with both roles
  const r2 = await loginOrMergeUser(db, {
    app: "mp-buyer",
    openid: "oid_buyer_soleprop_1",
    phone: "13800138000",
  });
  assert.equal(r2.created, false);
  assert.equal(r2.mergedByPhone, true);
  assert.equal(r2.user._id, r1.user._id);
  assert.deepEqual(new Set(r2.user.roles), new Set(["weaver", "buyer"]));

  // Future company migration resets openid -> phone re-auth seamlessly heals back to SAME usr_<id>
  const r3 = await loginOrMergeUser(db, {
    app: "mp-weaver",
    openid: "oid_weaver_ltd_company_2",
    phone: "13800138000",
  });
  assert.equal(r3.user._id, r1.user._id);
  assert.equal(r3.mergedByPhone, true);

  // Anti-self-order check must block assigning her own buyer order to herself
  assert.throws(() => assertNotSelfOrder(r2.user._id, r1.user._id), /cannot be assigned their own buyer order/);
});

test("Dual-granularity yarn inventory triggers 50g check, calibrates error, warns at <=1 skein, and skips ready-stock reuse", async () => {
  const db = new InMemoryDb();
  const { user } = await loginOrMergeUser(db, {
    app: "mp-weaver",
    openid: "oid_w_yarn",
    phone: "13900139000",
  });

  // Receive 5 whole skeins of WHITE (50g each)
  await receiveYarnClaimToInventory(db, user._id, [{ yarnCode: "WHITE", qty: 5 }]);

  const normalPkg = {
    isReadyStockReuse: false,
    itemsSnapshot: [
      {
        skuCode: "BEAR",
        qty: 1,
        standardMin: 90,
        yarnBomSnapshot: [{ yarnCode: "WHITE", consumedG: 20 }],
        materialCostFen: asFen(200),
        craftFeeFen: asFen(2500),
        yarnPoolAccrualFen: asFen(200),
        weaverShipShareFen: asFen(300),
        saleType: "made_to_order" as const,
      },
    ],
  };

  // Ready-stock reuse MUST NOT deduct yarn
  const skipRes = await consumeYarnForPackage(db, user._id, { ...normalPkg, isReadyStockReuse: true });
  assert.equal(skipRes.skippedReadyStock, true);

  // 3 normal orders: 20 + 20 + 20 = 60g >= 50g -> triggers skein check!
  assert.deepEqual((await consumeYarnForPackage(db, user._id, normalPkg)).triggeredCheckCodes, []);
  assert.deepEqual((await consumeYarnForPackage(db, user._id, normalPkg)).triggeredCheckCodes, []);
  const third = await consumeYarnForPackage(db, user._id, normalPkg);
  assert.deepEqual(third.triggeredCheckCodes, ["WHITE"]);

  // Weaver reports 3 whole skeins left (loose tension) -> calibrated to 3 skeins, remainder 10g, status ok
  const calibrated = await confirmWeaverSkeinCheck(db, user._id, "WHITE", 3, 50);
  assert.equal(calibrated.wholeSkeins, 3);
  assert.equal(calibrated.usedSinceCheckG, 10);
  assert.equal(calibrated.needCheck, false);
  assert.equal(calibrated.status, "ok");

  // Later weaver reports 1 whole skein left -> proactive refill status = 'low'
  const lowSlot = await confirmWeaverSkeinCheck(db, user._id, "WHITE", 1, 50);
  assert.equal(lowSlot.status, "low");
});

test("Ready-stock 15-min atomic reservation prevents oversell and releases expired unpaid locks", async () => {
  const db = new InMemoryDb();
  const stockId = weaverStockId("usr_w1", "TZ-SASA-01");
  const stock: WeaverStockDoc = {
    _id: stockId,
    weaverId: "usr_w1",
    skuCode: "TZ-SASA-01",
    availableQty: 1,
    reservedQty: 0,
    reservations: [],
    items: [{ sourceType: "cancelled_order", sourcePkgId: "pkg_old", createdAt: 1000 }],
    oldestCreatedAt: 1000,
    version: 1,
    updatedAt: 1000,
  };
  await db.insert(COLLECTIONS.WEAVER_STOCK, stock);

  // Buyer 1 and Buyer 2 race for the last 1 ready-stock unit
  const [b1, b2] = await Promise.all([
    reserveReadyStock(db, { weaverId: "usr_w1", skuCode: "TZ-SASA-01", orderId: "ord_b1", qty: 1, nowUtcMs: 10000 }),
    reserveReadyStock(db, { weaverId: "usr_w1", skuCode: "TZ-SASA-01", orderId: "ord_b2", qty: 1, nowUtcMs: 10000 }),
  ]);
  assert.equal(Number(b1.reserved) + Number(b2.reserved), 1);

  // After 16 minutes without payment, cron releases expired lock back to availableQty = 1
  const released = await releaseExpiredReservations(db, 10000 + 16 * MINUTE_MS);
  assert.equal(released.releasedUnits, 1);

  const after = await db.get<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, stockId);
  assert.equal(after?.availableQty, 1);
  assert.equal(after?.reservedQty, 0);
});
