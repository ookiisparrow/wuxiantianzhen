import {
  COLLECTIONS,
  DAY_MS,
  AppError,
  ERROR_CODES,
  ZERO_FEN,
  addFen,
  asNonNegativeFen,
  asPositiveFen,
  DISPATCH_OFFER_STATUS_SPEC,
  ORDER_PACKAGE_STATUS_SPEC,
  REFUND_STATUS_SPEC,
  LEDGER_ACCOUNT_CODES,
  computeWeaverFreeMin,
  computeWeaverStyleUnits,
  type DispatchOfferDoc,
  type Fen,
  type AddressDoc,
  type OrderDoc,
  type OrderPackageDoc,
  type PaymentDoc,
  type ProductDoc,
  type RefundDoc,
  type ShipmentDoc,
  type StyleDoc,
  type StyleEnrollmentDoc,
  type UserDoc,
  type WeaverStockDoc,
  type YarnCatalogDoc,
} from "@wxtz/shared";
import type { DbAdapter } from "../kit/db.ts";
import {
  dispatchOfferId,
  ledgerKeyLossComp,
  ledgerKeyPay,
  ledgerKeyQualityRefund,
  newOrderId,
  newPackageId,
  paymentId,
  refundId,
  shipmentId,
} from "../kit/ids.ts";
import { accrueSettledPackage, postLedgerEntry, recordWeaverDeposit } from "../kit/ledger.ts";
import { compactWeaverQueue } from "../kit/queue.ts";
import {
  commitPaidStockReservation,
  registerCancelledPackageToWeaverStock,
  releaseStockReservationForOrderOrPackage,
  reserveReadyStock,
} from "../kit/stockLock.ts";
import { transitionStatus } from "../kit/transition.ts";
import type { PaymentPort } from "../ports/index.ts";

/**
 * Checks real-time sellability of a product on `mp-buyer` (docs/07 §4.3):
 *  - `ready_stock`: checks that a single non-buyer weaver holds `availableQty >= qty`;
 *  - `made_to_order`: checks `styleEnrollments`, excludes stalled weavers, subtracts unassigned
 *    `waiting_dispatch`/`confirming` backlog, and verifies at least 1 eligible weaver can make `qty`.
 */
