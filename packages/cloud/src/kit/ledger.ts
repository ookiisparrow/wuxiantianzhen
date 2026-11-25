import {
  COLLECTIONS,
  AppError,
  ERROR_CODES,
  WEAVER_DEPOSIT_FEN,
  ZERO_FEN,
  addFen,
  asFen,
  asNonNegativeFen,
  asPositiveFen,
  subFen,
  LEDGER_ACCOUNT_CODES,
  type Fen,
  type LedgerEntryDoc,
  type LedgerLine,
  type WeaverAccountDoc,
} from "@wxtz/shared";
import type { DbAdapter } from "./db.ts";
import {
  ledgerKeyAccrue,
  ledgerKeyDepositIn,
  ledgerKeyDepositOut,
  ledgerKeyYarnOut,
  weaverAccountId,
} from "./ids.ts";

/**
 * Validates double-entry balance invariant:
 * lines.length >= 2, every amount non-negative integer Fen, sum(debit) === sum(credit) > 0.
 */
export function assertBalancedLines(lines: readonly LedgerLine[]): Fen {
  if (lines.length < 2) {
    throw new AppError(ERROR_CODES.LEDGER_UNBALANCED, "Double-entry ledger requires at least 2 lines");
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const d = asNonNegativeFen(line.debitFen);
    const c = asNonNegativeFen(line.creditFen);
    if (d > 0 && c > 0) {
      throw new AppError(
        ERROR_CODES.LEDGER_UNBALANCED,
        `Ledger line for ${line.accountCode} cannot have both debit and credit > 0`,
      );
    }
    if (d === 0 && c === 0) {
      throw new AppError(
        ERROR_CODES.LEDGER_UNBALANCED,
        `Ledger line for ${line.accountCode} has both debit and credit === 0`,
      );
    }
    totalDebit += d;
    totalCredit += c;
  }
  if (totalDebit !== totalCredit || totalDebit <= 0) {
    throw new AppError(
      ERROR_CODES.LEDGER_UNBALANCED,
      `Ledger unbalanced: debit=${totalDebit} Fen, credit=${totalCredit} Fen`,
      { totalDebit, totalCredit },
    );
  }
  return asPositiveFen(totalDebit);
}

export async function ensureWeaverAccount(
  db: DbAdapter,
  userId: string,
  nowUtcMs: number = Date.now(),
): Promise<WeaverAccountDoc> {
  const id = weaverAccountId(userId);
  const existing = await db.get<WeaverAccountDoc>(COLLECTIONS.WEAVER_ACCOUNTS, id);
  if (existing) return existing;

  const fresh: WeaverAccountDoc = {
    _id: id,
    userId,
    yarnPoolBalanceFen: ZERO_FEN,
    payableBalanceFen: ZERO_FEN,
    depositFen: ZERO_FEN,
    version: 1,
    updatedAt: nowUtcMs,
  };
  await db.insert(COLLECTIONS.WEAVER_ACCOUNTS, fresh);
  return (await db.get<WeaverAccountDoc>(COLLECTIONS.WEAVER_ACCOUNTS, id))!;
}

