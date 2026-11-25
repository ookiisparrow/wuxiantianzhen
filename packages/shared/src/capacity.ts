import { DAY_MS, formatCstYmd } from "./cst.ts";
import type { YarnInventorySlot } from "./schemas.ts";

/**
 * Dual-bucket weaver capacity & safe sellable inventory algorithm.
 * Mirrors docs/07 §4.3 (CAPACITY_SPEC): min(time bucket, yarn inventory bucket).
 */

export interface CapacityWeaverInput {
  userId: string;
  acceptingOrders: boolean;
  pauseUntil?: number;
  isStalledHead?: boolean;
  restDays: readonly string[];
  dailyCapacityMin: number;
  speedFactor: number; // clamped to [0.6, 1.3]
  backlogMin: number; // sum of totalMin for offered + making + photo_review
  yarnInventory: Readonly<Record<string, YarnInventorySlot>>;
  certifiedStyleCodes?: readonly string[]; // used when style.requiresEnrollment=true
}

export interface CapacityStyleInput {
  skuCode: string;
  standardMin: number;
  requiresEnrollment?: boolean;
  yarnBomConsumed: ReadonlyArray<{ yarnCode: string; consumedG: number; unitWeightG: number }>;
}

export interface CapacityOptions {
  nowUtcMs: number;
  horizonDays: number; // e.g., 3 for mp_wechat (3-5 day ETA), custom for douyin_online
  safetyRatio?: number; // default 0.70
  responseRate?: number; // default 0.85 for static live stock recommendations
}

export function clampSpeedFactor(v: number): number {
  if (!Number.isFinite(v)) return 1.0;
  return Math.min(1.3, Math.max(0.6, v));
}

export function countRestDaysInHorizon(
  restDays: readonly string[],
  nowUtcMs: number,
  horizonDays: number,
): number {
  if (horizonDays <= 0 || restDays.length === 0) return 0;
  const set = new Set(restDays);
  let count = 0;
  for (let d = 0; d < horizonDays; d++) {
    const ymd = formatCstYmd(nowUtcMs + d * DAY_MS);
    if (set.has(ymd)) count++;
  }
  return count;
}

export function computeWeaverFreeMin(w: CapacityWeaverInput, opts: CapacityOptions): number {
  if (!w.acceptingOrders) return 0;
  if (w.pauseUntil && w.pauseUntil > opts.nowUtcMs) return 0;
  if (w.isStalledHead) return 0;
  if (w.dailyCapacityMin <= 0 || opts.horizonDays <= 0) return 0;

  const restCount = countRestDaysInHorizon(w.restDays, opts.nowUtcMs, opts.horizonDays);
  const activeDays = Math.max(0, opts.horizonDays - restCount);
  if (activeDays === 0) return 0;

  const safety = opts.safetyRatio ?? 0.7;
  const speed = clampSpeedFactor(w.speedFactor);
  const grossBudgetMin = Math.floor(activeDays * w.dailyCapacityMin * speed * safety);
  return Math.max(0, grossBudgetMin - Math.max(0, w.backlogMin));
}

export function estimateAvailableGrams(slot: YarnInventorySlot | undefined, unitWeightG: number): number {
  if (!slot || slot.status === "empty") return 0;
  if (unitWeightG <= 0) return 0;
  const totalG = Math.max(0, slot.wholeSkeins) * unitWeightG;
  return Math.max(0, totalG - Math.max(0, slot.usedSinceCheckG));
}

function aggregateBomByYarn(
  bomList: CapacityStyleInput["yarnBomConsumed"],
): Array<{ yarnCode: string; consumedG: number; unitWeightG: number }> {
  const byYarn = new Map<string, { consumedG: number; unitWeightG: number }>();
  for (const bom of bomList) {
    if (bom.consumedG <= 0) continue;
    const prev = byYarn.get(bom.yarnCode);
    byYarn.set(bom.yarnCode, {
      consumedG: (prev?.consumedG ?? 0) + bom.consumedG,
      unitWeightG: prev?.unitWeightG ?? bom.unitWeightG,
    });
  }
  return [...byYarn.entries()].map(([yarnCode, v]) => ({ yarnCode, ...v }));
}

