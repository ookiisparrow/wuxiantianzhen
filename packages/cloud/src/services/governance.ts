import {
  AppError,
  COLLECTIONS,
  DAY_MS,
  ERROR_CODES,
  HOUR_MS,
  LEDGER_ACCOUNT_CODES,
  MINUTE_MS,
  TICKET_STATUS_SPEC,
  WEAVER_DEPOSIT_FEN,
  ZERO_FEN,
  addFen,
  asFen,
  asNonNegativeFen,
  formatCstYmd,
  type DispatchOfferDoc,
  type Fen,
  type NotificationDoc,
  type OrderDoc,
  type OrderPackageDoc,
  type PaymentDoc,
  type ProductDoc,
  type RecruitFunnelDoc,
  type SystemConfigDoc,
  type TicketDoc,
  type TicketStatus,
  type UserDoc,
  type WeaverAccountDoc,
  type WeaverStockDoc,
  type YarnClaimDoc,
} from "@wxtz/shared";
import type { DbAdapter } from "../kit/db.ts";
import {
  newNotificationId,
  newTicketId,
  paymentId,
  recruitFunnelId,
  restockReminderId,
  weaverAccountId,
} from "../kit/ids.ts";
import { refundWeaverDeposit } from "../kit/ledger.ts";
import { transitionStatus } from "../kit/transition.ts";
import type { NotificationPort, PaymentPort } from "../ports/index.ts";

const VALID_TICKET_TYPES: ReadonlySet<TicketDoc["type"]> = new Set([
  "order_issue",
  "after_sale",
  "yarn_issue",
  "pattern_bug",
  "other",
]);

const UNSETTLED_PACKAGE_STATUSES: ReadonlySet<OrderPackageDoc["status"]> = new Set([
  "offered",
  "making",
  "photo_review",
  "awaiting_seal",
  "ready_to_ship",
  "shipped",
  "signed",
  "settled_ready",
  "lost_compensated",
  "manual_hold",
]);

export async function submitTicket(
  db: DbAdapter,
  params: {
    userId: string;
    role: "buyer" | "weaver";
    type: TicketDoc["type"];
    relatedId?: string;
    content: string;
    photoFileIds?: string[];
    nowUtcMs?: number;
  },
): Promise<TicketDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const content = String(params.content ?? "").trim();
  if (!content) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "工单反馈内容不能为空");
  }
  const type: TicketDoc["type"] = VALID_TICKET_TYPES.has(params.type) ? params.type : "other";

  const doc: TicketDoc = {
    _id: newTicketId(),
    userId: params.userId,
    role: params.role,
    type,
    relatedId: params.relatedId ? String(params.relatedId).trim() : undefined,
    content,
    photoFileIds: Array.isArray(params.photoFileIds) ? params.photoFileIds.map(String) : [],
    status: "open",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(COLLECTIONS.TICKETS, doc);
  return doc;
}

export async function listTickets(
  db: DbAdapter,
  filter: { userId?: string; status?: TicketStatus; role?: "buyer" | "weaver" } = {},
): Promise<TicketDoc[]> {
  const tickets = await db.find<TicketDoc>(COLLECTIONS.TICKETS, (t) => {
    if (filter.userId && t.userId !== filter.userId) return false;
    if (filter.status && t.status !== filter.status) return false;
    if (filter.role && t.role !== filter.role) return false;
    return true;
  });
  tickets.sort((a, b) => b.createdAt - a.createdAt);
  return tickets;
}

export async function replyAndResolveTicket(
  db: DbAdapter,
  params: {
    ticketId: string;
    handlerId: string;
    reply: string;
    nextStatus?: "processing" | "resolved";
    nowUtcMs?: number;
  },
): Promise<TicketDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const reply = String(params.reply ?? "").trim();
  if (!reply) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "工单回复内容不能为空");
  }
  const tkt = await db.get<TicketDoc>(COLLECTIONS.TICKETS, params.ticketId);
  if (!tkt) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `工单不存在：${params.ticketId}`);
  }
  const nextStatus: TicketStatus = params.nextStatus === "processing" ? "processing" : "resolved";

  const tr = await transitionStatus(
    db,
    COLLECTIONS.TICKETS,
    tkt._id,
    TICKET_STATUS_SPEC,
    tkt.status,
    nextStatus,
    tkt.version,
    () => ({ reply, handlerId: params.handlerId }),
    now,
  );
  if (!tr.moved || !tr.doc) {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "工单状态并发冲突");
  }
  return tr.doc;
}