async function applyWeaverAccountDeltas(
  db: DbAdapter,
  lines: readonly LedgerLine[],
  nowUtcMs: number,
): Promise<Array<{ userId: string; d: { yarn: number; payable: number; deposit: number } }>> {
  // Liability accounts increase on credit and decrease on debit.
  const deltas = new Map<string, { yarn: number; payable: number; deposit: number }>();

  for (const line of lines) {
    if (!line.subAccountId) continue;
    const netCredit = (line.creditFen as number) - (line.debitFen as number);
    let rec = deltas.get(line.subAccountId);
    if (!rec) {
      rec = { yarn: 0, payable: 0, deposit: 0 };
      deltas.set(line.subAccountId, rec);
    }
    if (line.accountCode === LEDGER_ACCOUNT_CODES.LIAB_YARN_POOL) rec.yarn += netCredit;
    else if (line.accountCode === LEDGER_ACCOUNT_CODES.LIAB_WEAVER_PAYABLE) rec.payable += netCredit;
    else if (line.accountCode === LEDGER_ACCOUNT_CODES.LIAB_WEAVER_DEPOSIT) rec.deposit += netCredit;
  }

  const applied: Array<{ userId: string; d: { yarn: number; payable: number; deposit: number } }> = [];
  try {
    for (const [userId, d] of deltas.entries()) {
      if (d.yarn === 0 && d.payable === 0 && d.deposit === 0) continue;
      await ensureWeaverAccount(db, userId, nowUtcMs);
      const id = weaverAccountId(userId);
      const res = await db.atomicUpdate<WeaverAccountDoc>(
        COLLECTIONS.WEAVER_ACCOUNTS,
        id,
        (cur) =>
          (cur.yarnPoolBalanceFen as number) + d.yarn >= 0 &&
          (cur.payableBalanceFen as number) + d.payable >= 0 &&
          (cur.depositFen as number) + d.deposit >= 0,
        (cur) => ({
          ...cur,
          yarnPoolBalanceFen: asNonNegativeFen((cur.yarnPoolBalanceFen as number) + d.yarn),
          payableBalanceFen: asNonNegativeFen((cur.payableBalanceFen as number) + d.payable),
          depositFen: asNonNegativeFen((cur.depositFen as number) + d.deposit),
          version: cur.version + 1,
          updatedAt: nowUtcMs,
        }),
      );
      if (!res.updated) {
        throw new AppError(
          ERROR_CODES.INSUFFICIENT_YARN_POOL,
          `Weaver account ${userId} rejected negative balance delta`,
          { userId, deltas: d },
        );
      }
      applied.push({ userId, d });
    }
    return applied;
  } catch (err) {
    // Roll back any already-applied subaccount deltas on multi-user entry failure
    for (const item of applied) {
      await db.atomicUpdate<WeaverAccountDoc>(
        COLLECTIONS.WEAVER_ACCOUNTS,
        weaverAccountId(item.userId),
        () => true,
        (cur) => ({
          ...cur,
          yarnPoolBalanceFen: asNonNegativeFen((cur.yarnPoolBalanceFen as number) - item.d.yarn),
          payableBalanceFen: asNonNegativeFen((cur.payableBalanceFen as number) - item.d.payable),
          depositFen: asNonNegativeFen((cur.depositFen as number) - item.d.deposit),
          version: cur.version + 1,
          updatedAt: nowUtcMs,
        }),
      );
    }
    throw err;
  }
}

/**
 * Posts an immutable double-entry ledger record. Idempotent via deterministic `_id`.
 * Overdraft gate runs BEFORE inserting `ledgerEntries` so rejected debits never orphan ledger rows.
 */
export async function postLedgerEntry(
  db: DbAdapter,
  entry: LedgerEntryDoc,
  skipAccountDelta: boolean = false,
): Promise<{ posted: boolean; alreadyExists: boolean }> {
  assertBalancedLines(entry.lines);

  const existing = await db.get<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, entry._id);
  if (existing) {
    return { posted: false, alreadyExists: true };
  }

  const applied = skipAccountDelta ? [] : await applyWeaverAccountDeltas(db, entry.lines, entry.createdAt);
  const ins = await db.insert<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, entry);
  if (!ins.inserted) {
    for (const item of applied) {
      await db.atomicUpdate<WeaverAccountDoc>(
        COLLECTIONS.WEAVER_ACCOUNTS,
        weaverAccountId(item.userId),
        () => true,
        (cur) => ({
          ...cur,
          yarnPoolBalanceFen: asNonNegativeFen((cur.yarnPoolBalanceFen as number) - item.d.yarn),
          payableBalanceFen: asNonNegativeFen((cur.payableBalanceFen as number) - item.d.payable),
          depositFen: asNonNegativeFen((cur.depositFen as number) - item.d.deposit),
          version: cur.version + 1,
          updatedAt: entry.createdAt,
        }),
      );
    }
    return { posted: false, alreadyExists: true };
  }
  return { posted: true, alreadyExists: false };
}

/**
 * Accrues weaver earnings upon 7-day post-signoff settlement eligibility (docs/07 §6 #2).
 * Pure craft labor (`EXP_CRAFT_COST`), shipping subsidy (`EXP_SHIPPING_PLATFORM`), and BOM material cost
 * (`EXP_MATERIAL_COST`) are strictly separated on distinct expense accounts.
 */
