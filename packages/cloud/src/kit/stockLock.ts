import { COLLECTIONS } from "../../../shared/src/collections.ts";
import { MINUTE_MS } from "../../../shared/src/cst.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";
import type { WeaverStockDoc } from "../../../shared/src/schemas.ts";
import type { DbAdapter } from "./db.ts";
import { weaverStockId } from "./ids.ts";

export const STOCK_RESERVE_TTL_MS = 15 * MINUTE_MS;

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
      // Idempotent if same orderId already reserved
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
 * Releases expired unpaid reservations back into `availableQty`. Invoked every 5 min by cron.
 */
export async function releaseExpiredReservations(
  db: DbAdapter,
  nowUtcMs: number = Date.now(),
): Promise<{ releasedUnits: number; touchedDocs: number }> {
  const docs = await db.find<WeaverStockDoc>(
    COLLECTIONS.WEAVER_STOCK,
    (d) => d.reservations.some((r) => r.expireAt <= nowUtcMs),
  );

  let releasedUnits = 0;
  let touchedDocs = 0;

  for (const doc of docs) {
    let localReleased = 0;
    const res = await db.atomicUpdate<WeaverStockDoc>(
      COLLECTIONS.WEAVER_STOCK,
      doc._id,
      (cur) => cur.reservations.some((r) => r.expireAt <= nowUtcMs),
      (cur) => {
        const keep: WeaverStockDoc["reservations"] = [];
        let freed = 0;
        for (const r of cur.reservations) {
          if (r.expireAt <= nowUtcMs) freed += r.qty;
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
