import {
  COLLECTIONS,
  MINUTE_MS,
  AppError,
  ERROR_CODES,
  type OrderPackageDoc,
  type WeaverStockDoc,
} from "@wxtz/shared";
import type { DbAdapter } from "./db.ts";
import { weaverStockId } from "./ids.ts";

export const STOCK_RESERVE_TTL_MS = 15 * MINUTE_MS;

/**
 * Registers items from a mid-making cancelled core package into `weaverStock` for priority reuse.
 */
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

/**
 * Atomic 15-minute reservation lock on ready stock (`weaverStock`), preventing concurrent oversell.
 */
export async function reserveReadyStock(
  db: DbAdapter,
  params: {
    weaverId: string;
    skuCode: string;
    orderId: string;
    qty: number;
    nowUtcMs?: number;
  },
): Promise<{ reserved: boolean; doc: WeaverStockDoc | null }> {
  if (!Number.isInteger(params.qty) || params.qty <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid reserve qty: ${params.qty}`);
  }
  const now = params.nowUtcMs ?? Date.now();
  const id = weaverStockId(params.weaverId, params.skuCode);

  const res = await db.atomicUpdate<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    id,
    (cur) => {
      if (cur.reservations.some((r) => r.orderId === params.orderId)) return false;
      return cur.availableQty >= params.qty;
    },
    (cur) => ({
      ...cur,
      availableQty: cur.availableQty - params.qty,
      reservedQty: cur.reservedQty + params.qty,
      reservations: [
        ...cur.reservations,
        { orderId: params.orderId, qty: params.qty, expireAt: now + STOCK_RESERVE_TTL_MS },
      ],
      version: cur.version + 1,
      updatedAt: now,
    }),
  );

  return { reserved: res.updated, doc: res.doc };
}

/**
 * Marks a 15-min reservation as paid and binds it to the created fulfillment `packageId`,
 * so `releaseExpiredReservations` never releases already-paid stock back to `availableQty`.
 */
export async function commitPaidStockReservation(
  db: DbAdapter,
  params: { orderId: string; packageId: string; nowUtcMs?: number },
): Promise<string | undefined> {
  const now = params.nowUtcMs ?? Date.now();
  const docs = await db.find<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, (d) =>
    d.reservations.some((r) => r.orderId === params.orderId),
  );
  const holder = docs[0];
  if (!holder) return undefined;

  await db.atomicUpdate<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    holder._id,
    (cur) => cur.reservations.some((r) => r.orderId === params.orderId),
    (cur) => ({
      ...cur,
      reservations: cur.reservations.map((r) =>
        r.orderId === params.orderId ? { ...r, paid: true, packageId: params.packageId } : r,
      ),
      version: cur.version + 1,
      updatedAt: now,
    }),
  );
  return holder.weaverId;
}

/**
 * Immediately releases any active reservation held by a cancelled order or package back into `availableQty`.
 */
export async function releaseStockReservationForOrderOrPackage(
  db: DbAdapter,
  params: { orderIds: readonly string[]; packageId?: string; nowUtcMs?: number },
): Promise<number> {
  const now = params.nowUtcMs ?? Date.now();
  const orderSet = new Set(params.orderIds);
  const matches = (r: WeaverStockDoc["reservations"][number]) =>
    orderSet.has(r.orderId) || (params.packageId !== undefined && r.packageId === params.packageId);

  const docs = await db.find<WeaverStockDoc>(COLLECTIONS.WEAVER_STOCK, (d) => d.reservations.some(matches));
  let totalFreed = 0;

  for (const doc of docs) {
    let freed = 0;
    const res = await db.atomicUpdate<WeaverStockDoc>(
      COLLECTIONS.WEAVER_STOCK,
      doc._id,
      (cur) => cur.reservations.some(matches),
      (cur) => {
        const keep: WeaverStockDoc["reservations"] = [];
        let local = 0;
        for (const r of cur.reservations) {
          if (matches(r)) local += r.qty;
          else keep.push(r);
        }
        freed = local;
        return {
          ...cur,
          availableQty: cur.availableQty + local,
          reservedQty: Math.max(0, cur.reservedQty - local),
          reservations: keep,
          version: cur.version + 1,
          updatedAt: now,
        };
      },
    );
    if (res.updated) totalFreed += freed;
  }
  return totalFreed;
}

/**
 * Atomically consumes ready stock upon weaver accepting a `stock`-tier offer:
 *  - If a reservation already exists for this order/package, consumes `reservedQty`;
 *  - Otherwise consumes free `availableQty >= qty`.
 * Returns `{ consumed: false }` on race loss so caller NEVER double-assigns 1 physical stock unit.
 */
export async function consumeReadyStockForAcceptedOffer(
  db: DbAdapter,
  params: {
    weaverId: string;
    skuCode: string;
    qty: number;
    orderIds: readonly string[];
    packageId: string;
    nowUtcMs?: number;
  },
): Promise<{ consumed: boolean }> {
  const now = params.nowUtcMs ?? Date.now();
  const id = weaverStockId(params.weaverId, params.skuCode);
  const orderSet = new Set(params.orderIds);
  const isOurs = (r: WeaverStockDoc["reservations"][number]) =>
    orderSet.has(r.orderId) || r.packageId === params.packageId || r.orderId === params.packageId;

  const res = await db.atomicUpdate<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    id,
    (cur) => {
      const reservedForUs = cur.reservations.filter(isOurs).reduce((s, r) => s + r.qty, 0);
      return reservedForUs >= params.qty || cur.availableQty >= params.qty;
    },
    (cur) => {
      const reservedForUs = cur.reservations.filter(isOurs).reduce((s, r) => s + r.qty, 0);
      if (reservedForUs >= params.qty) {
        return {
          ...cur,
          reservedQty: Math.max(0, cur.reservedQty - reservedForUs),
          availableQty: cur.availableQty + (reservedForUs - params.qty),
          reservations: cur.reservations.filter((r) => !isOurs(r)),
          items: cur.items.slice(params.qty),
          version: cur.version + 1,
          updatedAt: now,
        };
      }
      return {
        ...cur,
        availableQty: cur.availableQty - params.qty,
        items: cur.items.slice(params.qty),
        version: cur.version + 1,
        updatedAt: now,
      };
    },
  );
  return { consumed: res.updated };
}

/**
 * Releases expired UNPAID reservations back into `availableQty`. Invoked every 5 min by cron.
 */
export async function releaseExpiredReservations(
  db: DbAdapter,
  nowUtcMs: number = Date.now(),
): Promise<{ releasedUnits: number; touchedDocs: number }> {
  const isExpiredUnpaid = (r: WeaverStockDoc["reservations"][number]) => !r.paid && r.expireAt <= nowUtcMs;

  const docs = await db.find<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    (d) => d.reservations.some(isExpiredUnpaid),
  );

  let releasedUnits = 0;
  let touchedDocs = 0;

  for (const doc of docs) {
    let localReleased = 0;
    const res = await db.atomicUpdate<WeaverStockDoc>(
      COLLECTIONS.WEAVER_STOCK,
      doc._id,
      (cur) => cur.reservations.some(isExpiredUnpaid),
      (cur) => {
        const keep: WeaverStockDoc["reservations"] = [];
        let freed = 0;
        for (const r of cur.reservations) {
          if (isExpiredUnpaid(r)) freed += r.qty;
          else keep.push(r);
        }
        localReleased = freed;
        return {
          ...cur,
          availableQty: cur.availableQty + freed,
          reservedQty: Math.max(0, cur.reservedQty - freed),
          reservations: keep,
          version: cur.version + 1,
          updatedAt: nowUtcMs,
        };
      },
    );
    if (res.updated && localReleased > 0) {
      releasedUnits += localReleased;
      touchedDocs++;
    }
  }
  return { releasedUnits, touchedDocs };
}