export async function checkProductSellability(
  db: DbAdapter,
  params: {
    productId: string;
    buyerUserId?: string;
    qty?: number;
    mpHorizonDays?: number;
    nowUtcMs?: number;
  },
): Promise<{ sellable: boolean; availableReadyUnits: number; reason?: "temporarily_sold_out" | "off_sale" }> {
  const now = params.nowUtcMs ?? Date.now();
  const qty = params.qty ?? 1;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "购买数量须为正整数");
  }

  const prod = await db.get<ProductDoc>(COLLECTIONS.PRODUCTS, params.productId);
  if (!prod || !prod.isOnSale) {
    return { sellable: false, availableReadyUnits: 0, reason: "off_sale" };
  }

  const stocks = await db.find<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    (s) => s.skuCode === prod.skuCode && s.availableQty > 0 && s.weaverId !== params.buyerUserId,
  );
  const availableReadyUnits = stocks.reduce((sum, s) => sum + s.availableQty, 0);
  const maxSingleWeaverReady = stocks.reduce((m, s) => Math.max(m, s.availableQty), 0);

  if (prod.saleType === "ready_stock") {
    return maxSingleWeaverReady >= qty
      ? { sellable: true, availableReadyUnits }
      : { sellable: false, availableReadyUnits, reason: "temporarily_sold_out" };
  }

  // Made-to-order: if a single weaver's ready stock already covers `qty`, immediately sellable!
  if (maxSingleWeaverReady >= qty) {
    return { sellable: true, availableReadyUnits };
  }

  const style = await db.get<StyleDoc>(COLLECTIONS.STYLES, prod.skuCode);
  if (!style || style.status !== "active") {
    return { sellable: false, availableReadyUnits, reason: "off_sale" };
  }

  const [weavers, inFlightPkgs, yarns, enrollments] = await Promise.all([
    db.find<UserDoc>(
      COLLECTIONS.USERS,
      (u) =>
        u.roles.includes("weaver") &&
        u.funnelStage === "approved" &&
        u.acceptingOrders &&
        u._id !== params.buyerUserId,
    ),
    db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) =>
      ["confirming", "waiting_dispatch", "offered", "making", "photo_review"].includes(p.status),
    ),
    db.find<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, () => true),
    db.find<StyleEnrollmentDoc>(COLLECTIONS.STYLE_ENROLLMENTS, (e) => e.status === "certified"),
  ]);

  const certifiedByWeaver = new Map<string, string[]>();
  for (const e of enrollments) {
    const list = certifiedByWeaver.get(e.weaverId) ?? [];
    list.push(e.skuCode);
    certifiedByWeaver.set(e.weaverId, list);
  }

  const backlogMap = new Map<string, number>();
  const stalledWeavers = new Set<string>();
  let unassignedWaitingMin = 0;

  for (const p of inFlightPkgs) {
    if (p.assignedWeaverId) {
      if (!p.isReadyStockReuse) {
        backlogMap.set(p.assignedWeaverId, (backlogMap.get(p.assignedWeaverId) ?? 0) + p.totalMin);
      }
      if (p.status === "making" && p.queueSeq === 1 && p.stallPromptedAt) {
        stalledWeavers.add(p.assignedWeaverId);
      }
    } else if ((p.status === "waiting_dispatch" || p.status === "confirming") && !p.isReadyStockReuse) {
      unassignedWaitingMin += p.totalMin;
    }
  }

  const yarnWeightMap = new Map(yarns.map((y) => [y._id, y.unitWeightG || 50]));
  const horizonDays = params.mpHorizonDays ?? 3;

  let maxSingleUnits = 0;
  let totalPoolFreeMin = 0;

  for (const w of weavers) {
    const weaverInput = {
      userId: w._id,
      acceptingOrders: w.acceptingOrders,
      pauseUntil: w.pauseUntil,
      restDays: w.restDays,
      dailyCapacityMin: w.dailyCapacityMin,
      speedFactor: w.speedFactor,
      backlogMin: backlogMap.get(w._id) ?? 0,
      isStalledHead: stalledWeavers.has(w._id),
      yarnInventory: w.yarnInventory,
      certifiedStyleCodes: certifiedByWeaver.get(w._id) ?? [],
    };
    const cap = computeWeaverStyleUnits(
      weaverInput,
      {
        skuCode: style._id,
        standardMin: style.standardMin,
        requiresEnrollment: style.requiresEnrollment,
        yarnBomConsumed: style.yarnBom.map((b) => ({
          yarnCode: b.yarnCode,
          consumedG: Math.ceil((b.netWeightG * (10000 + style.wasteRateBp)) / 10000),
          unitWeightG: yarnWeightMap.get(b.yarnCode) ?? 50,
        })),
      },
      undefined,
      { nowUtcMs: now, horizonDays },
    );
    if (cap.units > maxSingleUnits) maxSingleUnits = cap.units;
    if (cap.units > 0) {
      totalPoolFreeMin += computeWeaverFreeMin(weaverInput, { nowUtcMs: now, horizonDays });
    }
  }

  const netPoolMin = totalPoolFreeMin - unassignedWaitingMin;
  if (maxSingleUnits >= qty && netPoolMin >= style.standardMin * qty) {
    return { sellable: true, availableReadyUnits };
  }

  return { sellable: false, availableReadyUnits, reason: "temporarily_sold_out" };
}

/**
 * Creates a Mini-Program buyer order (1 order = 1 style in Stage 1).
 * If `saleType === 'ready_stock'`, acquires an atomic 15-min lock on `weaverStock`!
 */
