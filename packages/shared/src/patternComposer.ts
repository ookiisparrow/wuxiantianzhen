import { AppError, ERROR_CODES } from "./errors.ts";
import {
  ZERO_FEN,
  addFen,
  calculateBomMaterialCost,
  type BomCalculationResult,
  type Fen,
  type YarnBomEntry,
  type YarnPriceSpec,
} from "./money.ts";
import type { PatternModuleDoc, PatternStep } from "./schemas.ts";

export interface ModuleSelection {
  module: PatternModuleDoc;
  /**
   * Optional slot-to-yarnCode override for personalized customization
   * (e.g., `{ "HAT_MAIN": "YARN-MINT-03" }` swaps default pink beret to mint).
   */
  colorSlotOverrides?: Readonly<Record<string, string>>;
}

export interface ComposedStyleBlueprint {
  standardMin: number;
  mergedYarnBom: YarnBomEntry[];
  extraAccessoryCostFen: Fen;
  bomCost: BomCalculationResult;
  assembledParts: Array<{ partName: string; moduleId: string; steps: PatternStep[] }>;
}

/**
 * Lego-style pattern & BOM composer:
 * Combines reusable `PatternModuleDoc` blocks (body + outfit + accessory) with optional
 * color overrides into a unified lyric pattern, summed工时 (`standardMin`), and exact `materialCostFen`.
 */
export function composeModularPatternAndBom(
  selections: readonly ModuleSelection[],
  catalog: Readonly<Record<string, YarnPriceSpec>>,
  wasteRateBp: number = 1000,
): ComposedStyleBlueprint {
  if (selections.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "At least one pattern module is required to compose a style");
  }

  let standardMin = 0;
  let extraAccessoryCostFen: Fen = ZERO_FEN;
  const netWeightByYarn = new Map<string, number>();
  const assembledParts: ComposedStyleBlueprint["assembledParts"] = [];

  for (const sel of selections) {
    const mod = sel.module;
    if (mod.standardMin <= 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Module ${mod._id} must have positive standardMin`);
    }
    standardMin += mod.standardMin;
    extraAccessoryCostFen = addFen(extraAccessoryCostFen, mod.extraAccessoryCostFen);

    for (const entry of mod.yarnBom) {
      const resolvedYarnCode =
        (entry.slotKey && sel.colorSlotOverrides?.[entry.slotKey]) || entry.yarnCode;
      netWeightByYarn.set(resolvedYarnCode, (netWeightByYarn.get(resolvedYarnCode) ?? 0) + entry.netWeightG);
    }

    assembledParts.push({
      partName: mod.name,
      moduleId: mod._id,
      steps: mod.steps.map((s) => ({ ...s })),
    });
  }

  const mergedYarnBom: YarnBomEntry[] = Array.from(netWeightByYarn.entries()).map(([yarnCode, netWeightG]) => ({
    yarnCode,
    netWeightG,
  }));

  const bomCost = calculateBomMaterialCost(mergedYarnBom, catalog, wasteRateBp, extraAccessoryCostFen);

  return {
    standardMin,
    mergedYarnBom,
    extraAccessoryCostFen,
    bomCost,
    assembledParts,
  };
}