export function computeWeaverStyleUnits(
  w: CapacityWeaverInput,
  style: CapacityStyleInput,
  freeMinOverride?: number,
  opts?: CapacityOptions,
  availableGramsOverride?: ReadonlyMap<string, number>,
): { timeUnits: number; yarnUnits: number; units: number } {
  if (style.standardMin <= 0) return { timeUnits: 0, yarnUnits: 0, units: 0 };
  if (style.requiresEnrollment && (!w.certifiedStyleCodes || !w.certifiedStyleCodes.includes(style.skuCode))) {
    return { timeUnits: 0, yarnUnits: 0, units: 0 };
  }

  const freeMin = freeMinOverride ?? (opts ? computeWeaverFreeMin(w, opts) : 0);
  const timeUnits = Math.floor(freeMin / style.standardMin);
  if (timeUnits <= 0) return { timeUnits: 0, yarnUnits: 0, units: 0 };

  const aggregatedBom = aggregateBomByYarn(style.yarnBomConsumed);
  let yarnUnits = Number.POSITIVE_INFINITY;
  for (const bom of aggregatedBom) {
    const availG =
      availableGramsOverride?.get(bom.yarnCode) ??
      estimateAvailableGrams(w.yarnInventory[bom.yarnCode], bom.unitWeightG);
    const possible = Math.floor(availG / bom.consumedG);
    if (possible < yarnUnits) yarnUnits = possible;
  }
  if (!Number.isFinite(yarnUnits)) yarnUnits = timeUnits;

  const units = Math.min(timeUnits, yarnUnits);
  return { timeUnits, yarnUnits, units };
}

/**
 * Computes safe sellable quantities for one or multiple styles sharing the same weaver pool
 * (e.g., Douyin live broadcast with split ratios like 70% Style A + 30% Style B),
 * guaranteeing neither a weaver's free minutes NOR her shared yarn inventory is double-sold across styles.
 */
export function computeSafeLiveStockPlan(
  weavers: readonly CapacityWeaverInput[],
  allocations: ReadonlyArray<{
    style: CapacityStyleInput;
    shareWeight: number; // e.g. 70 for 70%, 30 for 30%
    availableReadyStock: number;
  }>,
  opts: CapacityOptions,
): Record<string, { readyStock: number; craftCapacity: number; totalSafeQty: number }> {
  const totalWeight = allocations.reduce((acc, a) => acc + Math.max(0, a.shareWeight), 0);
  const responseRate = opts.responseRate ?? 0.85;
  const result: Record<string, { readyStock: number; craftCapacity: number; totalSafeQty: number }> = {};

  const rawUnitsBySku: Record<string, number> = {};
  for (const alloc of allocations) rawUnitsBySku[alloc.style.skuCode] = 0;

  if (totalWeight > 0) {
    for (const w of weavers) {
      const totalFree = computeWeaverFreeMin(w, opts);
      if (totalFree <= 0) continue;

      // Track remaining grams per yarn color across styles for this weaver so shared colors aren't double-sold
      const remGrams = new Map<string, number>();
      for (const alloc of allocations) {
        for (const bom of alloc.style.yarnBomConsumed) {
          if (!remGrams.has(bom.yarnCode)) {
            remGrams.set(bom.yarnCode, estimateAvailableGrams(w.yarnInventory[bom.yarnCode], bom.unitWeightG));
          }
        }
      }

      for (const alloc of allocations) {
        const sliceMin = Math.floor((totalFree * Math.max(0, alloc.shareWeight)) / totalWeight);
        const { units } = computeWeaverStyleUnits(w, alloc.style, sliceMin, undefined, remGrams);
        if (units > 0) {
          for (const bom of aggregateBomByYarn(alloc.style.yarnBomConsumed)) {
            const curG = remGrams.get(bom.yarnCode) ?? 0;
            remGrams.set(bom.yarnCode, Math.max(0, curG - units * bom.consumedG));
          }
          rawUnitsBySku[alloc.style.skuCode] = (rawUnitsBySku[alloc.style.skuCode] ?? 0) + units;
        }
      }
    }
  }

  for (const alloc of allocations) {
    const sku = alloc.style.skuCode;
    const readyStock = Math.max(0, Math.floor(alloc.availableReadyStock));
    const craftCapacity = Math.floor((rawUnitsBySku[sku] ?? 0) * responseRate);
    result[sku] = {
      readyStock,
      craftCapacity,
      totalSafeQty: readyStock + craftCapacity,
    };
  }
  return result;
}