export async function createMpBuyerOrder(
  db: DbAdapter,
  params: {
    buyerUserId: string;
    productId: string;
    receiverAddrId: string;
    qty?: number;
    referrerCreatorId?: string;
    mchId: string;
    nowUtcMs?: number;
  },
): Promise<{ order: OrderDoc; payment: PaymentDoc; reservedStockWeaverId?: string }> {
  const now = params.nowUtcMs ?? Date.now();
  const qty = params.qty ?? 1;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "购买数量须为正整数");
  }
  const prod = await db.get<ProductDoc>(COLLECTIONS.PRODUCTS, params.productId);
  if (!prod || !prod.isOnSale) {
    throw new AppError(ERROR_CODES.NOT_FOUND, "商品不存在或已下架");
  }
  const addr = await db.get<AddressDoc>(COLLECTIONS.ADDRESSES, params.receiverAddrId);
  if (!addr || addr.ownerUserId !== params.buyerUserId || addr.type !== "buyer_recv") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "收货地址无效");
  }

  const check = await checkProductSellability(db, {
    productId: prod._id,
    buyerUserId: params.buyerUserId,
    qty,
    nowUtcMs: now,
  });
  if (!check.sellable) {
    throw new AppError(ERROR_CODES.INSUFFICIENT_STOCK, "当前产能已满，暂时售罄，可预约到货提醒");
  }

  const ordId = newOrderId();
  let reservedStockWeaverId: string | undefined;

  if (prod.saleType === "ready_stock") {
    const stocks = await db.find<WeaverStockDoc>(
      COLLECTIONS.WEAVER_STOCK,
      (s) => s.skuCode === prod.skuCode && s.availableQty >= qty && s.weaverId !== params.buyerUserId,
    );
    stocks.sort((a, b) => a.oldestCreatedAt - b.oldestCreatedAt);
    let locked = false;
    for (const candidate of stocks) {
      const r = await reserveReadyStock(db, {
        weaverId: candidate.weaverId,
        skuCode: prod.skuCode,
        orderId: ordId,
        qty,
        nowUtcMs: now,
      });
      if (r.reserved) {
        locked = true;
        reservedStockWeaverId = candidate.weaverId;
        break;
      }
    }
    if (!locked) {
      throw new AppError(ERROR_CODES.INSUFFICIENT_STOCK, "现货刚刚被抢光啦，请稍后再试");
    }
  }

  let totalPaid = prod.buyerShipFeeFen;
  for (let i = 0; i < qty; i++) totalPaid = addFen(totalPaid, prod.priceFen);

  const payId = paymentId(ordId);
  const orderDoc: OrderDoc = {
    _id: ordId,
    channel: "mp_wechat",
    buyerUserId: params.buyerUserId,
    referrerCreatorId: params.referrerCreatorId,
    receiverAddrId: addr._id,
    productId: prod._id,
    skuCode: prod.skuCode,
    qty,
    totalPaidFen: totalPaid,
    buyerShipFeeFen: prod.buyerShipFeeFen,
    paymentId: payId,
    status: "unpaid",
    createdAt: now,
    updatedAt: now,
  };
  const paymentDoc: PaymentDoc = {
    _id: payId,
    orderId: ordId,
    buyerUserId: params.buyerUserId,
    mchId: params.mchId,
    outTradeNo: `WXTZ_${ordId}`,
    amountFen: totalPaid,
    status: "init",
  };

  await db.insert(COLLECTIONS.ORDERS, orderDoc);
  await db.insert(COLLECTIONS.PAYMENTS, paymentDoc);
  return { order: orderDoc, payment: paymentDoc, reservedStockWeaverId };
}

/**
 * Idempotent WeChat Pay callback handler (`webhook-wxpay`):
 * marks `payments` & `orders` paid, posts `pay:${orderId}` double-entry ledger,
 * and creates `orderPackages(waiting_dispatch)`.
 */
