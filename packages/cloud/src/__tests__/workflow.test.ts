import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTIONS,
  DAY_MS,
  HOUR_MS,
  ZERO_FEN,
  asFen,
  formatCstWeekKey,
  type AddressDoc,
  type BagStickerDoc,
  type OrderPackageDoc,
  type PatternDoc,
  type StyleDoc,
  type UserDoc,
  type YarnCatalogDoc,
} from "../../../shared/src/index.ts";
import {
  InMemoryDb,
  activateFanVolunteerAfterExam,
  bagStickerId,
  castVolunteerVote,
  commitDouyinImport,
  completeDepositAndApproveWeaver,
  confirmSettlementBatchPaid,
  confirmYarnClaimReceived,
  createSettlementBatchAndExportBankCsv,
  dispatchPoolTick,
  exportSupplierCsvAndMarkDispatched,
  getBlindReviewCardForVolunteer,
  getHeadPatternForWeaver,
  loginOrMergeUser,
  passPortfolioAndUnlockExamSample,
  passTrialPhotosToSampleInspect,
  previewDouyinImport,
  reconcileWeaverAccount,
  recordPhysicalSampleInspection,
  releaseMakingOrderVoluntarily,
  requestMpBuyerRefund,
  resolvePendingRefundByAdmin,
  respondDispatchOffer,
  sealAndSubmitShipment,
  submitFinishedWork,
  submitFunnelEntryStep1,
  submitWeeklyYarnClaim,
  sweepOffersAndStalledPackages,
  sweepPhotoReviewSla,
  sweepSettleEligiblePackages,
  checkProductSellability,
  createMpBuyerOrder,
  handleWxPaySuccessWebhook,
} from "../index.ts";

async function seedCatalogAndStyle(db: InMemoryDb): Promise<void> {
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
      _id: "ACC-KIT-01",
      name: "标准PP棉+安全眼辅料包",
      brand: "江南线厂",
      itemType: "accessory_kit",
      isBase12: false,
      isMaterialPack: false,
      unitWeightG: 0,
      unitCostFen: asFen(300),
      supplierId: "SUP_JZH_01",
      supplierSkuCode: "JZH-ACC-STD",
      status: "active",
    },
  ];
  for (const y of yarns) await db.insert(COLLECTIONS.YARN_CATALOG, y);

  const pat: PatternDoc = {
    _id: "pat_sasa_01",
    skuCode: "TZ-SASA-01",
    version: 1,
    parts: [
      {
        partName: "头部",
        steps: [
          { rowNo: 1, text: "环起 6X", stitchCount: 6 },
          { rowNo: 2, text: "6V", stitchCount: 12 },
        ],
      },
    ],
    authorUserId: "usr_admin",
    status: "approved",
    updatedAt: 1000,
  };
  await db.insert(COLLECTIONS.PATTERNS, pat);

  const style: StyleDoc = {
    _id: "TZ-SASA-01",
    name: "天真宝宝·sasa挂件",
    riskClass: "core",
    standardMin: 90,
    patternId: pat._id,
    yarnBom: [{ yarnCode: "YARN-WHITE-01", netWeightG: 20 }],
    wasteRateBp: 1000, // ceil(22g)
    extraAccessoryCostFen: asFen(150),
    materialCostFen: asFen(326),
    yarnPoolAccrualFen: asFen(400), // >= materialCostFen, baked into price
    craftFeeFen: asFen(2800), // pure labor ¥28.00
    weaverShipShareFen: asFen(300), // ¥3.00 fixed share
    ownerType: "platform",
    qcOwner: "volunteer_or_admin",
    royaltyFen: ZERO_FEN,
    creatorQcFeeFen: ZERO_FEN,
    trafficCommissionBp: 0,
    requiresEnrollment: false,
    status: "active",
  };
  await db.insert(COLLECTIONS.STYLES, style);
}

