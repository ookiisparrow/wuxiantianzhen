import crypto from "node:crypto";
import { COLLECTIONS } from "../../../shared/src/collections.ts";
import { DAY_MS } from "../../../shared/src/cst.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";
import { ZERO_FEN, asNonNegativeFen, type Fen } from "../../../shared/src/money.ts";
import { ORDER_PACKAGE_STATUS_SPEC } from "../../../shared/src/status.ts";
import type {
  ExternalOrderIndexDoc,
  OrderDoc,
  OrderPackageDoc,
  PackageItemSnapshot,
  ShipmentDoc,
  StyleDoc,
  WeaverStockDoc,
} from "../../../shared/src/schemas.ts";
import type { DbAdapter } from "../kit/db.ts";
import {
  externalOrderIndexId,
  newOrderId,
  newPackageId,
  shipmentId,
  weaverStockId,
} from "../kit/ids.ts";
import { transitionStatus } from "../kit/transition.ts";

export interface DouyinOrderCsvRow {
  externalOrderId: string;
  skuCode: string;
  qty: number;
  paidFen: number;
  province: string;
  city: string;
  maskedName: string;
  maskedPhone: string;
  trackingNo?: string;
  signedAtMs?: number;
}

export interface DouyinRefundCsvRow {
  externalOrderId: string;
  refundStatus: "refunding" | "refunded";
  reason?: string;
}

export interface DouyinImportPreview {
  valid: boolean;
  blockingErrors: string[];
  newOrderCount: number;
  mergedIntoExistingPkgCount: number;
  refundSignalsCount: number;
  logisticsUpdatesCount: number;
}

const SCIENTIFIC_NOTATION_RE = /^\d+(\.\d+)?e\+\d+$/i;