export async function accrueSettledPackage(
  db: DbAdapter,
  params: {
    packageId: string;
    weaverId: string;
    craftFeeFen: Fen;
    weaverShipShareFen: Fen;
    yarnPoolAccrualFen: Fen;
    selfShipReimbFen?: Fen;
    nowUtcMs?: number;
  },
): Promise<{ posted: boolean; alreadyExists: boolean }> {
  const now = params.nowUtcMs ?? Date.now();
  const craftFee = asPositiveFen(params.craftFeeFen);
  const shipShare = asNonNegativeFen(params.weaverShipShareFen);
  const yarnAccrual = asNonNegativeFen(params.yarnPoolAccrualFen);
  const selfShipReimb = asNonNegativeFen(params.selfShipReimbFen ?? ZERO_FEN);
  if (shipShare > craftFee) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "weaverShipShareFen cannot exceed craftFeeFen");
  }
  const netPayable = addFen(subFen(craftFee, shipShare), selfShipReimb);

  const lines: LedgerLine[] = [
    { accountCode: LEDGER_ACCOUNT_CODES.EXP_CRAFT_COST, debitFen: craftFee, creditFen: ZERO_FEN },
  ];
  if (selfShipReimb > 0) {
    lines.push({
      accountCode: LEDGER_ACCOUNT_CODES.EXP_SHIPPING_PLATFORM,
      debitFen: selfShipReimb,
      creditFen: ZERO_FEN,
    });
  }
  if (netPayable > 0) {
    lines.push({
      accountCode: LEDGER_ACCOUNT_CODES.LIAB_WEAVER_PAYABLE,
      subAccountId: params.weaverId,
      debitFen: ZERO_FEN,
      creditFen: netPayable,
    });
  }
  if (shipShare > 0) {
    lines.push({
      accountCode: LEDGER_ACCOUNT_CODES.EXP_SHIPPING_PLATFORM,
      debitFen: ZERO_FEN,
      creditFen: shipShare,
    });
  }
  if (yarnAccrual > 0) {
    lines.push(
      { accountCode: LEDGER_ACCOUNT_CODES.EXP_MATERIAL_COST, debitFen: yarnAccrual, creditFen: ZERO_FEN },
      {
        accountCode: LEDGER_ACCOUNT_CODES.LIAB_YARN_POOL,
        subAccountId: params.weaverId,
        debitFen: ZERO_FEN,
        creditFen: yarnAccrual,
      },
    );
  }

  return postLedgerEntry(db, {
    _id: ledgerKeyAccrue(params.packageId),
    eventType: "pkg_accrue",
    bizId: params.packageId,
    payeeId: params.weaverId,
    lines,
    memo: `订单包 ${params.packageId} 满7天计提纯工价与独立线材池额度`,
    createdAt: now,
  });
}

/**
 * Atomic overdraft-proof yarn pool deduction gated by `weaverAccounts` CAS lock (docs/07 §6 #3).
 */
export async function debitYarnPoolAtomic(
  db: DbAdapter,
  params: {
    claimId: string;
    weaverId: string;
    totalQty: number;
    hasMaterialPack: boolean;
    materialsCostFen: Fen;
    shippingFeeFen: Fen;
    attemptNo?: number;
    minQty?: number;
    nowUtcMs?: number;
  },
): Promise<{ posted: boolean; alreadyExists: boolean }> {
  const minQty = params.minQty ?? 3;
  if (!params.hasMaterialPack && params.totalQty < minQty) {
    throw new AppError(
      ERROR_CODES.YARN_CLAIM_MIN_QTY,
      `Yarn claim requires at least ${minQty} skeins or a material pack (got ${params.totalQty})`,
    );
  }

  const now = params.nowUtcMs ?? Date.now();
  const totalCost = addFen(asPositiveFen(params.materialsCostFen), asNonNegativeFen(params.shippingFeeFen));
  const baseKey = ledgerKeyYarnOut(params.claimId);
  const entryId = params.attemptNo && params.attemptNo > 1 ? `${baseKey}:v${params.attemptNo}` : baseKey;

  // Idempotency short-circuit before touching balance lock
  const existingEntry = await db.get<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, entryId);
  if (existingEntry) {
    return { posted: false, alreadyExists: true };
  }

  // Step 1: Atomic balance lock on weaverAccounts (zero overdraft under concurrency)
  await ensureWeaverAccount(db, params.weaverId, now);
  const accRes = await db.atomicUpdate<WeaverAccountDoc>(
    COLLECTIONS.WEAVER_ACCOUNTS,
    weaverAccountId(params.weaverId),
    (cur) => cur.yarnPoolBalanceFen >= totalCost,
    (cur) => ({
      ...cur,
      yarnPoolBalanceFen: subFen(cur.yarnPoolBalanceFen, totalCost),
      version: cur.version + 1,
      updatedAt: now,
    }),
  );
  if (!accRes.updated) {
    throw new AppError(
      ERROR_CODES.INSUFFICIENT_YARN_POOL,
      `Insufficient yarn pool balance for weaver ${params.weaverId} (need ${totalCost} Fen)`,
      { weaverId: params.weaverId, needFen: totalCost, availableFen: accRes.doc?.yarnPoolBalanceFen ?? 0 },
    );
  }

  // Step 2: Record immutable ledger entry (skipAccountDelta=true since Step 1 already debited atomically)
  const postRes = await postLedgerEntry(
    db,
    {
      _id: entryId,
      eventType: "yarn_out",
      bizId: params.claimId,
      payeeId: params.weaverId,
      lines: [
        {
          accountCode: LEDGER_ACCOUNT_CODES.LIAB_YARN_POOL,
          subAccountId: params.weaverId,
          debitFen: totalCost,
          creditFen: ZERO_FEN,
        },
        {
          accountCode: LEDGER_ACCOUNT_CODES.LIAB_SUPPLIER_PAYABLE,
          debitFen: ZERO_FEN,
          creditFen: totalCost,
        },
      ],
      memo: `线材申领 ${params.claimId} 扣减个人线材池（含运费）`,
      createdAt: now,
    },
    true,
  );
  return postRes;
}