test("End-to-end closed loop: 4-step funnel -> Douyin dual-CSV import -> dispatch -> head pattern -> 3-slot blind review (2h SLA) -> seal -> 7d accrue -> JZH yarn CSV -> 14d bank CSV", async () => {
  const db = new InMemoryDb();
  await seedCatalogAndStyle(db);
  const t0 = Date.UTC(2026, 10, 24, 0, 30, 0); // 2026-11-24 08:30 CST

  // 1. Region gate rejects applicant outside active ['jzh'] region (e.g., 四川省)
  const outUser = (await loginOrMergeUser(db, { app: "mp-weaver", openid: "oid_sc", phone: "13500001111", nowUtcMs: t0 })).user;
  const scEntry = await submitFunnelEntryStep1(db, {
    userId: outUser._id,
    province: "四川省",
    city: "成都市",
    activeRecruitRegions: ["jzh"],
    quizCorrectCount: 8,
    portfolioPhotoFileIds: ["p1", "p2", "p3"],
    nowUtcMs: t0,
  });
  assert.equal(scEntry.passedQuizAndRegion, false);
  assert.equal(scEntry.stage, "rejected");

  // 2. Jiang-Zhe-Hu weaver completes full 4-step funnel + 200 Yuan cooperative deposit
  const wUser = (await loginOrMergeUser(db, { app: "mp-weaver", openid: "oid_hz", phone: "13600002222", nowUtcMs: t0 })).user;
  const hzEntry = await submitFunnelEntryStep1(db, {
    userId: wUser._id,
    province: "浙江省",
    city: "杭州市",
    activeRecruitRegions: ["jzh"],
    quizCorrectCount: 8,
    portfolioPhotoFileIds: ["p1", "p2", "p3"],
    nowUtcMs: t0,
  });
  assert.equal(hzEntry.passedQuizAndRegion, true);

  const step2 = await passPortfolioAndUnlockExamSample(db, {
    userId: wUser._id,
    ackDepositNotice: true,
    nowUtcMs: t0 + 1000,
  });
  assert.equal(step2.stage, "trial_make");
  assert.equal(step2.examSampleCode, "EXAM-SAMPLE-NON-SALE-01");

  await passTrialPhotosToSampleInspect(db, wUser._id, t0 + 2000);
  const step3 = await recordPhysicalSampleInspection(db, {
    userId: wUser._id,
    trackingNo: "SF1001",
    passed: true,
    nowUtcMs: t0 + 3000,
  });
  assert.equal(step3.stage, "pending_deposit");

  const approvedWeaver = await completeDepositAndApproveWeaver(db, {
    userId: wUser._id,
    weaverNo: "W0001",
    dailyCapacityMin: 300,
    base12Codes: ["YARN-WHITE-01"],
    depositChannel: "mp_buyer_cashier",
    depositRefId: "wx_dep_001",
    nowUtcMs: t0 + 4000,
  });
  assert.equal(approvedWeaver.funnelStage, "approved");
  assert.equal(approvedWeaver.yarnInventory["YARN-WHITE-01"]?.wholeSkeins, 1);

  // Promote weaver to live pool + add bank info + address + bag stickers for Douyin test
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    approvedWeaver._id,
    () => true,
    (u) => ({
      ...u,
      pool: "live",
      realName: "林织女",
      bankCardEncrypted: "6222021234567890",
      doudianAddressAlias: "W0001-林织女",
    }),
  );
  const addrDoc: AddressDoc = {
    _id: "addr_w0001",
    ownerUserId: approvedWeaver._id,
    type: "weaver_send",
    contactName: "林织女",
    contactPhone: "13600002222",
    province: "浙江省",
    city: "杭州市",
    district: "余杭区",
    detail: "良渚街道18号",
    isDefault: true,
    createdAt: t0,
    updatedAt: t0,
  };
  await db.insert(COLLECTIONS.ADDRESSES, addrDoc);
  for (const code of ["BAG001", "BAG002", "BAG003"]) {
    await db.insert<BagStickerDoc>(COLLECTIONS.BAG_STICKERS, {
      _id: bagStickerId(code),
      code,
      weaverId: approvedWeaver._id,
      batchId: "B1",
      status: "unused",
      version: 1,
    });
  }

  // 3. Douyin CSV import: missing refund table without checkbox MUST fail
  const badPreview = await previewDouyinImport(db, {
    orderRows: [
      {
        externalOrderId: "6.9123E+18", // scientific notation!
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "浙江省",
        city: "宁波市",
        maskedName: "张*",
        maskedPhone: "138****1234",
      },
    ],
  });
  assert.equal(badPreview.valid, false);
  assert.equal(badPreview.blockingErrors.length, 2);

  // Valid import: 2 orders from same customer merge into 1 package, 1 overnight refunded order is cancelled immediately, + 1 second customer order
  const dispatchAt = t0 + 30 * 60 * 1000; // 09:00 CST
  const imp = await commitDouyinImport(db, {
    orderRows: [
      {
        externalOrderId: "DY202611240001",
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "浙江省",
        city: "宁波市",
        maskedName: "张*",
        maskedPhone: "138****1234",
      },
      {
        externalOrderId: "DY202611240002", // same customer -> merges!
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "浙江省",
        city: "宁波市",
        maskedName: "张*",
        maskedPhone: "138****1234",
      },
      {
        externalOrderId: "DY202611240003", // refunded overnight!
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "江苏省",
        city: "苏州市",
        maskedName: "王*",
        maskedPhone: "139****9999",
      },
      {
        externalOrderId: "DY202611240004", // second valid customer
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "浙江省",
        city: "温州市",
        maskedName: "李*",
        maskedPhone: "137****5678",
      },
    ],
    refundRows: [{ externalOrderId: "DY202611240003", refundStatus: "refunded" }],
    dispatchableAtMs: dispatchAt,
    nowUtcMs: t0,
  });
  assert.equal(imp.createdPackages, 2);
  assert.equal(imp.mergedOrders, 1);
  assert.equal(imp.cancelledPreMake, 1);

  // Give weaver extra yarn so she has enough grams for 3 total items (66g)
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    approvedWeaver._id,
    () => true,
    (u) => ({
      ...u,
      yarnInventory: {
        "YARN-WHITE-01": { wholeSkeins: 4, usedSinceCheckG: 0, needCheck: false, status: "ok" },
      },
    }),
  );

  // 4. 09:00 CST dispatch tick -> offers both active packages to W0001
  const tick = await dispatchPoolTick(db, { nowUtcMs: dispatchAt });
  assert.equal(tick.promotedConfirming, 2);
  assert.equal(tick.dispatchedCount, 2);

  const offeredPkgs = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.status === "offered");
  assert.equal(offeredPkgs.length, 2);
  const pkg1 = offeredPkgs.find((p) => p.externalOrderIds.length === 2)!;
  const pkg2 = offeredPkgs.find((p) => p.externalOrderIds.length === 1)!;

  const acc1 = await respondDispatchOffer(db, { packageId: pkg1._id, weaverId: approvedWeaver._id, action: "accept", nowUtcMs: dispatchAt + 1000 });
  const acc2 = await respondDispatchOffer(db, { packageId: pkg2._id, weaverId: approvedWeaver._id, action: "accept", nowUtcMs: dispatchAt + 2000 });
  assert.equal(acc1.queueSeq, 1);
  assert.equal(acc2.queueSeq, 2);
  // 2 items + 1 item = 3 * 22g = 66g >= 50g -> triggers skein check!
  assert.deepEqual(acc2.triggeredYarnChecks, ["YARN-WHITE-01"]);

  // Head-of-queue isolation: pkg1 unlocks pattern, pkg2 MUST be blocked!
  const patRes = await getHeadPatternForWeaver(db, { packageId: pkg1._id, weaverId: approvedWeaver._id, nowUtcMs: dispatchAt + 3000 });
  assert.match(patRes.watermarkText, /W0001/);
  await assert.rejects(
    () => getHeadPatternForWeaver(db, { packageId: pkg2._id, weaverId: approvedWeaver._id, nowUtcMs: dispatchAt + 3000 }),
    /head-of-queue/,
  );

  // 5. Submit 3-angle scale-card photos for pkg1 -> 2 fan volunteers pass 5-question exam & vote -> 2h SLA fast-pass!
  const sub = await submitFinishedWork(db, {
    packageId: pkg1._id,
    weaverId: approvedWeaver._id,
    photoSlots: { frontOnScaleCard: "f_front", backStitch: "f_back", sidePlumpness: "f_side" },
    imageHashes: ["hash_pkg1_a", "hash_pkg1_b", "hash_pkg1_c"],
    nowUtcMs: dispatchAt + HOUR_MS,
  });
  assert.equal(sub.nextStatus, "photo_review");

  for (const [idx, phone] of ["15000000001", "15000000002"].entries()) {
    const fan = (await loginOrMergeUser(db, { app: "mp-buyer", openid: `oid_fan_${idx}`, phone })).user;
    await activateFanVolunteerAfterExam(db, { userId: fan._id, correctCount: 5 });
    const blindCard = await getBlindReviewCardForVolunteer(db, sub.reviewId!, fan._id);
    assert.equal("weaverId" in blindCard, false);

    // Dwell < 8s must be rejected
    await assert.rejects(
      () => castVolunteerVote(db, { reviewId: sub.reviewId!, volunteerUserId: fan._id, score: 5, dwellMs: 3000 }),
      /8 秒/,
    );
    await castVolunteerVote(db, {
      reviewId: sub.reviewId!,
      volunteerUserId: fan._id,
      score: 5,
      dwellMs: 9500,
      nowUtcMs: dispatchAt + HOUR_MS + 10000,
    });
  }

  // 2 hours later, only 2 votes collected (both 5/5) -> SLA fast-pass auto-approves!
  const slaRes = await sweepPhotoReviewSla(db, dispatchAt + 3 * HOUR_MS + 1000);
  assert.equal(slaRes.autoApproved, 1);

  // 6. Weaver binds BAG001 + seal photo -> pkg1 enters ready_to_ship AND pkg2 automatically promotes to queueSeq=1!
  const sealRes = await sealAndSubmitShipment(db, {
    packageId: pkg1._id,
    weaverId: approvedWeaver._id,
    bagStickerCode: "BAG001",
    sealedPhotoFileId: "f_sealed_1",
    nowUtcMs: dispatchAt + 3 * HOUR_MS + 5000,
  });
  assert.equal(sealRes.status, "ready_to_ship");

  const promotedPkg2 = await getHeadPatternForWeaver(db, {
    packageId: pkg2._id,
    weaverId: approvedWeaver._id,
    nowUtcMs: dispatchAt + 3 * HOUR_MS + 6000,
  });
  assert.equal(promotedPkg2.pattern._id, "pat_sasa_01");

  // 7. Douyin CSV syncs trackingNo & signoff -> 7 days later accrue -> weekly yarn claim -> supplier CSV -> 14d bank CSV!
  const signTime = dispatchAt + 2 * DAY_MS;
  await commitDouyinImport(db, {
    orderRows: [
      {
        externalOrderId: "DY202611240001",
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "浙江省",
        city: "宁波市",
        maskedName: "张*",
        maskedPhone: "138****1234",
        trackingNo: "ZT99887766",
        signedAtMs: signTime,
      },
    ],
    confirmZeroRefundsToday: true,
    dispatchableAtMs: signTime,
    nowUtcMs: signTime,
  });

  // 7 days after signoff: pkg1 has 2 items -> craft = 2*2800 - 300 = 5300 Fen; yarnPool = 2*400 = 800 Fen
  // Add one more settled package credit or top up yarn pool by settling pkg2 too so she has 1200+ Fen for yarn claim
  // Let's check pkg1 accrual first:
  const settleTime = signTime + 7 * DAY_MS + 1000;
  const sweep = await sweepSettleEligiblePackages(db, settleTime);
  assert.equal(sweep.settledReadyCount, 1);

  const recAfterPkg1 = await reconcileWeaverAccount(db, approvedWeaver._id);
  assert.equal(recAfterPkg1.ok, true);
  assert.equal(recAfterPkg1.computed.payableBalanceFen, 5300);
  assert.equal(recAfterPkg1.computed.yarnPoolBalanceFen, 800);

  // Settle pkg2 via high-credit skip mode to give her another 400 Fen in yarn pool (total 1200 -> let's make style accrual or test 3 items @ 200 Fen)
  await db.atomicUpdate<YarnCatalogDoc>(
    COLLECTIONS.YARN_CATALOG,
    "YARN-WHITE-01",
    () => true,
    (y) => ({ ...y, unitCostFen: asFen(200) }), // 3 skeins * 200 + 200 JZH shipping = 800 Fen!
  );

  // Weaver claims 3 skeins of YARN-WHITE-01 (base-12 replenishment allowed!)
  const claim = await submitWeeklyYarnClaim(db, {
    weaverId: approvedWeaver._id,
    sendAddrId: "addr_w0001",
    items: [{ yarnCode: "YARN-WHITE-01", qty: 3 }],
    shippingFeeFen: asFen(200),
    nowUtcMs: settleTime + 1000,
  });
  assert.equal(claim.status, "confirmed");

  // Admin exports Jiang-Zhe-Hu supplier ERP CSV -> strictly uses supplierSkuCode "JZH-4P-001" and marks `dispatched`!
  const weekKey = formatCstWeekKey(settleTime + 1000);
  const exp = await exportSupplierCsvAndMarkDispatched(db, { weekKey, nowUtcMs: settleTime + 2000 });
  assert.equal(exp.exportedClaimCount, 1);
  assert.match(exp.csvContent, /JZH-4P-001/);
  assert.doesNotMatch(exp.csvContent, /奶白4股棉/);

  // Weaver confirms receipt -> wholeSkeins increases by +3 (4 + 3 = 7)
  const afterRecv = await confirmYarnClaimReceived(db, {
    claimId: claim._id,
    weaverId: approvedWeaver._id,
    nowUtcMs: settleTime + 3000,
  });
  assert.equal(afterRecv.yarnInventory["YARN-WHITE-01"]?.wholeSkeins, 7);

  // 14-day corporate bank batch payout export & confirmation
  const bankBatch = await createSettlementBatchAndExportBankCsv(db, settleTime + 4000);
  assert.equal(bankBatch.payeeCount, 1);
  assert.equal(bankBatch.totalAmountFen, 5300);
  assert.match(bankBatch.csvContent, /林织女,6222021234567890,53\.00/);

  const paid = await confirmSettlementBatchPaid(db, bankBatch.batchId, settleTime + 5000);
  assert.equal(paid.paidPayees, 1);
  assert.equal(paid.settledPackages, 1);

  // Final full ledger reconciliation: 0 discrepancy!
  const finalRec = await reconcileWeaverAccount(db, approvedWeaver._id);
  assert.equal(finalRec.ok, true);
  assert.equal(finalRec.computed.payableBalanceFen, 0);
  assert.equal(finalRec.computed.yarnPoolBalanceFen, 0);
  assert.equal(finalRec.computed.depositFen, 20000);
});