export function buildCustomerMergeKey(row: Pick<DouyinOrderCsvRow, "province" | "city" | "maskedName" | "maskedPhone">): string {
  const raw = `${row.province.trim()}|${row.city.trim()}|${row.maskedName.trim()}|${row.maskedPhone.trim()}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Dry-run validator for Douyin order + refund CSV uploads.
 * Enforces the Round 9 Q7 dual-file guard: refund CSV must be uploaded OR `confirmZeroRefundsToday` explicitly checked.
 */
export async function previewDouyinImport(
  db: DbAdapter,
  params: {
    orderRows: readonly DouyinOrderCsvRow[];
    refundRows?: readonly DouyinRefundCsvRow[];
    confirmZeroRefundsToday?: boolean;
  },
): Promise<DouyinImportPreview> {
  const blockingErrors: string[] = [];

  if (params.refundRows === undefined && !params.confirmZeroRefundsToday) {
    blockingErrors.push("尚未上传今日售后退款表（若今日确实 0 退款，请勾选“确认今日 0 退款”后再导入）");
  }

  const styles = await db.find<StyleDoc>(COLLECTIONS.STYLES, () => true);
  const styleMap = new Map(styles.map((s) => [s._id, s]));

  let newOrderCount = 0;
  let mergedIntoExistingPkgCount = 0;
  let logisticsUpdatesCount = 0;

  for (let i = 0; i < params.orderRows.length; i++) {
    const r = params.orderRows[i]!;
    const id = r.externalOrderId.trim();
    if (!id || SCIENTIFIC_NOTATION_RE.test(id) || /e\+/i.test(id)) {
      blockingErrors.push(`第 ${i + 1} 行订单号疑似被 Excel 转为科学计数法或为空：${r.externalOrderId}`);
      continue;
    }
    const style = styleMap.get(r.skuCode.trim());
    if (!style || style.status !== "active") {
      blockingErrors.push(`第 ${i + 1} 行未知或未上架的商家编码(款号)：${r.skuCode}`);
      continue;
    }
    if (!Number.isInteger(r.qty) || r.qty <= 0) {
      blockingErrors.push(`第 ${i + 1} 行数量非法：${r.qty}`);
      continue;
    }

    const idxDoc = await db.get<ExternalOrderIndexDoc>(
      COLLECTIONS.EXTERNAL_ORDER_INDEX,
      externalOrderIndexId("douyin_online", id),
    );
    if (idxDoc) {
      if (r.trackingNo || r.signedAtMs) logisticsUpdatesCount++;
    } else {
      newOrderCount++;
      const mKey = buildCustomerMergeKey(r);
      const existingConfirming = await db.find<OrderPackageDoc>(
        COLLECTIONS.ORDER_PACKAGES,
        (p) => p.channel === "douyin_online" && p.status === "confirming" && p.mergeKey === mKey,
      );
      if (existingConfirming.length > 0) mergedIntoExistingPkgCount++;
    }
  }

  return {
    valid: blockingErrors.length === 0,
    blockingErrors,
    newOrderCount,
    mergedIntoExistingPkgCount,
    refundSignalsCount: params.refundRows?.length ?? 0,
    logisticsUpdatesCount,
  };
}

/**
 * Commits Douyin incremental import:
 *  1. Processes refunds FIRST (preventing wasted dispatch on overnight cancellations);
 *  2. Merges new orders within `confirming` window up to `maxSingleCustomerMin` cap;
 *  3. Updates tracking numbers & signoff timestamps (`settleEligibleAt = signedAt + 7d`).
 */
export async function commitDouyinImport(
  db: DbAdapter,
  params: {
    orderRows: readonly DouyinOrderCsvRow[];
    refundRows?: readonly DouyinRefundCsvRow[];
    confirmZeroRefundsToday?: boolean;
    dispatchableAtMs: number;
    maxSingleCustomerMin?: number; // default 1680 min (14d * 4h * 0.5)
    nowUtcMs?: number;
  },
): Promise<{
  createdPackages: number;
  mergedOrders: number;
  cancelledPreMake: number;
  cancelledInMake: number;
  shippedUpdated: number;
  signedUpdated: number;
}> {
  const preview = await previewDouyinImport(db, params);
  if (!preview.valid) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, preview.blockingErrors.join("；"), {
      errors: preview.blockingErrors,
    });
  }

  const now = params.nowUtcMs ?? Date.now();
  const maxMin = params.maxSingleCustomerMin ?? 1680;
  let createdPackages = 0;
  let mergedOrders = 0;
  let cancelledPreMake = 0;
  let cancelledInMake = 0;
  let shippedUpdated = 0;
  let signedUpdated = 0;

  // Step 1: Process refunds FIRST
  for (const ref of params.refundRows ?? []) {
    const extId = ref.externalOrderId.trim();
    const idx = await db.get<ExternalOrderIndexDoc>(
      COLLECTIONS.EXTERNAL_ORDER_INDEX,
      externalOrderIndexId("douyin_online", extId),
    );
    if (!idx) continue;
    const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, idx.packageId);
    if (!pkg) continue;

    if (pkg.status === "confirming" || pkg.status === "waiting_dispatch" || pkg.status === "offered") {
      const tr = await transitionStatus(
        db,
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        ORDER_PACKAGE_STATUS_SPEC,
        pkg.status,
        "cancelled_full",
        pkg.version,
        undefined,
        now,
      );
      if (tr.moved) cancelledPreMake++;
    } else if (pkg.status === "making") {
      const tr = await transitionStatus(
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
      if (tr.moved && pkg.assignedWeaverId) {
        cancelledInMake++;
        // Register finished/in-progress core items into weaverStock for reuse
        await registerCancelledPackageToWeaverStock(db, pkg, now);
      }
    }
  }

  // Build style lookup + catalog lookup for BOM snapshot
  const styles = await db.find<StyleDoc>(COLLECTIONS.STYLES, () => true);
  const styleMap = new Map(styles.map((s) => [s._id, s]));
  const refundedExtIds = new Set((params.refundRows ?? []).map((r) => r.externalOrderId.trim()));

  // Step 2: Import new orders & update logistics on existing orders
  for (const r of params.orderRows) {
    const extId = r.externalOrderId.trim();
    const idxKey = externalOrderIndexId("douyin_online", extId);
    const existingIdx = await db.get<ExternalOrderIndexDoc>(COLLECTIONS.EXTERNAL_ORDER_INDEX, idxKey);

    if (existingIdx) {
      // Incremental logistics / signoff sync
      const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, existingIdx.packageId);
      if (!pkg) continue;

      if (r.trackingNo && pkg.status === "ready_to_ship") {
        const tr = await transitionStatus(
          db,
          COLLECTIONS.ORDER_PACKAGES,
          pkg._id,
          ORDER_PACKAGE_STATUS_SPEC,
          "ready_to_ship",
          "shipped",
          pkg.version,
          () => ({ shippedAt: now }),
          now,
        );
        if (tr.moved) {
          shippedUpdated++;
          const sId = shipmentId(pkg._id);
          const curShip = await db.get<ShipmentDoc>(COLLECTIONS.SHIPMENTS, sId);
          if (curShip) {
            await db.put<ShipmentDoc>(COLLECTIONS.SHIPMENTS, {
              ...curShip,
              trackingNo: r.trackingNo.trim(),
              status: "in_transit",
              updatedAt: now,
            });
          }
        }
      }

      const freshPkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, existingIdx.packageId);
      if (r.signedAtMs && freshPkg && freshPkg.status === "shipped") {
        const tr = await transitionStatus(
          db,
          COLLECTIONS.ORDER_PACKAGES,
          freshPkg._id,
          ORDER_PACKAGE_STATUS_SPEC,
          "shipped",
          "signed",
          freshPkg.version,
          () => ({
            signedAt: r.signedAtMs,
            settleEligibleAt: r.signedAtMs! + 7 * DAY_MS,
          }),
          now,
        );
        if (tr.moved) signedUpdated++;
      }
      continue;
    }

    // Skip creating active package if already in today's refund table
    const style = styleMap.get(r.skuCode.trim())!;
    const ordId = newOrderId();
    const isAlreadyRefunded = refundedExtIds.has(extId);

    const orderDoc: OrderDoc = {
      _id: ordId,
      channel: "douyin_online",
      externalOrderId: extId,
      skuCode: style._id,
      qty: r.qty,
      totalPaidFen: asNonNegativeFen(r.paidFen) as Fen,
      buyerShipFeeFen: ZERO_FEN,
      status: isAlreadyRefunded ? "refunded" : "paid",
      paidAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(COLLECTIONS.ORDERS, orderDoc);

    const itemMin = style.standardMin * r.qty;
    const snapItem: PackageItemSnapshot = {
      skuCode: style._id,
      qty: r.qty,
      standardMin: style.standardMin,
      yarnBomSnapshot: style.yarnBom.map((b) => ({
        yarnCode: b.yarnCode,
        consumedG: Math.ceil((b.netWeightG * (10000 + style.wasteRateBp)) / 10000),
      })),
      materialCostFen: style.materialCostFen,
      craftFeeFen: style.craftFeeFen,
      yarnPoolAccrualFen: style.yarnPoolAccrualFen,
      weaverShipShareFen: style.weaverShipShareFen,
      saleType: "made_to_order",
    };

    const mergeKey = buildCustomerMergeKey(r);

    if (isAlreadyRefunded) {
      const pkgId = newPackageId();
      await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
        _id: pkgId,
        channel: "douyin_online",
        poolTarget: "live",
        orderIds: [ordId],
        externalOrderIds: [extId],
        buyerProvince: r.province.trim(),
        buyerCity: r.city.trim(),
        mergeKey,
        itemsSnapshot: [snapItem],
        totalMin: itemMin,
        status: "cancelled_full",
        isReadyStockReuse: false,
        attemptCount: 0,
        reviewMode: "required",
        dispatchableAt: params.dispatchableAtMs,
        dueAt: now + 14 * DAY_MS,
        version: 1,
        updatedAt: now,
      });
      await db.insert<ExternalOrderIndexDoc>(COLLECTIONS.EXTERNAL_ORDER_INDEX, {
        _id: idxKey,
        orderId: ordId,
        packageId: pkgId,
        createdAt: now,
      });
      cancelledPreMake++;
      continue;
    }

    // Try merging into an open `confirming` package for the same customer within工时 cap
    const candidates = await db.find<OrderPackageDoc>(
      COLLECTIONS.ORDER_PACKAGES,
      (p) =>
        p.channel === "douyin_online" &&
        p.status === "confirming" &&
        p.mergeKey === mergeKey &&
        now < p.dispatchableAt &&
        p.totalMin + itemMin <= maxMin,
    );

    if (candidates[0]) {
      const target = candidates[0];
      const upd = await db.atomicUpdate<OrderPackageDoc>(
        COLLECTIONS.ORDER_PACKAGES,
        target._id,
        (cur) => cur.status === "confirming" && cur.version === target.version,
        (cur) => ({
          ...cur,
          orderIds: [...cur.orderIds, ordId],
          externalOrderIds: [...cur.externalOrderIds, extId],
          itemsSnapshot: [...cur.itemsSnapshot, snapItem],
          totalMin: cur.totalMin + itemMin,
          version: cur.version + 1,
          updatedAt: now,
        }),
      );
      if (upd.updated) {
        await db.insert<ExternalOrderIndexDoc>(COLLECTIONS.EXTERNAL_ORDER_INDEX, {
          _id: idxKey,
          orderId: ordId,
          packageId: target._id,
          createdAt: now,
        });
        mergedOrders++;
        continue;
      }
    }

    // Otherwise create a fresh confirming package
    const pkgId = newPackageId();
    await db.insert<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, {
      _id: pkgId,
      channel: "douyin_online",
      poolTarget: "live",
      orderIds: [ordId],
      externalOrderIds: [extId],
      buyerProvince: r.province.trim(),
      buyerCity: r.city.trim(),
      mergeKey,
      itemsSnapshot: [snapItem],
      totalMin: itemMin,
      status: "confirming",
      isReadyStockReuse: false,
      attemptCount: 0,
      reviewMode: "required",
      dispatchableAt: params.dispatchableAtMs,
      dueAt: now + 14 * DAY_MS,
      version: 1,
      updatedAt: now,
    });
    await db.insert<ExternalOrderIndexDoc>(COLLECTIONS.EXTERNAL_ORDER_INDEX, {
      _id: idxKey,
      orderId: ordId,
      packageId: pkgId,
      createdAt: now,
    });
    createdPackages++;
  }

  return {
    createdPackages,
    mergedOrders,
    cancelledPreMake,
    cancelledInMake,
    shippedUpdated,
    signedUpdated,
  };
}

export async function registerCancelledPackageToWeaverStock(
  db: DbAdapter,
  pkg: OrderPackageDoc,
  nowUtcMs: number,
): Promise<void> {
  if (!pkg.assignedWeaverId) return;
  for (const item of pkg.itemsSnapshot) {
    const id = weaverStockId(pkg.assignedWeaverId, item.skuCode);
    const existing = await db.get<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, id);
    if (!existing) {
      await db.insert<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, {
        _id: id,
        weaverId: pkg.assignedWeaverId,
        skuCode: item.skuCode,
        availableQty: item.qty,
        reservedQty: 0,
        reservations: [],
        items: [{ sourceType: "cancelled_order", sourcePkgId: pkg._id, createdAt: nowUtcMs }],
        oldestCreatedAt: nowUtcMs,
        version: 1,
        updatedAt: nowUtcMs,
      });
    } else {
      await db.atomicUpdate<WeaverStockDoc>(
        COLLECTIONS.WEAVER_STOCK,
        id,
        () => true,
        (cur) => ({
          ...cur,
          availableQty: cur.availableQty + item.qty,
          items: [...cur.items, { sourceType: "cancelled_order", sourcePkgId: pkg._id, createdAt: nowUtcMs }],
          version: cur.version + 1,
          updatedAt: nowUtcMs,
        }),
      );
    }
  }
}
