import {
  COLLECTIONS,
  formatCstCompactYmd,
  formatCstWeekKey,
  AppError,
  ERROR_CODES,
  ZERO_FEN,
  addFen,
  asNonNegativeFen,
  asPositiveFen,
  ORDER_PACKAGE_STATUS_SPEC,
  YARN_CLAIM_STATUS_SPEC,
  LEDGER_ACCOUNT_CODES,
  type Fen,
  type AddressDoc,
  type OrderPackageDoc,
  type UserDoc,
  type WeaverAccountDoc,
  type YarnCatalogDoc,
  type YarnClaimDoc,
} from "@wxtz/shared";
import type { DbAdapter } from "../kit/db.ts";
import { ledgerKeyPayout, ledgerKeyYarnRefund, yarnClaimId } from "../kit/ids.ts";
import { debitYarnPoolAtomic, postLedgerEntry } from "../kit/ledger.ts";
import { transitionStatus } from "../kit/transition.ts";
import { receiveYarnClaimToInventory } from "../kit/yarnInventory.ts";

function csvEscape(val: string | number): string {
  const s = String(val ?? "");
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Weaver submits weekly yarn & accessory-kit claim (base-12 replenishments allowed!).
 * Atomically checks >= 3 skeins (or material pack) and deducts `weaverAccounts.yarnPoolBalanceFen`.
 */
export async function submitWeeklyYarnClaim(
  db: DbAdapter,
  params: {
    weaverId: string;
    sendAddrId: string;
    items: ReadonlyArray<{ yarnCode: string; qty: number }>;
    shippingFeeFen: Fen;
    nowUtcMs?: number;
  },
): Promise<YarnClaimDoc> {
  if (params.items.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "申领明细不能为空");
  }
  const now = params.nowUtcMs ?? Date.now();
  const weekKey = formatCstWeekKey(now);
  const claimId = yarnClaimId(params.weaverId, weekKey);

  const existing = await db.get<YarnClaimDoc>(COLLECTIONS.YARN_CLAIMS, claimId);
  if (existing && existing.status !== "cancelled") {
    throw new AppError(ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY, `本周 (${weekKey}) 已提交过线材申领`);
  }

  const addr = await db.get<AddressDoc>(COLLECTIONS.ADDRESSES, params.sendAddrId);
  if (!addr || addr.ownerUserId !== params.weaverId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "收货地址无效或不属于当前织女");
  }

  let totalQty = 0;
  let hasMaterialPack = false;
  let materialsCost = ZERO_FEN;
  const resolvedItems: YarnClaimDoc["items"] = [];

  for (const req of params.items) {
    if (!Number.isInteger(req.qty) || req.qty <= 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法申领数量：${req.qty}`);
    }
    const cat = await db.get<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, req.yarnCode);
    if (!cat || cat.status !== "active") {
      throw new AppError(ERROR_CODES.NOT_FOUND, `线材或辅料包不可申领：${req.yarnCode}`);
    }
    if (cat.isMaterialPack || cat.itemType === "material_pack") {
      hasMaterialPack = true;
    }
    totalQty += req.qty;
    for (let i = 0; i < req.qty; i++) {
      materialsCost = addFen(materialsCost, cat.unitCostFen);
    }
    resolvedItems.push({
      yarnCode: cat._id,
      supplierSkuCode: cat.supplierSkuCode,
      qty: req.qty,
      unitWeightG: cat.unitWeightG,
      unitCostFen: cat.unitCostFen,
    });
  }

  const nextAttemptVersion = (existing?.version ?? 0) + 1;

  // Atomic yarn pool deduction (enforces >=3 skeins or pack, and zero overdraft!)
  await debitYarnPoolAtomic(db, {
    claimId,
    weaverId: params.weaverId,
    totalQty,
    hasMaterialPack,
    materialsCostFen: materialsCost,
    shippingFeeFen: asNonNegativeFen(params.shippingFeeFen),
    attemptNo: nextAttemptVersion,
    nowUtcMs: now,
  });

  const doc: YarnClaimDoc = {
    _id: claimId,
    weaverId: params.weaverId,
    weekKey,
    sendAddrId: params.sendAddrId,
    items: resolvedItems,
    totalQty,
    materialsCostFen: materialsCost,
    shippingFeeFen: asNonNegativeFen(params.shippingFeeFen),
    status: "confirmed",
    version: nextAttemptVersion,
    createdAt: now,
  };
  await db.put(COLLECTIONS.YARN_CLAIMS, doc);
  return doc;
}

/**
 * Cancels an un-dispatched weekly yarn claim and refunds the deducted yarn pool balance.
 */
export async function cancelWeeklyYarnClaim(
  db: DbAdapter,
  params: { claimId: string; weaverId: string; nowUtcMs?: number },
): Promise<YarnClaimDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const claim = await db.get<YarnClaimDoc>(COLLECTIONS.YARN_CLAIMS, params.claimId);
  if (!claim || claim.weaverId !== params.weaverId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "线材申领单不存在或无权操作");
  }
  if (claim.status !== "confirmed" && claim.status !== "reserved") {
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, "已导出直发的申领单不可取消");
  }
  const tr = await transitionStatus(
    db,
    COLLECTIONS.YARN_CLAIMS,
    claim._id,
    YARN_CLAIM_STATUS_SPEC,
    claim.status,
    "cancelled",
    claim.version,
    undefined,
    now,
  );
  if (tr.moved && tr.doc) {
    const totalRefund = addFen(claim.materialsCostFen, claim.shippingFeeFen);
    const refundKey =
      claim.version > 1 ? `${ledgerKeyYarnRefund(claim._id)}:v${claim.version}` : ledgerKeyYarnRefund(claim._id);
    await postLedgerEntry(db, {
      _id: refundKey,
      eventType: "yarn_refund",
      bizId: claim._id,
      payeeId: claim.weaverId,
      lines: [
        { accountCode: LEDGER_ACCOUNT_CODES.LIAB_SUPPLIER_PAYABLE, debitFen: totalRefund, creditFen: ZERO_FEN },
        {
          accountCode: LEDGER_ACCOUNT_CODES.LIAB_YARN_POOL,
          subAccountId: claim.weaverId,
          debitFen: ZERO_FEN,
          creditFen: totalRefund,
        },
      ],
      memo: `取消周度线材申领 ${claim._id} 退回个人线材池`,
      createdAt: now,
    });
    return tr.doc;
  }
  return claim;
}

/**
 * Weekly cutoff batch export for Jiang-Zhe-Hu main supplier ERP (e.g. 聚水潭/快递助手).
 * Uses strictly `supplierSkuCode` (never colloquial color names) and transitions `confirmed -> dispatched`
 * directly (eliminating manual tracking-number re-import!).
 */
export async function exportSupplierCsvAndMarkDispatched(
  db: DbAdapter,
  params: { weekKey: string; nowUtcMs?: number },
): Promise<{ exportBatchId: string; exportedClaimCount: number; csvContent: string }> {
  const now = params.nowUtcMs ?? Date.now();
  const normalizedWeekKey = params.weekKey.replace(/-/g, "").trim();
  const exportBatchId = `YARN_${normalizedWeekKey}_${formatCstCompactYmd(now)}`;

  const claims = await db.find<YarnClaimDoc>(
    COLLECTIONS.YARN_CLAIMS,
    (c) => c.weekKey.replace(/-/g, "") === normalizedWeekKey && c.status === "confirmed",
  );

  const lines: string[] = [
    "批次号,申领单号,收件人,手机号,省份,城市,区县,详细地址,供应商标准编码,数量,备注",
  ];

  let exportedClaimCount = 0;
  for (const claim of claims) {
    const addr = await db.get<AddressDoc>(COLLECTIONS.ADDRESSES, claim.sendAddrId);
    const weaver = await db.get<UserDoc>(COLLECTIONS.USERS, claim.weaverId);
    if (!addr) continue;

    const tr = await transitionStatus(
      db,
      COLLECTIONS.YARN_CLAIMS,
      claim._id,
      YARN_CLAIM_STATUS_SPEC,
      "confirmed",
      "dispatched",
      claim.version,
      () => ({ exportBatchId }),
      now,
    );
    if (!tr.moved) continue;
    exportedClaimCount++;

    for (const item of claim.items) {
      lines.push(
        [
          exportBatchId,
          claim._id,
          addr.contactName,
          addr.contactPhone,
          addr.province,
          addr.city,
          addr.district,
          addr.detail,
          item.supplierSkuCode,
          item.qty,
          `无限天真代发·${weaver?.weaverNo ?? claim.weaverId}`,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  }

  return {
    exportBatchId,
    exportedClaimCount,
    csvContent: lines.join("\n"),
  };
}

/**
 * Weaver confirms receipt of yarn parcel -> transitions `dispatched -> received`
 * and adds whole skeins into `users.yarnInventory`!
 */
export async function confirmYarnClaimReceived(
  db: DbAdapter,
  params: {
    claimId: string;
    weaverId: string;
    confirmPhotoFileId?: string;
    nowUtcMs?: number;
  },
): Promise<UserDoc> {
  const now = params.nowUtcMs ?? Date.now();
  const claim = await db.get<YarnClaimDoc>(COLLECTIONS.YARN_CLAIMS, params.claimId);
  if (!claim || claim.weaverId !== params.weaverId || claim.status !== "dispatched") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "该申领单当前不可确认收货");
  }

  const tr = await transitionStatus(
    db,
    COLLECTIONS.YARN_CLAIMS,
    claim._id,
    YARN_CLAIM_STATUS_SPEC,
    "dispatched",
    "received",
    claim.version,
    () => ({ receivedConfirmedAt: now, confirmPhotoFileId: params.confirmPhotoFileId }),
    now,
  );
  if (!tr.moved) {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "申领单状态已变更");
  }

  // Expand material_pack items into their constituent yarn color skeins (`packItems`)
  const expandedItems: Array<{ yarnCode: string; qty: number }> = [];
  for (const i of claim.items) {
    const cat = await db.get<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, i.yarnCode);
    if ((cat?.isMaterialPack || cat?.itemType === "material_pack") && cat.packItems && cat.packItems.length > 0) {
      for (const sub of cat.packItems) {
        expandedItems.push({ yarnCode: sub.yarnCode, qty: i.qty * sub.qty });
      }
    } else if (cat?.itemType !== "accessory_kit") {
      expandedItems.push({ yarnCode: i.yarnCode, qty: i.qty });
    }
  }

  return receiveYarnClaimToInventory(db, params.weaverId, expandedItems, 1, now);
}

export interface SettlementBatchDoc {
  _id: string; // batch_YYYYMMDD
  batchDate: string;
  payeeCount: number;
  totalAmountFen: Fen;
  items: Array<{ weaverId: string; weaverNo?: string; realName: string; bankCard: string; amountFen: Fen; packageIds: string[] }>;
  status: "exported" | "paid";
  createdAt: number;
  paidAt?: number;
}

/**
 * 14-day batch payout exporter: generates corporate online-banking standard CSV
 * (招商银行 / 网商银行批量转账通用表头) for all weavers with `payableBalanceFen > 0`.
 */
export async function createSettlementBatchAndExportBankCsv(
  db: DbAdapter,
  nowUtcMs: number = Date.now(),
): Promise<{ batchId: string; payeeCount: number; totalAmountFen: Fen; csvContent: string }> {
  const ymd = formatCstCompactYmd(nowUtcMs);
  const batchId = `batch_${ymd}`;
  const existing = await db.get<SettlementBatchDoc>(COLLECTIONS.SETTLEMENT_BATCHES, batchId);
  if (existing) {
    throw new AppError(ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY, `今日结款批次已生成：${batchId}`);
  }

  const accounts = await db.find<WeaverAccountDoc>(
    COLLECTIONS.WEAVER_ACCOUNTS,
    (a) => a.payableBalanceFen > 0,
  );
  const readyPkgs = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) => p.status === "settled_ready" || p.status === "lost_compensated",
  );

  const lines = ["收款户名,收款银行账号,金额(元),备注(附订单台账批次)"];
  const items: SettlementBatchDoc["items"] = [];
  let totalFen = ZERO_FEN;

  for (const acc of accounts) {
    const user = await db.get<UserDoc>(COLLECTIONS.USERS, acc.userId);
    if (!user || !user.realName || !user.bankCardEncrypted) continue;

    const myPkgs = readyPkgs.filter((p) => p.assignedWeaverId === acc.userId).map((p) => p._id);
    totalFen = addFen(totalFen, acc.payableBalanceFen);
    const yuanStr = (acc.payableBalanceFen / 100).toFixed(2);
    const memo = `无限天真委托加工费·${batchId}·共${myPkgs.length}包`;

    lines.push([user.realName, user.bankCardEncrypted, yuanStr, memo].map(csvEscape).join(","));
    items.push({
      weaverId: acc.userId,
      weaverNo: user.weaverNo,
      realName: user.realName,
      bankCard: user.bankCardEncrypted,
      amountFen: acc.payableBalanceFen,
      packageIds: myPkgs,
    });
  }

  const batchDoc: SettlementBatchDoc = {
    _id: batchId,
    batchDate: ymd,
    payeeCount: items.length,
    totalAmountFen: totalFen,
    items,
    status: "exported",
    createdAt: nowUtcMs,
  };
  await db.insert(COLLECTIONS.SETTLEMENT_BATCHES, batchDoc);

  return {
    batchId,
    payeeCount: items.length,
    totalAmountFen: totalFen,
    csvContent: lines.join("\n"),
  };
}

/**
 * Confirms bank batch transfer completion: posts `payout:${batchId}:${payeeId}` ledger entries
 * (atomically zeroing `payableBalanceFen`) and transitions all included packages `settled_ready -> settled`.
 */
export async function confirmSettlementBatchPaid(
  db: DbAdapter,
  batchId: string,
  nowUtcMs: number = Date.now(),
): Promise<{ paidPayees: number; settledPackages: number }> {
  const batch = await db.get<SettlementBatchDoc>(COLLECTIONS.SETTLEMENT_BATCHES, batchId);
  if (!batch) throw new AppError(ERROR_CODES.NOT_FOUND, `结款批次不存在：${batchId}`);
  if (batch.status === "paid") return { paidPayees: 0, settledPackages: 0 };

  let paidPayees = 0;
  let settledPackages = 0;

  for (const item of batch.items) {
    const amt = asPositiveFen(item.amountFen);
    const postRes = await postLedgerEntry(db, {
      _id: ledgerKeyPayout(batchId, item.weaverId),
      eventType: "payout",
      bizId: batchId,
      payeeId: item.weaverId,
      settlementBatchId: batchId,
      lines: [
        {
          accountCode: LEDGER_ACCOUNT_CODES.LIAB_WEAVER_PAYABLE,
          subAccountId: item.weaverId,
          debitFen: amt,
          creditFen: ZERO_FEN,
        },
        {
          accountCode: LEDGER_ACCOUNT_CODES.ASSET_BANK_CASH,
          debitFen: ZERO_FEN,
          creditFen: amt,
        },
      ],
      memo: `14天批量结款批次 ${batchId} 委托加工费汇出`,
      createdAt: nowUtcMs,
    });
    if (postRes.posted) paidPayees++;

    for (const pkgId of item.packageIds) {
      const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, pkgId);
      if (pkg && (pkg.status === "settled_ready" || pkg.status === "lost_compensated")) {
        const tr = await transitionStatus(
          db,
          COLLECTIONS.ORDER_PACKAGES,
          pkg._id,
          ORDER_PACKAGE_STATUS_SPEC,
          pkg.status,
          "settled",
          pkg.version,
          () => ({ settledBatchId: batchId }),
          nowUtcMs,
        );
        if (tr.moved) settledPackages++;
      }
    }
  }

  await db.put<SettlementBatchDoc>(COLLECTIONS.SETTLEMENT_BATCHES, {
    ...batch,
    status: "paid",
    paidAt: nowUtcMs,
  });

  return { paidPayees, settledPackages };
}