test("Ready-stock reuse jumps offered -> awaiting_seal without deducting yarn, and compressed stall guard reclaims at 24h+6h awake", async () => {
  const db = new InMemoryDb();
  await seedCatalogAndStyle(db);
  const t0 = Date.UTC(2026, 10, 25, 1, 0, 0); // 09:00 CST

  const w = (await loginOrMergeUser(db, { app: "mp-weaver", openid: "oid_w_stock", phone: "13700008888", nowUtcMs: t0 })).user;
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    w._id,
    () => true,
    (u) => ({
      ...u,
      pool: "live",
      funnelStage: "approved",
      acceptingOrders: true,
      dailyCapacityMin: 300,
      yarnInventory: { "YARN-WHITE-01": { wholeSkeins: 2, usedSinceCheckG: 0, needCheck: false, status: "ok" } },
    }),
  );

  // Order A imported, dispatched, accepted -> cancelled in making -> registers 1 ready stock in weaverStock!
  await commitDouyinImport(db, {
    orderRows: [
      {
        externalOrderId: "DY_STOCK_A",
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "浙江省",
        city: "嘉兴市",
        maskedName: "陈*",
        maskedPhone: "131****0001",
      },
    ],
    confirmZeroRefundsToday: true,
    dispatchableAtMs: t0,
    nowUtcMs: t0,
  });
  await dispatchPoolTick(db, { nowUtcMs: t0 });
  const [pkgA] = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, () => true);
  await respondDispatchOffer(db, { packageId: pkgA!._id, weaverId: w._id, action: "accept", nowUtcMs: t0 + 1000 });

  // Buyer cancels Order A mid-making -> transitions to cancelled_made & creates weaverStock(availableQty=1)
  await commitDouyinImport(db, {
    orderRows: [],
    refundRows: [{ externalOrderId: "DY_STOCK_A", refundStatus: "refunded" }],
    dispatchableAtMs: t0 + 2000,
    nowUtcMs: t0 + 2000,
  });

  const usedBeforeReuse = (await db.get<UserDoc>(COLLECTIONS.USERS, w._id))!.yarnInventory["YARN-WHITE-01"]!.usedSinceCheckG;
  assert.equal(usedBeforeReuse, 22);

  // Order B arrives -> dispatches at `stock` tier (`isReadyStockReuse=true`) -> accept jumps STRAIGHT to `awaiting_seal` with 0 yarn deducted!
  await commitDouyinImport(db, {
    orderRows: [
      {
        externalOrderId: "DY_STOCK_B",
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "上海市",
        city: "上海市",
        maskedName: "周*",
        maskedPhone: "132****0002",
      },
    ],
    confirmZeroRefundsToday: true,
    dispatchableAtMs: t0 + 3000,
    nowUtcMs: t0 + 3000,
  });
  await dispatchPoolTick(db, { nowUtcMs: t0 + 3000 });
  const pkgB = (await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.externalOrderIds.includes("DY_STOCK_B")))[0]!;
  assert.equal(pkgB.isReadyStockReuse, true);

  const reuseAccept = await respondDispatchOffer(db, {
    packageId: pkgB._id,
    weaverId: w._id,
    action: "accept",
    nowUtcMs: t0 + 4000,
  });
  assert.equal(reuseAccept.status, "awaiting_seal");
  const usedAfterReuse = (await db.get<UserDoc>(COLLECTIONS.USERS, w._id))!.yarnInventory["YARN-WHITE-01"]!.usedSinceCheckG;
  assert.equal(usedAfterReuse, 22); // Zero double deduction!

  // Order C: test <=12h no-penalty voluntary release AND 24h + 6h awake stall auto-reclaim
  await commitDouyinImport(db, {
    orderRows: [
      {
        externalOrderId: "DY_STALL_C",
        skuCode: "TZ-SASA-01",
        qty: 1,
        paidFen: 5800,
        province: "浙江省",
        city: "绍兴市",
        maskedName: "吴*",
        maskedPhone: "133****0003",
      },
    ],
    confirmZeroRefundsToday: true,
    dispatchableAtMs: t0 + 5000,
    nowUtcMs: t0 + 5000,
  });
  await dispatchPoolTick(db, { nowUtcMs: t0 + 5000 });
  const pkgC = (await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.externalOrderIds.includes("DY_STALL_C")))[0]!;
  await respondDispatchOffer(db, { packageId: pkgC._id, weaverId: w._id, action: "accept", nowUtcMs: t0 + 6000 });

  // Voluntary release within 2h (<= 12h) -> 0 penalty!
  const rel = await releaseMakingOrderVoluntarily(db, {
    packageId: pkgC._id,
    weaverId: w._id,
    nowUtcMs: t0 + 2 * HOUR_MS,
  });
  assert.equal(rel.penaltyApplied, 0);

  // Re-dispatch pkgC and simulate 24h idle + 6h awake -> auto-reclaimed!
  await dispatchPoolTick(db, { nowUtcMs: t0 + 3 * HOUR_MS });
  await respondDispatchOffer(db, { packageId: pkgC._id, weaverId: w._id, action: "accept", nowUtcMs: t0 + 3 * HOUR_MS + 1000 });
  // Make pkgC head-of-queue by sealing pkgB first
  await db.insert<BagStickerDoc>(COLLECTIONS.BAG_STICKERS, {
    _id: bagStickerId("BAG_B"),
    code: "BAG_B",
    weaverId: w._id,
    batchId: "B1",
    status: "unused",
    version: 1,
  });
  await sealAndSubmitShipment(db, {
    packageId: pkgB._id,
    weaverId: w._id,
    bagStickerCode: "BAG_B",
    sealedPhotoFileId: "f_seal_b",
    nowUtcMs: t0 + 3 * HOUR_MS + 2000,
  });

  const sw1 = await sweepOffersAndStalledPackages(db, t0 + 28 * HOUR_MS);
  assert.equal(sw1.promptedStalls, 1);

  const sw2 = await sweepOffersAndStalledPackages(db, t0 + 35 * HOUR_MS);
  assert.equal(sw2.reclaimedStalls, 1);
  const reclaimedPkgC = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkgC._id);
  assert.equal(reclaimedPkgC?.status, "waiting_dispatch");
});