export async function setWeaverOrderAcceptance(
  db: DbAdapter,
  params: {
    weaverId: string;
    acceptingOrders: boolean;
    pauseUntil?: number;
    restDays?: string[];
    nowUtcMs?: number;
  },
): Promise<UserDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const upd = await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    params.weaverId,
    (u) => u.funnelStage === "approved",
    (u) => {
      const activePenalty = u.pauseUntil && u.pauseUntil > now ? u.pauseUntil : undefined;
      let nextPause = u.pauseUntil;
      if (params.pauseUntil !== undefined && Number.isFinite(params.pauseUntil)) {
        if (activePenalty !== undefined) {
          nextPause = Math.max(activePenalty, params.pauseUntil);
        } else {
          nextPause = params.pauseUntil > now ? params.pauseUntil : undefined;
        }
      }
      return {
        ...u,
        acceptingOrders: Boolean(params.acceptingOrders),
        pauseUntil: nextPause,
        restDays: Array.isArray(params.restDays) ? params.restDays.map(String) : u.restDays,
        updatedAt: now,
      };
    },
  );
  if (!upd.updated || !upd.doc) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "织女尚未通过准入漏斗，不可设置接单开关");
  }
  return upd.doc;
}

/**
 * Processes a weaver's cooperative exit and full 200-Yuan performance deposit refund (`docs/07` §4.2 & §6 #4).
 * Strictly requires zero in-flight or un-settled packages (`signed` must wait 7d + payout settlement).
 */
export async function requestWeaverExitAndRefundDeposit(
  db: DbAdapter,
  params: { weaverId: string; paymentPort?: PaymentPort; nowUtcMs?: number },
): Promise<{ refundedFen: Fen; wxRefundId?: string }> {
  const now = params.nowUtcMs ?? Date.now();
  const blocking = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) => p.assignedWeaverId === params.weaverId && UNSETTLED_PACKAGE_STATUSES.has(p.status),
  );
  if (blocking.length > 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "仍有在途或未满7天待结清包裹，暂不可退保证金",
      { blockingPackageIds: blocking.map((p) => p._id) },
    );
  }

  const lockedStocks = await db.find<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    (s) => s.weaverId === params.weaverId && s.reservedQty > 0,
  );
  if (lockedStocks.length > 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "仍有买家已锁定的在售余货待发，请发完并结清后再申请退保",
    );
  }

  const inFlightClaims = await db.find<YarnClaimDoc>(
    COLLECTIONS.YARN_CLAIMS,
    (c) => c.weaverId === params.weaverId && ["reserved", "confirmed", "dispatched"].includes(c.status),
  );
  if (inFlightClaims.length > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "仍有在途周度领线单未完结，请先确认收货或取消后再申请退保");
  }

  const acc = await db.get<WeaverAccountDoc>(COLLECTIONS.WEAVER_ACCOUNTS, weaverAccountId(params.weaverId));
  if (!acc || acc.depositFen <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "当前账户无待退还的合作履约保证金");
  }
  if (acc.payableBalanceFen > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "仍有待汇出的已计提工价余额，请等待批次打款完成后退保");
  }

  const fId = recruitFunnelId(params.weaverId);
  const funnel = await db.get<RecruitFunnelDoc>(COLLECTIONS.RECRUIT_FUNNEL, fId);
  let wxRefundId: string | undefined;
  let cashAccount: typeof LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH | typeof LEDGER_ACCOUNT_CODES.ASSET_BANK_CASH =
    funnel?.depositChannel === "manual_transfer_verify"
      ? LEDGER_ACCOUNT_CODES.ASSET_BANK_CASH
      : LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH;

  let depPay: PaymentDoc | null = null;
  if (funnel?.depositRefId) {
    depPay = await db.get<PaymentDoc>(COLLECTIONS.PAYMENTS, paymentId(funnel.depositRefId));
  }
  if (!depPay || depPay.status !== "paid") {
    const paidDeps = await db.find<PaymentDoc>(
      COLLECTIONS.PAYMENTS,
      (p) => p.buyerUserId === params.weaverId && p.orderId.startsWith("DEP_") && p.status === "paid",
    );
    paidDeps.sort((a, b) => (b.paidAt ?? 0) - (a.paidAt ?? 0));
    depPay = paidDeps[0] ?? null;
  }

  if (depPay && depPay.status === "paid") {
    cashAccount = LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH;
    if (params.paymentPort) {
      const gw = await params.paymentPort.initiateRefund({
        mchId: depPay.mchId,
        outTradeNo: depPay.outTradeNo,
        outRefundNo: `REF_DEP_${params.weaverId}_${now}`,
        refundFen: WEAVER_DEPOSIT_FEN,
        totalFen: depPay.amountFen,
        reason: "织女合作期满无违约原路退还履约保证金",
      });
      wxRefundId = gw.wxRefundId;
    }
    await db.put<PaymentDoc>(COLLECTIONS.PAYMENTS, {
      ...depPay,
      status: "closed",
    });
  }

  await refundWeaverDeposit(db, params.weaverId, cashAccount, now);

  await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    params.weaverId,
    () => true,
    (u) => ({
      ...u,
      acceptingOrders: false,
      funnelStage: "none",
      updatedAt: now,
    }),
  );

  await db.atomicUpdate<RecruitFunnelDoc>(
    COLLECTIONS.RECRUIT_FUNNEL,
    fId,
    () => true,
    (f) => ({
      ...f,
      depositStatus: "refunded",
      version: f.version + 1,
      updatedAt: now,
    }),
  );

  const stocks = await db.find<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    (s) => s.weaverId === params.weaverId && s.availableQty > 0 && s.reservedQty === 0,
  );
  for (const st of stocks) {
    await db.atomicUpdate<WeaverStockDoc>(
      COLLECTIONS.WEAVER_STOCK,
      st._id,
      (cur) => cur.reservedQty === 0,
      (cur) => ({ ...cur, availableQty: 0, version: cur.version + 1, updatedAt: now }),
    );
  }

  return { refundedFen: WEAVER_DEPOSIT_FEN, wxRefundId };
}