export async function handleWxPaySuccessWebhook(
  db: DbAdapter,
  params: {
    orderId: string;
    wxTransactionId: string;
    nowUtcMs?: number;
  },
): Promise<{ packageId: string; alreadyProcessed: boolean }> {
  const now = params.nowUtcMs ?? Date.now();

  // Handle weaver cooperative performance deposit cashier callback (`DEP_...`)
  if (params.orderId.startsWith("DEP_")) {
    const depPay = await db.get<PaymentDoc>(COLLECTIONS.PAYMENTS, paymentId(params.orderId));
    if (!depPay) throw new AppError(ERROR_CODES.NOT_FOUND, "Deposit payment record not found");
    if (depPay.status === "paid") {
      return { packageId: params.orderId, alreadyProcessed: true };
    }
    await db.put<PaymentDoc>(COLLECTIONS.PAYMENTS, {
      ...depPay,
      wxTransactionId: params.wxTransactionId,
      status: "paid",
      paidAt: now,
      rawNotifyAt: now,
    });
    await recordWeaverDeposit(db, depPay.buyerUserId, LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, now);
    return { packageId: params.orderId, alreadyProcessed: false };
  }

  const ord = await db.get<OrderDoc>(COLLECTIONS.ORDERS, params.orderId);
  if (!ord) throw new AppError(ERROR_CODES.NOT_FOUND, "Order not found");

  const existingPkgs = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) => p.orderIds.includes(ord._id),
  );
  if (ord.status !== "unpaid" && existingPkgs[0]) {
    return { packageId: existingPkgs[0]._id, alreadyProcessed: true };
  }

  const payDoc = await db.get<PaymentDoc>(COLLECTIONS.PAYMENTS, paymentId(ord._id));
  if (payDoc && payDoc.status === "init") {
    await db.put<PaymentDoc>(COLLECTIONS.PAYMENTS, {
      ...payDoc,
      wxTransactionId: params.wxTransactionId,
      status: "paid",
      paidAt: now,
      rawNotifyAt: now,
    });
  }

  await db.put<OrderDoc>(COLLECTIONS.ORDERS, {
    ...ord,
    status: "paid",
    paidAt: now,
    updatedAt: now,
  });

  await postLedgerEntry(db, {
    _id: ledgerKeyPay(ord._id),
    eventType: "mp_pay",
    bizId: ord._id,
    lines: [
      { accountCode: LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, debitFen: ord.totalPaidFen, creditFen: ZERO_FEN },
      { accountCode: LEDGER_ACCOUNT_CODES.REV_PRODUCT_SALES, debitFen: ZERO_FEN, creditFen: ord.totalPaidFen },
    ],
    memo: `小程序订单 ${ord._id} 微信支付收款`,
    createdAt: now,
  });

  const style = (await db.get<StyleDoc>(COLLECTIONS.STYLES, ord.skuCode))!;
  const prod = ord.productId ? await db.get<ProductDoc>(COLLECTIONS.PRODUCTS, ord.productId) : null;
  const addr = ord.receiverAddrId ? await db.get<AddressDoc>(COLLECTIONS.ADDRESSES, ord.receiverAddrId) : null;

  const pkgId = newPackageId();
  const isReadyStock = prod?.saleType === "ready_stock";
  if (isReadyStock) {
    await commitPaidStockReservation(db, { orderId: ord._id, packageId: pkgId, nowUtcMs: now });
  }

  const pkgDoc: OrderPackageDoc = {
    _id: pkgId,
    channel: "mp_wechat",
    poolTarget: "mp",
    orderIds: [ord._id],
    externalOrderIds: [],
    buyerUserId: ord.buyerUserId,
    buyerProvince: addr?.province ?? "",
    buyerCity: addr?.city ?? "",
    itemsSnapshot: [
      {
        skuCode: style._id,
        skuName: style.name,
        qty: ord.qty,
        standardMin: style.standardMin,
        yarnBomSnapshot: style.yarnBom.map((b) => ({
          yarnCode: b.yarnCode,
          consumedG: Math.ceil((b.netWeightG * (10000 + style.wasteRateBp)) / 10000),
        })),
        materialCostFen: style.materialCostFen,
        craftFeeFen: style.craftFeeFen,
        yarnPoolAccrualFen: style.yarnPoolAccrualFen,
        weaverShipShareFen: style.weaverShipShareFen,
        saleType: prod?.saleType ?? "made_to_order",
      },
    ],
    totalMin: style.standardMin * ord.qty,
    status: "waiting_dispatch",
    isReadyStockReuse: isReadyStock,
    attemptCount: 0,
    reviewMode: "required",
    dispatchableAt: now,
    dueAt: now + 5 * DAY_MS,
    version: 1,
    updatedAt: now,
  };
  await db.insert(COLLECTIONS.ORDER_PACKAGES, pkgDoc);

  return { packageId: pkgId, alreadyProcessed: false };
}

/**
 * Buyer initiates refund on Mini-Program (Round 7 Q1/Q2/Q3):
 *  - Pre-making (`waiting_dispatch` / `offered`): instant auto-refund (`cancelled_full`)!
 *  - In-making (`making`) or post-signoff: enters `pending_review` for admin confirmation.
 */