test("Mini-Program pool: capacity sellability, anti-self-buy, pre-dispatch instant refund, quality defect (no clawback), and courier loss (weaver still paid)", async () => {
  const db = new InMemoryDb();
  await seedCatalogAndStyle(db);
  const t0 = Date.UTC(2026, 10, 26, 2, 0, 0);

  await db.insert(COLLECTIONS.PRODUCTS, {
    _id: "prod_sasa_mto",
    skuCode: "TZ-SASA-01",
    saleType: "made_to_order",
    title: "天真宝宝·sasa挂件",
    coverFileIds: ["c1"],
    detailFileIds: ["d1"],
    priceFen: asFen(5800),
    buyerShipFeeFen: asFen(500),
    etaText: "下单后 3–5 天内发出",
    sortOrder: 1,
    isOnSale: true,
    updatedAt: t0,
  });

  // Only 1 weaver exists in the entire system right now
  const w = (await loginOrMergeUser(db, { app: "mp-weaver", openid: "oid_mp_w", phone: "13911112222", nowUtcMs: t0 })).user;
  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    w._id,
    () => true,
    (u) => ({
      ...u,
      pool: "mp",
      funnelStage: "approved",
      acceptingOrders: true,
      dailyCapacityMin: 300,
      yarnInventory: { "YARN-WHITE-01": { wholeSkeins: 3, usedSinceCheckG: 0, needCheck: false, status: "ok" } },
    }),
  );

  // If that SAME weaver tries to buy on mp-buyer and no other weaver exists -> temporarily_sold_out (anti-self-order!)
  const selfCheck = await checkProductSellability(db, {
    productId: "prod_sasa_mto",
    buyerUserId: w._id,
    nowUtcMs: t0,
  });
  assert.equal(selfCheck.sellable, false);
  assert.equal(selfCheck.reason, "temporarily_sold_out");

  // Real external buyer places 3 orders
  const buyer = (await loginOrMergeUser(db, { app: "mp-buyer", openid: "oid_mp_b", phone: "13933334444", nowUtcMs: t0 })).user;
  await db.insert<AddressDoc>(COLLECTIONS.ADDRESSES, {
    _id: "addr_buyer_1",
    ownerUserId: buyer._id,
    type: "buyer_recv",
    contactName: "陈买家",
    contactPhone: "13933334444",
    province: "上海市",
    city: "上海市",
    district: "徐汇区",
    detail: "淮海中路99号",
    isDefault: true,
    createdAt: t0,
    updatedAt: t0,
  });

  // Order 1: Pre-dispatch instant auto-refund!
  const o1 = await createMpBuyerOrder(db, {
    buyerUserId: buyer._id,
    productId: "prod_sasa_mto",
    receiverAddrId: "addr_buyer_1",
    mchId: "MCH_SOLE_PROP_01",
    nowUtcMs: t0,
  });
  await handleWxPaySuccessWebhook(db, { orderId: o1.order._id, wxTransactionId: "WX_TX_1", nowUtcMs: t0 + 100 });
  const ref1 = await requestMpBuyerRefund(db, {
    orderId: o1.order._id,
    buyerUserId: buyer._id,
    reason: "拍错颜色重拍",
    nowUtcMs: t0 + 200,
  });
  assert.equal(ref1.autoApproved, true);
  assert.equal(ref1.status, "succeeded");

  // Order 2: Courier lost parcel -> buyer refunded AND weaver STILL receives full craft fee (2800-300=2500) + yarnPool (400)!
  const o2 = await createMpBuyerOrder(db, {
    buyerUserId: buyer._id,
    productId: "prod_sasa_mto",
    receiverAddrId: "addr_buyer_1",
    mchId: "MCH_SOLE_PROP_01",
    nowUtcMs: t0 + 1000,
  });
  const wh2 = await handleWxPaySuccessWebhook(db, { orderId: o2.order._id, wxTransactionId: "WX_TX_2", nowUtcMs: t0 + 1100 });
  await dispatchPoolTick(db, { nowUtcMs: t0 + 1200 });
  await respondDispatchOffer(db, { packageId: wh2.packageId, weaverId: w._id, action: "accept", nowUtcMs: t0 + 1300 });

  // Simulate shipped -> courier loss
  await db.atomicUpdate<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    wh2.packageId,
    () => true,
    (p) => ({ ...p, status: "shipped" }),
  );
  const ref2 = await requestMpBuyerRefund(db, {
    orderId: o2.order._id,
    buyerUserId: buyer._id,
    reason: "快递5天未动确认丢件",
    trigger: "logistics_loss",
    nowUtcMs: t0 + 2000,
  });
  await resolvePendingRefundByAdmin(db, { refundId: ref2._id, adminUserId: "usr_admin", approve: true, nowUtcMs: t0 + 2100 });

  const afterLoss = await reconcileWeaverAccount(db, w._id);
  assert.equal(afterLoss.ok, true);
  assert.equal(afterLoss.computed.payableBalanceFen, 2500);
  assert.equal(afterLoss.computed.yarnPoolBalanceFen, 400);

  // Order 3: Quality defect refund -> buyer refunded, weaver gets 0 for Order 3, and Order 2's 2500 is NEVER clawed back!
  const o3 = await createMpBuyerOrder(db, {
    buyerUserId: buyer._id,
    productId: "prod_sasa_mto",
    receiverAddrId: "addr_buyer_1",
    mchId: "MCH_SOLE_PROP_01",
    nowUtcMs: t0 + 3000,
  });
  const wh3 = await handleWxPaySuccessWebhook(db, { orderId: o3.order._id, wxTransactionId: "WX_TX_3", nowUtcMs: t0 + 3100 });
  await dispatchPoolTick(db, { nowUtcMs: t0 + 3200 });
  await respondDispatchOffer(db, { packageId: wh3.packageId, weaverId: w._id, action: "accept", nowUtcMs: t0 + 3300 });
  await db.atomicUpdate<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    wh3.packageId,
    () => true,
    (p) => ({ ...p, status: "signed", signedAt: t0 + 4000 }),
  );

  const ref3 = await requestMpBuyerRefund(db, {
    orderId: o3.order._id,
    buyerUserId: buyer._id,
    reason: "眼睛粘歪了",
    trigger: "quality_defect",
    nowUtcMs: t0 + 4100,
  });
  await resolvePendingRefundByAdmin(db, { refundId: ref3._id, adminUserId: "usr_admin", approve: true, nowUtcMs: t0 + 4200 });

  const afterQual = await reconcileWeaverAccount(db, w._id);
  assert.equal(afterQual.ok, true);
  assert.equal(afterQual.computed.payableBalanceFen, 2500); // Untouched! Zero clawback!
});