export async function subscribeProductRestockReminder(
  db: DbAdapter,
  params: { userId: string; productId: string; nowUtcMs?: number },
): Promise<NotificationDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const prod = await db.get<ProductDoc>(COLLECTIONS.PRODUCTS, params.productId);
  if (!prod) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `商品不存在：${params.productId}`);
  }
  const id = restockReminderId(params.userId, prod.skuCode);
  const existing = await db.get<NotificationDoc>(COLLECTIONS.NOTIFICATIONS, id);
  const doc: NotificationDoc = {
    _id: id,
    userId: params.userId,
    channel: "restock_watch",
    scene: "restock_reminder",
    skuCode: prod.skuCode,
    status: "watching",
    payload: { productId: prod._id, title: prod.title },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.put(COLLECTIONS.NOTIFICATIONS, doc);
  return doc;
}

/**
 * 5-minute watchdog sub-task: sends one-time urgent SMS reminder when a pending dispatch offer
 * has <= 10 minutes remaining before its 60-minute expiry (`docs/07` §3.3 #12 & §5.2).
 */
export async function sweepOfferPreExpirySmsReminders(
  db: DbAdapter,
  notifyPort: NotificationPort,
  nowUtcMs: number = Date.now(),
): Promise<{ smsSentCount: number }> {
  const expiringSoon = await db.find<DispatchOfferDoc>(
    COLLECTIONS.DISPATCH_OFFERS,
    (o) =>
      o.status === "pending" &&
      !o.smsReminderSentAt &&
      o.expireAt > nowUtcMs &&
      o.expireAt - nowUtcMs <= 10 * MINUTE_MS,
  );

  let smsSentCount = 0;
  for (const off of expiringSoon) {
    const claimed = await db.atomicUpdate<DispatchOfferDoc>(
      COLLECTIONS.DISPATCH_OFFERS,
      off._id,
      (cur) => cur.status === "pending" && !cur.smsReminderSentAt,
      (cur) => ({ ...cur, smsReminderSentAt: nowUtcMs, version: cur.version + 1 }),
    );
    if (!claimed.updated) continue;

    const weaver = await db.get<UserDoc>(COLLECTIONS.USERS, off.weaverId);
    if (!weaver?.phone) continue;

    const minutesLeft = String(Math.max(1, Math.ceil((off.expireAt - nowUtcMs) / MINUTE_MS)));
    await notifyPort.sendUrgentSms({
      phone: weaver.phone,
      templateCode: "SMS_OFFER_EXPIRING_10M",
      params: { packageId: off.packageId, minutesLeft },
    });

    await db.insert<NotificationDoc>(COLLECTIONS.NOTIFICATIONS, {
      _id: newNotificationId(),
      userId: off.weaverId,
      channel: "sms",
      scene: "offer_10m_reminder",
      status: "sent",
      payload: { offerId: off._id, packageId: off.packageId, minutesLeft },
      createdAt: nowUtcMs,
      updatedAt: nowUtcMs,
    });
    smsSentCount++;
  }

  return { smsSentCount };
}