export async function requestMpBuyerRefund(
  db: DbAdapter,
  params: {
    orderId: string;
    buyerUserId: string;
    reason: string;
    trigger?: RefundDoc["trigger"];
    paymentPort?: Pick<PaymentPort, "initiateRefund">;
    nowUtcMs?: number;
  },
): Promise<RefundDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const ord = await db.get<OrderDoc>(COLLECTIONS.ORDERS, params.orderId);
  if (!ord || ord.buyerUserId !== params.buyerUserId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "订单不存在或无权操作");
  }
  if (ord.status === "refunded") {
    throw new AppError(ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY, "该订单已完成退款，请勿重复申请");
  }
  if (ord.status !== "paid") {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "当前订单未支付，不可发起退款");
  }

  const pkgs = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.orderIds.includes(ord._id));
  const pkg = pkgs[0];
  if (!pkg) throw new AppError(ERROR_CODES.NOT_FOUND, "未找到关联履约包裹");

  const existingRefunds = await db.find<RefundDoc>(COLLECTIONS.REFUNDS, (r) => r.orderId === ord._id);
  if (existingRefunds.some((r) => ["pending_review", "refunding", "succeeded"].includes(r.status))) {
    throw new AppError(ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY, "该订单已有处理中或已完成的退款单");
  }

  const seq = existingRefunds.length + 1;
  const rId = refundId(ord._id, seq);

  const isPreMaking = pkg.status === "waiting_dispatch" || pkg.status === "offered";
  if (isPreMaking) {
    // Cancel active pending offer first so innocent weaver is never penalized on 1h sweep!
    if (pkg.status === "offered" && pkg.attemptCount > 0) {
      const offId = dispatchOfferId(pkg._id, pkg.attemptCount);
      const off = await db.get<DispatchOfferDoc>(COLLECTIONS.DISPATCH_OFFERS, offId);
      if (off && off.status === "pending") {
        await transitionStatus(
          db,
          COLLECTIONS.DISPATCH_OFFERS,
          off._id,
          DISPATCH_OFFER_STATUS_SPEC,
          "pending",
          "cancelled",
          off.version,
          () => ({ respondedAt: now }),
          now,
        );
      }
    }

    await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      pkg.status,
      "cancelled_full",
      pkg.version,
      () => ({ assignedWeaverId: undefined }),
      now,
    );
    await releaseStockReservationForOrderOrPackage(db, {
      orderIds: [ord._id],
      packageId: pkg._id,
      nowUtcMs: now,
    });
    await db.put<OrderDoc>(COLLECTIONS.ORDERS, { ...ord, status: "refunded", updatedAt: now });

    let wxRefundId: string | undefined;
    if (params.paymentPort) {
      const payDoc = await db.get<PaymentDoc>(COLLECTIONS.PAYMENTS, paymentId(ord._id));
      const gw = await params.paymentPort.initiateRefund({
        mchId: payDoc?.mchId ?? "MCH_DEFAULT",
        outTradeNo: payDoc?.outTradeNo ?? `WXTZ_${ord._id}`,
        outRefundNo: rId,
        refundFen: ord.totalPaidFen,
        totalFen: ord.totalPaidFen,
        reason: params.reason || "派单前买家秒退",
      });
      wxRefundId = gw.wxRefundId;
    }

    const refDoc: RefundDoc = {
      _id: rId,
      orderId: ord._id,
      packageId: pkg._id,
      channel: "mp_wechat",
      trigger: "buyer_pre_dispatch",
      autoApproved: true,
      amountFen: ord.totalPaidFen,
      wxRefundId,
      weaverCraftPolicy: "none",
      status: "succeeded",
      reason: params.reason,
      version: 1,
      createdAt: now,
      completedAt: now,
    };
    await db.insert(COLLECTIONS.REFUNDS, refDoc);
    await postLedgerEntry(db, {
      _id: `pre_ref:${rId}`,
      eventType: "quality_refund",
      bizId: rId,
      lines: [
        { accountCode: LEDGER_ACCOUNT_CODES.REV_PRODUCT_SALES, debitFen: ord.totalPaidFen, creditFen: ZERO_FEN },
        { accountCode: LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, debitFen: ZERO_FEN, creditFen: ord.totalPaidFen },
      ],
      memo: `派单前顾客自动秒退 ${ord._id}`,
      createdAt: now,
    });
    return refDoc;
  }

  const inferredTrigger: RefundDoc["trigger"] =
    params.trigger ??
    (["making", "photo_review", "awaiting_seal", "ready_to_ship"].includes(pkg.status)
      ? "buyer_in_making"
      : "quality_defect");

  const refDoc: RefundDoc = {
    _id: rId,
    orderId: ord._id,
    packageId: pkg._id,
    channel: "mp_wechat",
    trigger: inferredTrigger,
    autoApproved: false,
    amountFen: ord.totalPaidFen,
    weaverCraftPolicy:
      inferredTrigger === "buyer_in_making"
        ? "keep_as_stock"
        : inferredTrigger === "logistics_loss"
          ? "keep_paid"
          : "forfeit_craft_only",
    status: "pending_review",
    reason: params.reason,
    version: 1,
    createdAt: now,
  };
  await db.insert(COLLECTIONS.REFUNDS, refDoc);
  return refDoc;
}

