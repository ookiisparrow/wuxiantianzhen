import {
  AppError,
  BAG_STICKER_STATUS_SPEC,
  COLLECTIONS,
  ERROR_CODES,
  HOUR_MS,
  ORDER_PACKAGE_STATUS_SPEC,
  ZERO_FEN,
  asNonNegativeFen,
  asPositiveFen,
  composeModularPatternAndBom,
  computeStyleMaterialCostFen,
  type BagStickerDoc,
  type DispatchOfferDoc,
  type Fen,
  type OrderPackageDoc,
  type PatternDoc,
  type PatternModuleDoc,
  type ProductDoc,
  type StyleDoc,
  type SystemConfigDoc,
  type UserDoc,
  type YarnBomEntry,
  type YarnCatalogDoc,
  type YarnPriceSpec,
} from "@wxtz/shared";
import { assertNotSelfOrder } from "../kit/auth.ts";
import type { DbAdapter } from "../kit/db.ts";
import { bagStickerId, dispatchOfferId, newPatternId, newProductId } from "../kit/ids.ts";
import { releaseStockReservationForOrderOrPackage } from "../kit/stockLock.ts";
import { transitionStatus } from "../kit/transition.ts";

export async function upsertYarnCatalogItem(db: DbAdapter, item: YarnCatalogDoc): Promise<YarnCatalogDoc> {
  const id = String(item._id ?? "").trim();
  const name = String(item.name ?? "").trim();
  const supplierSkuCode = String(item.supplierSkuCode ?? "").trim();
  if (!id || !name || !supplierSkuCode) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "线材目录编码、名称与主供应商标准编码不能为空");
  }
  if (!Number.isInteger(item.unitWeightG) || item.unitWeightG < 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法的标准克重 unitWeightG：${item.unitWeightG}`);
  }
  if (item.itemType === "yarn" && item.unitWeightG <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "毛线单团克重须为正整数克");
  }
  const unitCostFen = asNonNegativeFen(Number(item.unitCostFen));

  const doc: YarnCatalogDoc = {
    ...item,
    _id: id,
    name,
    brand: String(item.brand ?? "").trim(),
    supplierId: String(item.supplierId ?? "SUP_JZH_MAIN").trim(),
    supplierSkuCode,
    unitWeightG: item.unitWeightG,
    unitCostFen,
    isBase12: Boolean(item.isBase12),
    isMaterialPack: Boolean(item.isMaterialPack || item.itemType === "material_pack"),
    status: item.status ?? "active",
  };
  await db.put(COLLECTIONS.YARN_CATALOG, doc);
  return doc;
}

export async function upsertPatternModule(
  db: DbAdapter,
  mod: Omit<PatternModuleDoc, "updatedAt" | "extraAccessoryCostFen"> & { extraAccessoryCostFen?: number | Fen },
  nowUtcMs: number = Date.now(),
): Promise<PatternModuleDoc> {
  const id = String(mod._id ?? "").trim();
  const name = String(mod.name ?? "").trim();
  if (!id || !name) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "图解部件编码与名称不能为空");
  }
  if (!Array.isArray(mod.steps) || mod.steps.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "图解部件至少包含 1 步针法说明");
  }
  if (!Number.isInteger(mod.standardMin) || mod.standardMin <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "图解部件标准工时须为正整数分钟");
  }

  const doc: PatternModuleDoc = {
    _id: id,
    name,
    category: mod.category,
    standardMin: mod.standardMin,
    yarnBom: mod.yarnBom ?? [],
    extraAccessoryCostFen: asNonNegativeFen(Number(mod.extraAccessoryCostFen ?? ZERO_FEN)),
    steps: mod.steps.map((s) => ({ ...s })),
    authorUserId: String(mod.authorUserId ?? "usr_admin"),
    status: mod.status ?? "approved",
    updatedAt: nowUtcMs,
  };
  await db.put(COLLECTIONS.PATTERN_MODULES, doc);
  return doc;
}

export async function upsertPattern(
  db: DbAdapter,
  pat: Omit<PatternDoc, "_id" | "updatedAt" | "version" | "parts"> & {
    _id?: string;
    version?: number;
    parts?: PatternDoc["parts"];
    colorSlotOverridesByModule?: Record<string, Record<string, string>>;
  },
  nowUtcMs: number = Date.now(),
): Promise<PatternDoc> {
  const id = pat._id ? String(pat._id).trim() : newPatternId();
  const skuCode = String(pat.skuCode ?? "").trim();
  if (!id || !skuCode) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "图解编码与关联款号(skuCode)不能为空");
  }

  let resolvedParts = pat.parts ?? [];
  if (pat.sourceModuleIds && pat.sourceModuleIds.length > 0 && resolvedParts.length === 0) {
    const selections = [];
    for (const modId of pat.sourceModuleIds) {
      const mod = await db.get<PatternModuleDoc>(COLLECTIONS.PATTERN_MODULES, modId);
      if (!mod) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `未找到图解部件模块：${modId}`);
      }
      selections.push({
        module: mod,
        colorSlotOverrides: pat.colorSlotOverridesByModule?.[modId],
      });
    }
    const yarns = await db.find<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, () => true);
    const catalog: Record<string, YarnPriceSpec> = {};
    for (const y of yarns) {
      if (y.unitWeightG > 0) {
        catalog[y._id] = { unitWeightG: y.unitWeightG, unitCostFen: y.unitCostFen };
      }
    }
    const composed = composeModularPatternAndBom(selections, catalog);
    resolvedParts = composed.assembledParts;
  }

  if (resolvedParts.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "歌词式图解必须包含至少 1 个部位步骤或可拼装模块");
  }

  const doc: PatternDoc = {
    _id: id,
    skuCode,
    version: pat.version ?? 1,
    sourceModuleIds: pat.sourceModuleIds,
    parts: resolvedParts,
    authorUserId: String(pat.authorUserId ?? "usr_admin"),
    copyrightDocId: pat.copyrightDocId,
    status: pat.status ?? "approved",
    updatedAt: nowUtcMs,
  };
  await db.put(COLLECTIONS.PATTERNS, doc);
  return doc;
}

export interface UpsertStyleInput {
  _id?: string;
  skuCode?: string;
  name: string;
  riskClass?: "core" | "trial";
  standardMin: number;
  patternId: string;
  yarnBom: YarnBomEntry[];
  wasteRateBp?: number;
  extraAccessoryCostFen?: number | Fen;
  yarnPoolAccrualFen: number | Fen;
  craftFeeFen: number | Fen;
  weaverShipShareFen?: number | Fen;
  ownerType?: "platform" | "creator";
  creatorUserId?: string;
  tutorialVideoUrl?: string;
  qcOwner?: "volunteer_or_admin" | "creator_led";
  royaltyFen?: number | Fen;
  creatorQcFeeFen?: number | Fen;
  trafficCommissionBp?: number;
  requiresEnrollment?: boolean;
  enrollmentQuota?: number;
  enrollmentMinOrderCount?: number;
  licenseDocId?: string;
  status?: "draft" | "active" | "archived";
}

/**
 * Upserts a `StyleDoc` after computing exact BOM `materialCostFen` from `YARN_CATALOG`
 * and enforcing `yarnPoolAccrualFen >= materialCostFen` (docs/07 §3.2 #5) so the yarn pool never runs a deficit.
 */
export async function upsertStyleWithBom(
  db: DbAdapter,
  input: UpsertStyleInput,
): Promise<StyleDoc> {
  const skuCode = String(input._id ?? input.skuCode ?? "").trim();
  const name = String(input.name ?? "").trim();
  const patternId = String(input.patternId ?? "").trim();
  if (!skuCode || !name || !patternId) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "款号(skuCode)、款名与关联图解(patternId)不能为空");
  }
  if (!Number.isInteger(input.standardMin) || input.standardMin <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "标准工时 standardMin 须为正整数分钟");
  }
  if (!Array.isArray(input.yarnBom) || input.yarnBom.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "款级线材克重 BOM 不能为空");
  }

  const patternDoc = await db.get<PatternDoc>(COLLECTIONS.PATTERNS, patternId);
  if (!patternDoc) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `关联图解不存在：${patternId}`);
  }
  if ((input.status ?? "active") === "active" && patternDoc.status !== "approved") {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `上架款式关联的图解尚未审核通过：${patternId}`);
  }

  const catalogMap: Record<string, YarnPriceSpec> = {};
  for (const entry of input.yarnBom) {
    const yarnDoc = await db.get<YarnCatalogDoc>(COLLECTIONS.YARN_CATALOG, entry.yarnCode);
    if (!yarnDoc) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `BOM 引用的线材编码不存在：${entry.yarnCode}`);
    }
    catalogMap[yarnDoc._id] = {
      unitWeightG: yarnDoc.unitWeightG,
      unitCostFen: yarnDoc.unitCostFen,
    };
  }

  const wasteRateBp = input.wasteRateBp ?? 1000;
  const extraAccessoryCostFen = asNonNegativeFen(Number(input.extraAccessoryCostFen ?? ZERO_FEN));
  const materialCostFen = computeStyleMaterialCostFen(
    input.yarnBom,
    catalogMap,
    wasteRateBp,
    extraAccessoryCostFen,
  );

  const yarnPoolAccrualFen = asNonNegativeFen(Number(input.yarnPoolAccrualFen));
  if (yarnPoolAccrualFen < materialCostFen) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `线材池计提(${yarnPoolAccrualFen}分)不得低于BOM核算材料成本(${materialCostFen}分)，严防线材池亏空`,
      { yarnPoolAccrualFen, materialCostFen },
    );
  }

  const craftFeeFen = asPositiveFen(Number(input.craftFeeFen));
  const weaverShipShareFen = asNonNegativeFen(Number(input.weaverShipShareFen ?? ZERO_FEN));
  if (weaverShipShareFen > craftFeeFen) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "织女分摊邮费不得超过单件纯工价");
  }

  const doc: StyleDoc = {
    _id: skuCode,
    name,
    riskClass: input.riskClass ?? "core",
    standardMin: input.standardMin,
    patternId,
    yarnBom: input.yarnBom.map((b) => ({ ...b })),
    wasteRateBp,
    extraAccessoryCostFen,
    materialCostFen,
    yarnPoolAccrualFen,
    craftFeeFen,
    weaverShipShareFen,
    ownerType: input.ownerType ?? "platform",
    creatorUserId: input.creatorUserId,
    tutorialVideoUrl: input.tutorialVideoUrl,
    qcOwner: input.qcOwner ?? "volunteer_or_admin",
    royaltyFen: asNonNegativeFen(Number(input.royaltyFen ?? ZERO_FEN)),
    creatorQcFeeFen: asNonNegativeFen(Number(input.creatorQcFeeFen ?? ZERO_FEN)),
    trafficCommissionBp: input.trafficCommissionBp ?? 0,
    requiresEnrollment: Boolean(input.requiresEnrollment),
    enrollmentQuota: input.enrollmentQuota,
    enrollmentMinOrderCount: input.enrollmentMinOrderCount,
    licenseDocId: input.licenseDocId,
    status: input.status ?? "active",
  };
  await db.put(COLLECTIONS.STYLES, doc);
  return doc;
}

export interface UpsertProductInput {
  _id?: string;
  skuCode: string;
  saleType: "made_to_order" | "ready_stock";
  title: string;
  coverFileIds?: string[];
  detailFileIds?: string[];
  priceFen: number | Fen;
  buyerShipFeeFen?: number | Fen;
  etaText?: string;
  sortOrder?: number;
  isOnSale?: boolean;
}

export async function upsertProduct(
  db: DbAdapter,
  input: UpsertProductInput,
  nowUtcMs: number = Date.now(),
): Promise<ProductDoc> {
  const skuCode = String(input.skuCode ?? "").trim();
  const title = String(input.title ?? "").trim();
  if (!skuCode || !title) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "商品关联款号与标题不能为空");
  }
  const style = await db.get<StyleDoc>(COLLECTIONS.STYLES, skuCode);
  if (!style) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `未找到关联款式主数据：${skuCode}`);
  }

  const priceFen = asPositiveFen(Number(input.priceFen));
  const buyerShipFeeFen = asNonNegativeFen(Number(input.buyerShipFeeFen ?? ZERO_FEN));
  const id = input._id ? String(input._id).trim() : newProductId();

  const doc: ProductDoc = {
    _id: id,
    skuCode,
    saleType: input.saleType === "ready_stock" ? "ready_stock" : "made_to_order",
    title,
    coverFileIds: input.coverFileIds ?? [],
    detailFileIds: input.detailFileIds ?? [],
    priceFen,
    buyerShipFeeFen,
    etaText:
      input.etaText ??
      (input.saleType === "ready_stock" ? "现货 48 小时内发出" : "下单后 3–5 天内发出"),
    sortOrder: Number.isInteger(input.sortOrder) ? input.sortOrder! : 10,
    isOnSale: input.isOnSale ?? true,
    updatedAt: nowUtcMs,
  };
  await db.put(COLLECTIONS.PRODUCTS, doc);
  return doc;
}

export async function generateBagStickerBatch(
  db: DbAdapter,
  params: { weaverId: string; batchId: string; codes: readonly string[] },
): Promise<{ createdCount: number; skippedCount: number }> {
  const weaver = await db.get<UserDoc>(COLLECTIONS.USERS, params.weaverId);
  if (!weaver) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `织女不存在：${params.weaverId}`);
  }
  const batchId = String(params.batchId ?? "").trim();
  if (!batchId || !Array.isArray(params.codes) || params.codes.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "批次号与袋码列表不能为空");
  }

  let createdCount = 0;
  let skippedCount = 0;
  for (const raw of params.codes) {
    const code = String(raw ?? "").trim();
    if (!code) continue;
    const ins = await db.insert<BagStickerDoc>(COLLECTIONS.BAG_STICKERS, {
      _id: bagStickerId(code),
      code,
      weaverId: params.weaverId,
      batchId,
      status: "unused",
      version: 1,
    });
    if (ins.inserted) createdCount++;
    else skippedCount++;
  }
  return { createdCount, skippedCount };
}

export async function upsertSystemConfig(
  db: DbAdapter,
  key: string,
  value: Record<string, unknown>,
  adminUserId: string,
  nowUtcMs: number = Date.now(),
): Promise<SystemConfigDoc> {
  const cleanKey = String(key ?? "").trim();
  if (!cleanKey || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "配置项 key 与对象 value 不能为空");
  }
  const doc: SystemConfigDoc = {
    ...value,
    _id: cleanKey,
    value,
    updatedBy: adminUserId,
    updatedAt: nowUtcMs,
  };
  await db.put(COLLECTIONS.CONFIG, doc);
  return doc;
}

export async function getSystemConfig(db: DbAdapter, key: string): Promise<SystemConfigDoc | null> {
  const cleanKey = String(key ?? "").trim();
  if (!cleanKey) return null;
  return db.get<SystemConfigDoc>(COLLECTIONS.CONFIG, cleanKey);
}

/**
 * Recovers an `OrderPackageDoc` from `manual_hold`:
 *  - Without `targetWeaverId`: resets `attemptCount = 0` and returns package to `waiting_dispatch` pool;
 *  - With `targetWeaverId`: verifies approved weaver + anti-self-order, creates a fresh `DispatchOfferDoc`,
 *    and transitions `manual_hold -> waiting_dispatch -> offered`.
 */
export async function reassignManualHoldPackage(
  db: DbAdapter,
  params: {
    packageId: string;
    targetWeaverId?: string;
    nowUtcMs?: number;
  },
): Promise<{ package: OrderPackageDoc; offer?: DispatchOfferDoc }> {
  const now = params.nowUtcMs ?? Date.now();
  const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, params.packageId);
  if (!pkg) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `订单包不存在：${params.packageId}`);
  }
  if (pkg.status !== "manual_hold") {
    throw new AppError(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      `仅 manual_hold 状态包裹可执行异常改派（当前：${pkg.status}）`,
    );
  }

  // If a prior bag sticker was bound before courier failure, void it cleanly so re-sealing is unobstructed
  if (pkg.bagQrCode) {
    const oldSticker = await db.get<BagStickerDoc>(COLLECTIONS.BAG_STICKERS, bagStickerId(pkg.bagQrCode));
    if (oldSticker && oldSticker.status === "bound") {
      await transitionStatus(
        db,
        COLLECTIONS.BAG_STICKERS,
        oldSticker._id,
        BAG_STICKER_STATUS_SPEC,
        "bound",
        "void",
        oldSticker.version,
        undefined,
        now,
      );
    }
  }

  // Release any paid/unpaid ready-stock reservation tied to this package before resetting to MTO dispatch
  await releaseStockReservationForOrderOrPackage(db, {
    orderIds: pkg.orderIds,
    packageId: pkg._id,
    nowUtcMs: now,
  });

  if (!params.targetWeaverId) {
    const tr = await transitionStatus(
      db,
      COLLECTIONS.ORDER_PACKAGES,
      pkg._id,
      ORDER_PACKAGE_STATUS_SPEC,
      "manual_hold",
      "waiting_dispatch",
      pkg.version,
      () => ({
        lastManualResetAttempt: pkg.attemptCount,
        assignedWeaverId: undefined,
        queueSeq: undefined,
        bagQrCode: undefined,
        isReadyStockReuse: false,
        dispatchableAt: now,
      }),
      now,
    );
    if (!tr.moved || !tr.doc) {
      throw new AppError(ERROR_CODES.CAS_CONFLICT, "订单包状态并发冲突");
    }
    return { package: tr.doc };
  }

  const targetWeaver = await db.get<UserDoc>(COLLECTIONS.USERS, params.targetWeaverId);
  if (!targetWeaver || targetWeaver.funnelStage !== "approved") {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "目标织女不存在或尚未通过准入转正");
  }
  assertNotSelfOrder(pkg.buyerUserId, targetWeaver._id);

  const tr1 = await transitionStatus(
    db,
    COLLECTIONS.ORDER_PACKAGES,
    pkg._id,
    ORDER_PACKAGE_STATUS_SPEC,
    "manual_hold",
    "waiting_dispatch",
    pkg.version,
    () => ({
      assignedWeaverId: undefined,
      queueSeq: undefined,
      bagQrCode: undefined,
      isReadyStockReuse: false,
      dispatchableAt: now,
    }),
    now,
  );
  if (!tr1.moved || !tr1.doc) {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "订单包状态并发冲突");
  }

  const nextAttempt = pkg.attemptCount + 1;
  const offerDoc: DispatchOfferDoc = {
    _id: dispatchOfferId(pkg._id, nextAttempt),
    packageId: pkg._id,
    attemptNo: nextAttempt,
    weaverId: targetWeaver._id,
    matchTier: "national",
    status: "pending",
    offeredAt: now,
    expireAt: now + HOUR_MS,
    yarnAvailabilityConfirmed: false,
    version: 1,
  };
  await db.put(COLLECTIONS.DISPATCH_OFFERS, offerDoc);

  const reviewMode: OrderPackageDoc["reviewMode"] = targetWeaver.creditScore >= 120 ? "skip" : "required";
  const tr2 = await transitionStatus(
    db,
    COLLECTIONS.ORDER_PACKAGES,
    pkg._id,
    ORDER_PACKAGE_STATUS_SPEC,
    "waiting_dispatch",
    "offered",
    tr1.doc.version,
    () => ({
      assignedWeaverId: targetWeaver._id,
      attemptCount: nextAttempt,
      lastManualResetAttempt: nextAttempt - 1,
      isReadyStockReuse: false,
      reviewMode,
    }),
    now,
  );
  if (!tr2.moved || !tr2.doc) {
    throw new AppError(ERROR_CODES.CAS_CONFLICT, "订单包改派邀约并发冲突");
  }
  return { package: tr2.doc, offer: offerDoc };
}