export async function computeCurrentMonthSalesFen(db: DbAdapter, nowUtcMs: number = Date.now()): Promise<Fen> {
  const currentYm = formatCstYmd(nowUtcMs).slice(0, 7);
  const paidOrders = await db.find<OrderDoc>(
    COLLECTIONS.ORDERS,
    (o) =>
      (o.status === "paid" || o.status === "fulfilled") &&
      formatCstYmd(o.paidAt ?? o.createdAt).slice(0, 7) === currentYm,
  );
  let total = ZERO_FEN;
  for (const ord of paidOrders) {
    total = addFen(total, ord.totalPaidFen);
  }
  return total;
}

/**
 * Daily 09:00 CST cron (`dueAndStockAlert`, `docs/07` §5.2):
 *  1. Active packages within 48h of `dueAt`;
 *  2. Ready-stock items (`weaverStock`) sitting unsold >= 7 days;
 *  3. Sole-proprietor monthly sales tax threshold alert (default ¥80,000 warning toward ¥100,000 exemption cap).
 */
export async function runDailyDueAndStockAlerts(
  db: DbAdapter,
  nowUtcMs: number = Date.now(),
): Promise<{
  nearDuePackageIds: string[];
  staleStockDocIds: string[];
  currentMonthSalesFen: Fen;
  taxAlertThresholdFen: Fen;
  solePropMonthlyCeilingFen: Fen;
  taxAlertTriggered: boolean;
}> {
  const [nearDuePkgs, staleStocks, currentMonthSalesFen, finCfg] = await Promise.all([
    db.find<OrderPackageDoc>(
      COLLECTIONS.ORDER_PACKAGES,
      (p) =>
        ["making", "photo_review", "awaiting_seal", "ready_to_ship"].includes(p.status) &&
        p.dueAt !== undefined &&
        p.dueAt - nowUtcMs <= 48 * HOUR_MS,
    ),
    db.find<WeaverStockDoc>(
      COLLECTIONS.WEAVER_STOCK,
      (s) => s.availableQty > 0 && nowUtcMs - s.oldestCreatedAt >= 7 * DAY_MS,
    ),
    computeCurrentMonthSalesFen(db, nowUtcMs),
    db.get<SystemConfigDoc>(COLLECTIONS.CONFIG, "finance"),
  ]);

  const rawThreshold =
    finCfg?.monthlyRevenueTaxAlertFen ??
    (finCfg?.value as Record<string, unknown> | undefined)?.monthlyRevenueTaxAlertFen;
  const taxAlertThresholdFen =
    typeof rawThreshold === "number" && Number.isSafeInteger(rawThreshold) && rawThreshold > 0
      ? asNonNegativeFen(rawThreshold)
      : asFen(8_000_000); // Default ¥80,000.00 alert line
  const solePropMonthlyCeilingFen = asFen(10_000_000); // ¥100,000.00 monthly VAT exemption ceiling
  const taxAlertTriggered = currentMonthSalesFen >= taxAlertThresholdFen;

  return {
    nearDuePackageIds: nearDuePkgs.map((p) => p._id),
    staleStockDocIds: staleStocks.map((s) => s._id),
    currentMonthSalesFen,
    taxAlertThresholdFen,
    solePropMonthlyCeilingFen,
    taxAlertTriggered,
  };
}