/**
 * Admin resolves post-acceptance refund / 7d return / quality defect / courier loss:
 *  - `quality_defect`: refunds buyer in full, does NOT accrue craft fee, NEVER claws back weaver's other money, deducts credit score;
 *  - `logistics_loss`: refunds buyer in full (`EXP_LOSS_COMP`) AND still pays weaver her full multi-qty craft fee + yarn pool accrual!
 *  - `buyer_in_making`: refunds buyer, transitions package to `cancelled_made`, compacts weaver queue, and registers `weaverStock`!
 *  - `buyer_return_7d`: refunds buyer, transitions `signed -> returned`, and registers returned core item to `weaverStock`!
 */
export async function resolvePendingRefundByAdmin(
  db: DbAdapter,
  params: {
    refundId: string;
    adminUserId: string;
    approve: boolean;
    paymentPort?: Pick<PaymentPort, "initiateRefund">;
    nowUtcMs?: number;
  },
): Promise<RefundDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const ref = await db.get<RefundDoc>(COLLECTIONS.REFUNDS, params.refundId);
  if (!ref || ref.status !== "pending_review") {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "退款单不在待审核状态");
  }

  if (!params.approve) {
    const tr = await transitionStatus(
      db,
      COLLECTIONS.REFUNDS,
      ref._id,
      REFUND_STATUS_SPEC,
      "pending_review",
      "rejected",
      ref.version,
      () => ({ operatorId: params.adminUserId, completedAt: now }),
      now,
    );
    return tr.doc!;
  }

  const ord = await db.get<OrderDoc>(COLLECTIONS.ORDERS, ref.orderId);
  if (ord?.status === "refunded") {
    throw new AppError(ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY, "关联订单已退款");
  }

  const pkg = (await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, ref.packageId))!;
  const amt = asPositiveFen(ref.amountFen);

  const tr1 = await transitionStatus(
    db,
    COLLECTIONS.REFUNDS,
    ref._id,
    REFUND_STATUS_SPEC,
    "pending_review",
    "refunding",
    ref.version,
    () => ({ operatorId: params.adminUserId }),
    now,
  );
  if (!tr1.moved || !tr1.doc) {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "退款单状态竞争冲突");
  }

  let wxRefundId: string | undefined;
  if (params.paymentPort && ord) {
    const payDoc = await db.get<PaymentDoc>(COLLECTIONS.PAYMENTS, paymentId(ord._id));
    const gw = await params.paymentPort.initiateRefund({
      mchId: payDoc?.mchId ?? "MCH_DEFAULT",
      outTradeNo: payDoc?.outTradeNo ?? `WXTZ_${ord._id}`,
      outRefundNo: ref._id,
      refundFen: amt,
      totalFen: ord.totalPaidFen,
      reason: ref.reason || ref.trigger,
    });
    wxRefundId = gw.wxRefundId;
  }

  if (ref.trigger === "quality_defect") {
    if (pkg.status === "signed") {
      await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "signed",
        "quality_refunded",
        pkg.version,
        undefined,
        now,
      );
    }
    await postLedgerEntry(db, {
      _id: ledgerKeyQualityRefund(ref._id),
      eventType: "quality_refund",
      bizId: ref._id,
      lines: [
        { accountCode: LEDGER_ACCOUNT_CODES.EXP_LOSS_COMP, debitFen: amt, creditFen: ZERO_FEN },
        { accountCode: LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, debitFen: ZERO_FEN, creditFen: amt },
      ],
      memo: `质量瑕疵全额退买家（不结该单工价，不倒扣织女其他应得）`,
      createdAt: now,
    });
    if (pkg.assignedWeaverId) {
      await db.atomicUpdate<UserDoc>(
        COLLECTIONS.USERS,
        pkg.assignedWeaverId,
        () => true,
        (u) => ({ ...u, creditScore: Math.max(0, u.creditScore - 15), updatedAt: now }),
      );
    }
  } else if (ref.trigger === "logistics_loss") {
    if (pkg.status === "shipped") {
      await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        "shipped",
        "lost_compensated",
        pkg.version,
        undefined,
        now,
      );
    }
    await postLedgerEntry(db, {
      _id: ledgerKeyLossComp(pkg._id),
      eventType: "loss_comp",
      bizId: pkg._id,
      lines: [
        { accountCode: LEDGER_ACCOUNT_CODES.EXP_LOSS_COMP, debitFen: amt, creditFen: ZERO_FEN },
        { accountCode: LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, debitFen: ZERO_FEN, creditFen: amt },
      ],
      memo: `快递丢损平台兜底赔买家（照常给织女结全量工价）`,
      createdAt: now,
    });
    if (pkg.assignedWeaverId) {
      let craftTotal = ZERO_FEN;
      let yarnAccrualTotal = ZERO_FEN;
      let shipShare = ZERO_FEN;
      for (const item of pkg.itemsSnapshot) {
        for (let q = 0; q < item.qty; q++) {
          craftTotal = addFen(craftTotal, item.craftFeeFen);
          yarnAccrualTotal = addFen(yarnAccrualTotal, item.yarnPoolAccrualFen);
        }
        if (item.weaverShipShareFen > shipShare) shipShare = item.weaverShipShareFen;
      }
      const shipDoc = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, shipmentId(pkg._id));
      let selfShipReimb = ZERO_FEN;
      if (shipDoc?.fulfillMode === "weaver_self_ship") {
        shipShare = ZERO_FEN;
        if (shipDoc.selfShipReimbFen) selfShipReimb = shipDoc.selfShipReimbFen;
      }
      await accrueSettledPackage(db, {
        packageId: pkg._id,
        weaverId: pkg.assignedWeaverId,
        craftFeeFen: craftTotal,
        weaverShipShareFen: asNonNegativeFen(shipShare),
        yarnPoolAccrualFen: yarnAccrualTotal,
        selfShipReimbFen: selfShipReimb,
        nowUtcMs: now,
      });
    }
  } else if (
    ref.trigger === "buyer_in_making" &&
    ["making", "photo_review", "awaiting_seal", "ready_to_ship"].includes(pkg.status)
  ) {
    const weaverId = pkg.assignedWeaverId;
    await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      pkg.status,
      "cancelled_made",
      pkg.version,
      () => ({ queueSeq: undefined, stallPromptedAt: undefined }),
      now,
    );
    if (weaverId) {
      await compactWeaverQueue(db, weaverId, now);
    }
    await registerCancelledPackageToWeaverStock(db, pkg, now);
    await postLedgerEntry(db, {
      _id: `cancel_made_ref:${ref._id}`,
      eventType: "quality_refund",
      bizId: ref._id,
      lines: [
        { accountCode: LEDGER_ACCOUNT_CODES.REV_PRODUCT_SALES, debitFen: amt, creditFen: ZERO_FEN },
        { accountCode: LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, debitFen: ZERO_FEN, creditFen: amt },
      ],
      memo: `开工后买家取消退款，成品转入余货专区`,
      createdAt: now,
    });
  } else if (ref.trigger === "buyer_return_7d" && pkg.status === "signed") {
    await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "signed",
      "returned",
      pkg.version,
      undefined,
      now,
    );
    await registerCancelledPackageToWeaverStock(db, pkg, now);
    await postLedgerEntry(db, {
      _id: `ret7d_ref:${ref._id}`,
      eventType: "quality_refund",
      bizId: ref._id,
      lines: [
        { accountCode: LEDGER_ACCOUNT_CODES.REV_PRODUCT_SALES, debitFen: amt, creditFen: ZERO_FEN },
        { accountCode: LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH, debitFen: ZERO_FEN, creditFen: amt },
      ],
      memo: `签收7天无理由退货退款，固定款回收再售`,
      createdAt: now,
    });
  } else {
    throw new AppError(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      `当前包裹状态 (${pkg.status}) 不支持退款类型 (${ref.trigger})`,
    );
  }

  if (ord) {
    await db.put<OrderDoc>(COLLECTIONS.ORDERS, { ...ord, status: "refunded", updatedAt: now });
  }

  const tr2 = await transitionStatus(
    db,
    COLLECTIONS.REFUNDS,
    ref._id,
    REFUND_STATUS_SPEC,
    "refunding",
    "succeeded",
    tr1.doc.version,
    () => ({ wxRefundId, completedAt: now }),
    now,
  );

  return tr2.doc!;
}