/**
 * Records 200-Yuan cooperative performance deposit as strict liability (never revenue).
 */
export async function recordWeaverDeposit(
  db: DbAdapter,
  userId: string,
  cashAccount: typeof LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH | typeof LEDGER_ACCOUNT_CODES.ASSET_BANK_CASH = LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH,
  nowUtcMs: number = Date.now(),
): Promise<{ posted: boolean; alreadyExists: boolean }> {
  return postLedgerEntry(db, {
    _id: ledgerKeyDepositIn(userId),
    eventType: "deposit_in",
    bizId: userId,
    payeeId: userId,
    lines: [
      { accountCode: cashAccount, debitFen: WEAVER_DEPOSIT_FEN, creditFen: ZERO_FEN },
      {
        accountCode: LEDGER_ACCOUNT_CODES.LIAB_WEAVER_DEPOSIT,
        subAccountId: userId,
        debitFen: ZERO_FEN,
        creditFen: WEAVER_DEPOSIT_FEN,
      },
    ],
    memo: `织女 ${userId} 缴付 200 元合作履约保证金（专账负债）`,
    createdAt: nowUtcMs,
  });
}

export async function refundWeaverDeposit(
  db: DbAdapter,
  userId: string,
  cashAccount: typeof LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH | typeof LEDGER_ACCOUNT_CODES.ASSET_BANK_CASH = LEDGER_ACCOUNT_CODES.ASSET_WXPAY_CASH,
  nowUtcMs: number = Date.now(),
): Promise<{ posted: boolean; alreadyExists: boolean }> {
  return postLedgerEntry(db, {
    _id: ledgerKeyDepositOut(userId),
    eventType: "deposit_out",
    bizId: userId,
    payeeId: userId,
    lines: [
      {
        accountCode: LEDGER_ACCOUNT_CODES.LIAB_WEAVER_DEPOSIT,
        subAccountId: userId,
        debitFen: WEAVER_DEPOSIT_FEN,
        creditFen: ZERO_FEN,
      },
      { accountCode: cashAccount, debitFen: ZERO_FEN, creditFen: WEAVER_DEPOSIT_FEN },
    ],
    memo: `织女 ${userId} 无违约退出原路全额退还 200 元合作履约保证金`,
    createdAt: nowUtcMs,
  });
}

/**
 * Full daily reconciliation check: verifies `weaverAccounts` matches exact sum of `ledgerEntries`.
 */
export async function reconcileWeaverAccount(
  db: DbAdapter,
  userId: string,
): Promise<{
  ok: boolean;
  snapshot: { yarnPoolBalanceFen: Fen; payableBalanceFen: Fen; depositFen: Fen };
  computed: { yarnPoolBalanceFen: Fen; payableBalanceFen: Fen; depositFen: Fen };
}> {
  const acc = await db.get<WeaverAccountDoc>(COLLECTIONS.WEAVER_ACCOUNTS, weaverAccountId(userId));
  const entries = await db.find<LedgerEntryDoc>(COLLECTIONS.LEDGER_ENTRIES, (e) =>
    e.lines.some((l) => l.subAccountId === userId),
  );

  let yarn = 0;
  let payable = 0;
  let deposit = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.subAccountId !== userId) continue;
      const netCredit = (l.creditFen as number) - (l.debitFen as number);
      if (l.accountCode === LEDGER_ACCOUNT_CODES.LIAB_YARN_POOL) yarn += netCredit;
      else if (l.accountCode === LEDGER_ACCOUNT_CODES.LIAB_WEAVER_PAYABLE) payable += netCredit;
      else if (l.accountCode === LEDGER_ACCOUNT_CODES.LIAB_WEAVER_DEPOSIT) deposit += netCredit;
    }
  }

  const computed = {
    yarnPoolBalanceFen: asFen(yarn),
    payableBalanceFen: asFen(payable),
    depositFen: asFen(deposit),
  };
  const snapshot = {
    yarnPoolBalanceFen: acc?.yarnPoolBalanceFen ?? ZERO_FEN,
    payableBalanceFen: acc?.payableBalanceFen ?? ZERO_FEN,
    depositFen: acc?.depositFen ?? ZERO_FEN,
  };

  const ok =
    snapshot.yarnPoolBalanceFen === computed.yarnPoolBalanceFen &&
    snapshot.payableBalanceFen === computed.payableBalanceFen &&
    snapshot.depositFen === computed.depositFen;

  return { ok, snapshot, computed };
}
