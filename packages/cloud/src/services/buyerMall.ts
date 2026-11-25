import { computeWeaverStyleUnits } from "../../../shared/src/capacity.ts";
import { COLLECTIONS } from "../../../shared/src/collections.ts";
import { DAY_MS } from "../../../shared/src/cst.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";
import { ZERO_FEN, addFen, asNonNegativeFen, asPositiveFen, type Fen } from "../../../shared/src/money.ts";
import { ORDER_PACKAGE_STATUS_SPEC, REFUND_STATUS_SPEC } from "../../../shared/src/status.ts";
import {
  LEDGER_ACCOUNT_CODES,
  type AddressDoc,
  type OrderDoc,
  type OrderPackageDoc,
  type PaymentDoc,
  type ProductDoc,
  type RefundDoc,
  type StyleDoc,
  type UserDoc,
  type WeaverStockDoc,
  type YarnCatalogDoc,
} from "../../../shared/src/schemas.ts";
import type { DbAdapter } from "../kit/db.ts";
import {
  ledgerKeyLossComp,
  ledgerKeyPay,
  ledgerKeyQualityRefund,
  newOrderId,
  newPackageId,
  paymentId,
  refundId,
} from "../kit/ids.ts";
import { accrueSettledPackage, postLedgerEntry } from "../kit/ledger.ts";
import { reserveReadyStock } from "../kit/stockLock.ts";
import { transitionStatus } from "../kit/transition.ts";
import { registerCancelledPackageToWeaverStock } from "./douyinCsv.ts";

