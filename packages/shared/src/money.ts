import { AppError, ERROR_CODES } from "./errors.ts";

/**
 * Branded integer Fen (1 Yuan = 100 Fen).
 * Floating-point arithmetic is strictly forbidden across the codebase.
 */
declare const FEN_BRAND: unique symbol;
export type Fen = number & { readonly [FEN_BRAND]: true };

export function asFen(n: number): Fen {
  if (!Number.isSafeInteger(n)) {
    throw new AppError(ERROR_CODES.INVALID_AMOUNT, `Amount must be a safe integer in Fen, got: ${n}`);
  }
  return n as Fen;
}

export function asNonNegativeFen(n: number): Fen {
  const v = asFen(n);
  if (v < 0) {
    throw new AppError(ERROR_CODES.INVALID_AMOUNT, `Amount must be non-negative Fen, got: ${n}`);
  }
  return v;
}

export function asPositiveFen(n: number): Fen {
  const v = asFen(n);
  if (v <= 0) {
    throw new AppError(ERROR_CODES.INVALID_AMOUNT, `Amount must be positive Fen, got: ${n}`);
  }
  return v;
}

export const ZERO_FEN = 0 as Fen;
export const WEAVER_DEPOSIT_FEN = 20000 as Fen; // 200 元合作履约保证金

export function addFen(a: Fen, b: Fen): Fen {
  return asFen((a as number) + (b as number));
}

export function subFen(a: Fen, b: Fen): Fen {
  return asFen((a as number) - (b as number));
}

export function sumFen(values: readonly Fen[]): Fen {
  let acc = 0;
  for (const v of values) acc += asFen(v);
  return asFen(acc);
}

export function formatYuan(fen: Fen): string {
  const sign = fen < 0 ? "-" : "";
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}¥${yuan}.${cents}`;
}

export interface YarnBomEntry {
  yarnCode: string;
  netWeightG: number;
  slotKey?: string; // optional customizable color-slot key, e.g. "HAT_MAIN"
}

export interface YarnPriceSpec {
  unitWeightG: number;
  unitCostFen: Fen;
}

export interface BomCalculationResult {
  items: Array<{ yarnCode: string; netWeightG: number; consumedG: number; costFen: Fen }>;
  yarnCostFen: Fen;
  extraAccessoryCostFen: Fen;
  totalMaterialCostFen: Fen;
}

/**
 * Computes per-unit yarn consumption (ceil with waste buffer) and material cost in Fen (ceil),
 * ensuring yarn pool accrual never runs a deficit. Mirrors docs/07 §3.2 styles.
 */
export function calculateBomMaterialCost(
  yarnBom: readonly YarnBomEntry[],
  catalog: Readonly<Record<string, YarnPriceSpec>>,
  wasteRateBp: number = 1000, // 10% default waste buffer
  extraAccessoryCostFen: Fen = ZERO_FEN,
): BomCalculationResult {
  if (!Number.isInteger(wasteRateBp) || wasteRateBp < 0 || wasteRateBp > 10000) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid wasteRateBp: ${wasteRateBp}`);
  }
  asNonNegativeFen(extraAccessoryCostFen);

  const items: BomCalculationResult["items"] = [];
  let yarnCost = 0;

  for (const entry of yarnBom) {
    const spec = catalog[entry.yarnCode];
    if (!spec) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Yarn spec not found in catalog: ${entry.yarnCode}`);
    }
    if (!Number.isInteger(entry.netWeightG) || entry.netWeightG <= 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid netWeightG for ${entry.yarnCode}: ${entry.netWeightG}`);
    }
    if (!Number.isInteger(spec.unitWeightG) || spec.unitWeightG <= 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid unitWeightG for ${entry.yarnCode}: ${spec.unitWeightG}`);
    }

    const consumedG = Math.ceil((entry.netWeightG * (10000 + wasteRateBp)) / 10000);
    const costFen = asNonNegativeFen(Math.ceil((consumedG * spec.unitCostFen) / spec.unitWeightG));
    yarnCost += costFen;
    items.push({ yarnCode: entry.yarnCode, netWeightG: entry.netWeightG, consumedG, costFen });
  }

  const yarnCostFen = asNonNegativeFen(yarnCost);
  return {
    items,
    yarnCostFen,
    extraAccessoryCostFen,
    totalMaterialCostFen: addFen(yarnCostFen, extraAccessoryCostFen),
  };
}

export function computeStyleMaterialCostFen(
  yarnBom: readonly YarnBomEntry[],
  catalog: Readonly<Record<string, YarnPriceSpec>>,
  wasteRateBp: number = 1000,
  extraAccessoryCostFen: Fen = ZERO_FEN,
): Fen {
  return calculateBomMaterialCost(yarnBom, catalog, wasteRateBp, extraAccessoryCostFen).totalMaterialCostFen;
}
