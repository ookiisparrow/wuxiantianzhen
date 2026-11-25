import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_COLLECTION_NAMES,
  COLLECTIONS,
  ORDER_PACKAGE_STATUS_SPEC,
  RECRUIT_FUNNEL_SPEC,
  YARN_CLAIM_STATUS_SPEC,
  addAwakeHoursCst,
  asFen,
  calculateBomMaterialCost,
  canTransition,
  computeSafeLiveStockPlan,
  computeWeaverFreeMin,
  formatCstWeekKey,
  formatCstYmd,
  formatYuan,
} from "../index.ts";

test("COLLECTIONS contains all 25 core + 4 system = 29 unique collections", () => {
  assert.equal(ALL_COLLECTION_NAMES.length, 29);
  assert.equal(new Set(ALL_COLLECTION_NAMES).size, 29);
  assert.equal(COLLECTIONS.WEAVER_ACCOUNTS, "weaverAccounts");
  assert.equal(COLLECTIONS.STYLE_ENROLLMENTS, "styleEnrollments");
});

test("Fen enforces integer safety and BOM material cost rounds up to prevent deficit", () => {
  assert.throws(() => asFen(12.5), /safe integer/);
  assert.equal(formatYuan(asFen(20000)), "¥200.00");

  // 18g net + 10% waste = ceil(19.8) = 20g; skein 50g @ ¥5.00 (500 Fen) -> ceil(20*500/50) = 200 Fen
  // 7g net + 10% waste = ceil(7.7) = 8g; skein 50g @ ¥5.00 (500 Fen) -> ceil(8*500/50) = 80 Fen
  // + accessory ¥1.50 (150 Fen) = 430 Fen
  const res = calculateBomMaterialCost(
    [
      { yarnCode: "WHITE", netWeightG: 18 },
      { yarnCode: "PINK", netWeightG: 7 },
    ],
    {
      WHITE: { unitWeightG: 50, unitCostFen: asFen(500) },
      PINK: { unitWeightG: 50, unitCostFen: asFen(500) },
    },
    1000,
    asFen(150),
  );
  assert.equal(res.items[0]?.consumedG, 20);
  assert.equal(res.items[0]?.costFen, 200);
  assert.equal(res.items[1]?.consumedG, 8);
  assert.equal(res.items[1]?.costFen, 80);
  assert.equal(res.totalMaterialCostFen, 430);
});

test("State machines enforce legal transitions including ready-stock direct seal & reviewMode=skip", () => {
  assert.equal(canTransition(ORDER_PACKAGE_STATUS_SPEC, "offered", "awaiting_seal"), true);
  assert.equal(canTransition(ORDER_PACKAGE_STATUS_SPEC, "making", "ready_to_ship"), true);
  assert.equal(canTransition(ORDER_PACKAGE_STATUS_SPEC, "making", "settled"), false);
  assert.equal(canTransition(RECRUIT_FUNNEL_SPEC, "sample_inspect", "pending_deposit"), true);
  assert.equal(canTransition(RECRUIT_FUNNEL_SPEC, "sample_inspect", "approved"), false);
  assert.equal(canTransition(YARN_CLAIM_STATUS_SPEC, "confirmed", "dispatched"), true);
  assert.equal(canTransition(YARN_CLAIM_STATUS_SPEC, "dispatched", "received"), true);
});

test("CST calendar & overnight sleep-aware 6h stall deadline", () => {
  // 2026-11-24 22:00 CST = 2026-11-24 14:00 UTC
  const startUtc = Date.UTC(2026, 10, 24, 14, 0, 0);
  assert.equal(formatCstYmd(startUtc), "2026-11-24");
  assert.equal(formatCstWeekKey(startUtc), "2026W48");

  // 22:00 CST + 6 awake hours -> 2h until 24:00, skip [00:00..08:00), +4h -> 12:00 CST next day (04:00 UTC)
  const deadline = addAwakeHoursCst(startUtc, 6);
  assert.equal(deadline, Date.UTC(2026, 10, 25, 4, 0, 0));
});

test("Capacity algorithm enforces time x yarn dual-bucket and prevents double-selling across styles", () => {
  const nowUtc = Date.UTC(2026, 10, 24, 1, 0, 0); // 2026-11-24 09:00 CST
  const weaver = {
    userId: "usr_w1",
    acceptingOrders: true,
    restDays: ["2026-11-25"], // 1 rest day inside 3-day horizon -> 2 active days
    dailyCapacityMin: 300,
    speedFactor: 1.0,
    backlogMin: 60, // 2 * 300 * 0.70 - 60 = 420 - 60 = 360 free min
    yarnInventory: {
      WHITE: { wholeSkeins: 1, usedSinceCheckG: 0, needCheck: false, status: "low" as const }, // 50g -> only 2 units of 20g!
      PINK: { wholeSkeins: 3, usedSinceCheckG: 0, needCheck: false, status: "ok" as const }, // 150g
    },
  };

  assert.equal(computeWeaverFreeMin(weaver, { nowUtcMs: nowUtc, horizonDays: 3 }), 360);

  const styleA = {
    skuCode: "BEAR-WHITE",
    standardMin: 60, // time allows 360/60 = 6 units, BUT WHITE yarn only allows floor(50/20) = 2 units!
    yarnBomConsumed: [{ yarnCode: "WHITE", consumedG: 20, unitWeightG: 50 }],
  };
  const styleB = {
    skuCode: "RABBIT-PINK",
    standardMin: 60,
    yarnBomConsumed: [{ yarnCode: "PINK", consumedG: 25, unitWeightG: 50 }],
  };

  // Single style: constrained by WHITE yarn (2 units) * 0.85 = 1 + 2 readyStock = 3
  const single = computeSafeLiveStockPlan(
    [weaver],
    [{ style: styleA, shareWeight: 100, availableReadyStock: 2 }],
    { nowUtcMs: nowUtc, horizonDays: 3 },
  );
  assert.equal(single["BEAR-WHITE"]?.craftCapacity, 1);
  assert.equal(single["BEAR-WHITE"]?.totalSafeQty, 3);

  // Split 50/50 between A & B: each gets 180 min (3 units time). A capped by yarn=2, B=3. Total never double-counts 360 min!
  const split = computeSafeLiveStockPlan(
    [weaver],
    [
      { style: styleA, shareWeight: 50, availableReadyStock: 0 },
      { style: styleB, shareWeight: 50, availableReadyStock: 1 },
    ],
    { nowUtcMs: nowUtc, horizonDays: 3, responseRate: 1.0 },
  );
  assert.equal(split["BEAR-WHITE"]?.craftCapacity, 2);
  assert.equal(split["RABBIT-PINK"]?.craftCapacity, 3);
  assert.equal(split["RABBIT-PINK"]?.totalSafeQty, 4);
});
