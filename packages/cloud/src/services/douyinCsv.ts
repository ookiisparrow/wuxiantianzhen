import crypto from "node:crypto";
import {
  COLLECTIONS,
  DAY_MS,
  AppError,
  ERROR_CODES,
  ZERO_FEN,
  asNonNegativeFen,
  DISPATCH_OFFER_STATUS_SPEC,
  ORDER_PACKAGE_STATUS_SPEC,
  type DispatchOfferDoc,
  type Fen,
  type ExternalOrderIndexDoc,
  type OrderDoc,
  type OrderPackageDoc,
  type PackageItemSnapshot,
  type ShipmentDoc,
  type StyleDoc,
} from "@wxtz/shared";
import type { DbAdapter } from "../kit/db.ts";
import { dispatchOfferId, externalOrderIndexId, newOrderId, newPackageId, shipmentId } from "../kit/ids.ts";
import { compactWeaverQueue } from "../kit/queue.ts";
import { registerCancelledPackageToWeaverStock } from "../kit/stockLock.ts";
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

  for (let i = 0; i < (params.refundRows ?? []).length; i++) {
    const rr = params.refundRows![i]!;
    const rid = rr.externalOrderId.trim();
    if (!rid || SCIENTIFIC_NOTATION_RE.test(rid) || /e\+/i.test(rid)) {
      blockingErrors.push(`售后退单表第 ${i + 1} 行订单号疑似被 Excel 转为科学计数法或为空：${rr.externalOrderId}`);
    }
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
    if (!Number.isSafeInteger(r.paidFen) || r.paidFen < 0) {
      blockingErrors.push(`第 ${i + 1} 行实付金额(分)须为非负整数：${r.paidFen}`);
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
    const idxKey = externalOrderIndexId("douyin_online", extId);
    const idx = await db.get<ExternalOrderIndexDoc>(COLLECTIONS.EXTERNAL_ORDER_INDEX, idxKey);
    if (!idx) continue;

    const ord = await db.get<OrderDoc>(COLLECTIONS.ORDERS, idx.orderId);
    if (ord?.status === "refunded") continue;

    const pkg = await db.get<OrderPackageDoc>(COLLECTIONS.ORDER_PACKAGES, idx.packageId);
    if (!pkg) continue;

    const isPreMake =
      pkg.status === "confirming" || pkg.status === "waiting_dispatch" || pkg.status === "offered";
    const isUnshippedPostMake = ["making", "photo_review", "awaiting_seal", "ready_to_ship"].includes(pkg.status);

    if (!isPreMake && !isUnshippedPostMake) continue;

    // Partial refund on a merged package: detach ONLY the refunded order, preserving sibling paid orders!
    if (pkg.orderIds.length > 1 && ord) {
      let remainingDeduct = ord.qty;
      const nextItems: PackageItemSnapshot[] = [];
      let detachedSnap: PackageItemSnapshot | undefined;

      for (const it of pkg.itemsSnapshot) {
        if (remainingDeduct > 0 && it.skuCode === ord.skuCode) {
          const take = Math.min(it.qty, remainingDeduct);
          remainingDeduct -= take;
          detachedSnap = { ...it, qty: take };
          if (it.qty - take > 0) {
            nextItems.push({ ...it, qty: it.qty - take });
          }
        } else {
          nextItems.push(it);
        }
      }
      const nextMin = nextItems.reduce((s, it) => s + it.standardMin * it.qty, 0);

      await db.atomicUpdate<OrderPackageDoc>(
        COLLECTIONS.ORDER_PACKAGES,
        pkg._id,
        (cur) => cur.orderIds.includes(ord._id),
        (cur) => ({
          ...cur,
          orderIds: cur.orderIds.filter((id) => id !== ord._id),
          externalOrderIds: cur.externalOrderIds.filter((id) => id !== extId),
          itemsSnapshot: nextItems,
          totalMin: nextMin,
          version: cur.version + 1,
          updatedAt: now,
        }),
      );

      const splitPkgId = newPackageId();
      const splitPkg: OrderPackageDoc = {
        ...pkg,
        _id: splitPkgId,
        orderIds: [ord._id],
        externalOrderIds: [extId],
        itemsSnapshot: detachedSnap ? [detachedSnap] : [],
        totalMin: detachedSnap ? detachedSnap.standardMin * detachedSnap.qty : 0,
        status: isPreMake ? "cancelled_full" : "cancelled_made",
        queueSeq: undefined,
        stallPromptedAt: undefined,
        version: 1,
        updatedAt: now,
      };
      await db.insert(COLLECTIONS.ORDER_PACKAGES, splitPkg);
      await db.put<ExternalOrderIndexDoc>(COLLECTIONS.EXTERNAL_ORDER_INDEX, {
        ...idx,
        packageId: splitPkgId,
      });
      await db.put<OrderDoc>(COLLECTIONS.ORDERS, { ...ord, status: "refunded", updatedAt: now });

      if (isPreMake) {
        cancelledPreMake++;
      } else {
        cancelledInMake++;
        if (pkg.assignedWeaverId) {
          await registerCancelledPackageToWeaverStock(db, splitPkg, now);
        }
      }
      continue;
    }

    if (isPreMake) {
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
      const tr = await transitionStatus(
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
      if (tr.moved) {
        cancelledPreMake++;
        if (ord) await db.put<OrderDoc>(COLLECTIONS.ORDERS, { ...ord, status: "refunded", updatedAt: now });
      }
    } else if (isUnshippedPostMake) {
      const weaverId = pkg.assignedWeaverId;
      const tr = await transitionStatus(
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
      if (tr.moved) {
        cancelledInMake++;
        if (ord) await db.put<OrderDoc>(COLLECTIONS.ORDERS, { ...ord, status: "refunded", updatedAt: now });
        if (weaverId) {
          await compactWeaverQueue(db, weaverId, now);
          await registerCancelledPackageToWeaverStock(db, pkg, now);
        }
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
      skuName: style.name,
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