/**
 * Checks real-time sellability of a product on `mp-buyer` (docs/07 §4.3):
 *  - `ready_stock`: checks `sum(availableQty) >= qty`;
 *  - `made_to_order`: checks whether at least 1 eligible weaver in `mp` (or overflow `live`)
 *    has `units >= qty` within the 3-day horizon (excluding buyer herself!).
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
  const prod = await db.get<ProductDoc>(COLLECTIONS.PRODUCTS, params.productId);
  if (!prod || !prod.isOnSale) {
    return { sellable: false, availableReadyUnits: 0, reason: "off_sale" };
  }

  const stocks = await db.find<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    (s) => s.skuCode === prod.skuCode && s.availableQty > 0 && s.weaverId !== params.buyerUserId,
  );
  const availableReadyUnits = stocks.reduce((sum, s) => sum + s.availableQty, 0);

  if (prod.saleType === "ready_stock") {
    return availableReadyUnits >= qty
      ? { sellable: true, availableReadyUnits }
      : { sellable: false, availableReadyUnits, reason: "temporarily_sold_out" };
  }

  // Made-to-order: if ready stock already covers it, immediately sellable!
  if (availableReadyUnits >= qty) {
    return { sellable: true, availableReadyUnits };
  }

  const style = await db.get<StyleDoc>(COLLECTIONS.STYLES, prod.skuCode);
  if (!style || style.status !== "active") {
    return { sellable: false, availableReadyUnits, reason: "off_sale" };
  }

  const weavers = await db.find<UserDoc>(
    COLLECTIONS.USERS,
    (u) =>
      u.roles.includes("weaver") &&
      u.funnelStage === "approved" &&
      u.acceptingOrders &&
      u._id !== params.buyerUserId,
  );
  const activePkgs = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) =>
    ["offered", "making", "photo_review"].includes(p.status),
  );
  const backlogMap = new Map<string, number>();
  for (const p of activePkgs) {
    if (p.assignedWeaverId) {
      backlogMap.set(p.assignedWeaverId, (backlogMap.get(p.assignedWeaverId) ?? 0) + p.totalMin);
    }
  }
  const yarns = await db.find<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, () => true);
  const yarnWeightMap = new Map(yarns.map((y) => [y._id, y.unitWeightG || 50]));

  for (const w of weavers) {
    const cap = computeWeaverStyleUnits(
      {
        userId: w._id,
        acceptingOrders: w.acceptingOrders,
        pauseUntil: w.pauseUntil,
        restDays: w.restDays,
        dailyCapacityMin: w.dailyCapacityMin,
        speedFactor: w.speedFactor,
        backlogMin: backlogMap.get(w._id) ?? 0,
        yarnInventory: w.yarnInventory,
      },
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
      { nowUtcMs: now, horizonDays: params.mpHorizonDays ?? 3 },
    );
    if (cap.units >= qty) {
      return { sellable: true, availableReadyUnits };
    }
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
    isReadyStockReuse: prod?.saleType === "ready_stock",
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
    nowUtcMs?: number;
  },
): Promise<RefundDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const ord = await db.get<OrderDoc>(COLLECTIONS.ORDERS, params.orderId);
  if (!ord || ord.buyerUserId !== params.buyerUserId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "订单不存在或无权操作");
  }
  const pkgs = await db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, (p) => p.orderIds.includes(ord._id));
  const pkg = pkgs[0];
  if (!pkg) throw new AppError(ERROR_CODES.NOT_FOUND, "未找到关联履约包裹");

  const existingRefunds = await db.find<RefundDoc>(COLLECTIONS.REFUNDS, (r) => r.orderId === ord._id);
  const seq = existingRefunds.length + 1;
  const rId = refundId(ord._id, seq);

  const isPreMaking = pkg.status === "waiting_dispatch" || pkg.status === "offered";
  if (isPreMaking) {
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
    const refDoc: RefundDoc = {
      _id: rId,
      orderId: ord._id,
      packageId: pkg._id,
      channel: "mp_wechat",
      trigger: "buyer_pre_dispatch",
      autoApproved: true,
      amountFen: ord.totalPaidFen,
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

  const refDoc: RefundDoc = {
    _id: rId,
    orderId: ord._id,
    packageId: pkg._id,
    channel: "mp_wechat",
    trigger: params.trigger ?? (pkg.status === "making" ? "buyer_in_making" : "quality_defect"),
    autoApproved: false,
    amountFen: ord.totalPaidFen,
    weaverCraftPolicy: pkg.status === "making" ? "keep_as_stock" : "forfeit_craft_only",
    status: "pending_review",
    reason: params.reason,
    version: 1,
    createdAt: now,
  };
  await db.insert(COLLECTIONS.REFUNDS, refDoc);
  return refDoc;
}

/**
 * Admin resolves post-acceptance refund / quality defect / courier loss:
 *  - `quality_defect`: refunds buyer in full, does NOT accrue craft fee, NEVER claws back weaver's other money, deducts credit score;
 *  - `logistics_loss`: refunds buyer in full (`EXP_LOSS_COMP`) AND still pays weaver her full craft fee + yarn pool accrual!
 *  - `buyer_in_making`: refunds buyer, transitions package to `cancelled_made`, registers `weaverStock`, and still pays weaver!
 */
export async function resolvePendingRefundByAdmin(
  db: DbAdapter,
  params: {
    refundId: string;
    adminUserId: string;
    approve: boolean;
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
  const tr2 = await transitionStatus(
    db,
    COLLECTIONS.REFUNDS,
    ref._id,
    REFUND_STATUS_SPEC,
    "refunding",
    "succeeded",
    tr1.doc!.version,
    () => ({ completedAt: now }),
    now,
  );

  const pkg = (await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, ref.packageId))!;
  const amt = asPositiveFen(ref.amountFen);

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
      memo: `快递丢损平台兜底赔买家（照常给织女结工价）`,
      createdAt: now,
    });
    if (pkg.assignedWeaverId) {
      const item = pkg.itemsSnapshot[0]!;
      await accrueSettledPackage(db, {
        packageId: pkg._id,
        weaverId: pkg.assignedWeaverId,
        craftFeeFen: item.craftFeeFen,
        weaverShipShareFen: asNonNegativeFen(item.weaverShipShareFen),
        yarnPoolAccrualFen: item.yarnPoolAccrualFen,
        nowUtcMs: now,
      });
    }
  } else if (ref.trigger === "buyer_in_making" && pkg.status === "making") {
    await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "making",
      "cancelled_made",
      pkg.version,
      undefined,
      now,
    );
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
  }

  return tr2.doc!;
}