/**
 * Monday 09:00 CST cron (`weeklyGovernance`, `docs/07` §5.2):
 *  1. Computes `recruitGate` (average weekly completed packages per active weaver over trailing 4 weeks);
 *  2. Computes 14-day projected cashflow (`accruedPayableFen` + `unaccruedInFlightCraftFen`);
 *  3. Persists snapshot to `config/recruitGate`.
 */
export async function runWeeklyGovernance(
  db: DbAdapter,
  nowUtcMs: number = Date.now(),
): Promise<{
  activeWeaverCount: number;
  recent4WeekPackages: number;
  avgWeeklyOrdersPerWeaver: number;
  recommendOpenRecruitment: boolean;
  accruedPayableFen: Fen;
  unaccruedInFlightCraftFen: Fen;
  projected14dCashOutflowFen: Fen;
}> {
  const windowStart = nowUtcMs - 28 * DAY_MS;
  const [activeWeavers, allPkgs, accounts, existingGateCfg] = await Promise.all([
    db.find<UserDoc>(
      COLLECTIONS.USERS,
      (u) => u.roles.includes("weaver") && u.funnelStage === "approved" && u.acceptingOrders,
    ),
    db.find<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, () => true),
    db.find<WeaverAccountDoc>(COLLECTIONS.WEAVER_ACCOUNTS, () => true),
    db.get<SystemConfigDoc>(COLLECTIONS.CONFIG, "recruitGate"),
  ]);

  const activeWeaverCount = activeWeavers.length;
  const completedStatuses = new Set(["shipped", "signed", "settled_ready", "settled"]);
  const inFlightCraftStatuses = new Set([
    "making",
    "photo_review",
    "awaiting_seal",
    "ready_to_ship",
    "shipped",
    "signed",
  ]);

  let recent4WeekPackages = 0;
  let unaccruedInFlightCraftFen = ZERO_FEN;

  for (const p of allPkgs) {
    if (completedStatuses.has(p.status)) {
      const completedTs = p.shippedAt ?? p.signedAt ?? p.updatedAt;
      if (completedTs >= windowStart) {
        recent4WeekPackages++;
      }
    }
    if (inFlightCraftStatuses.has(p.status)) {
      for (const item of p.itemsSnapshot) {
        for (let q = 0; q < item.qty; q++) {
          unaccruedInFlightCraftFen = addFen(unaccruedInFlightCraftFen, item.craftFeeFen);
        }
      }
    }
  }

  let accruedPayableFen = ZERO_FEN;
  for (const acc of accounts) {
    accruedPayableFen = addFen(accruedPayableFen, acc.payableBalanceFen);
  }
  const projected14dCashOutflowFen = addFen(accruedPayableFen, unaccruedInFlightCraftFen);

  const rawMinWeekly =
    existingGateCfg?.minWeeklyOrdersPerWeaver ??
    (existingGateCfg?.value as Record<string, unknown> | undefined)?.minWeeklyOrdersPerWeaver;
  const minWeeklyThreshold =
    typeof rawMinWeekly === "number" && rawMinWeekly > 0 ? rawMinWeekly : 4;

  const avgWeeklyOrdersPerWeaver =
    activeWeaverCount > 0 ? Number((recent4WeekPackages / activeWeaverCount / 4).toFixed(2)) : 0;
  const recommendOpenRecruitment = avgWeeklyOrdersPerWeaver >= minWeeklyThreshold;

  const summary = {
    activeWeaverCount,
    recent4WeekPackages,
    avgWeeklyOrdersPerWeaver,
    minWeeklyOrdersPerWeaver: minWeeklyThreshold,
    recommendOpenRecruitment,
    accruedPayableFen,
    unaccruedInFlightCraftFen,
    projected14dCashOutflowFen,
  };

  await db.put<SystemConfigDoc>(COLLECTIONS.CONFIG, {
    ...summary,
    _id: "recruitGate",
    value: summary,
    updatedBy: "cron.weeklyGovernance",
    updatedAt: nowUtcMs,
  });

  return {
    activeWeaverCount,
    recent4WeekPackages,
    avgWeeklyOrdersPerWeaver,
    recommendOpenRecruitment,
    accruedPayableFen,
    unaccruedInFlightCraftFen,
    projected14dCashOutflowFen,
  };
}
