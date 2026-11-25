import { COLLECTIONS, type OrderPackageDoc, type UserDoc } from "@wxtz/shared";
import type { DbAdapter } from "./db.ts";

/**
 * Exponentially smooths a weaver's delivery speed factor within [0.6, 1.3] upon shipment
 * (docs/07 §3.1 users.speedFactor & §4.3).
 * Skips ready-stock reuse packages so premade stock never distorts crafting speed.
 */
export async function updateWeaverSpeedFactorOnShipped(
  db: DbAdapter,
  pkg: OrderPackageDoc,
  shippedAtMs: number,
): Promise<number | null> {
  if (pkg.isReadyStockReuse || !pkg.assignedWeaverId || !pkg.acceptedAt || pkg.totalMin <= 0) {
    return null;
  }

  const elapsedMin = Math.max(15, Math.round((shippedAtMs - pkg.acceptedAt) / 60_000));
  const sampleFactor = Math.min(1.3, Math.max(0.6, pkg.totalMin / elapsedMin));

  const res = await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    pkg.assignedWeaverId,
    () => true,
    (u) => {
      const curSpeed = u.speedFactor || 1.0;
      const blended = curSpeed * 0.9 + sampleFactor * 0.1;
      const nextSpeed = Math.round(Math.min(1.3, Math.max(0.6, blended)) * 1000) / 1000;
      return {
        ...u,
        speedFactor: nextSpeed,
        updatedAt: shippedAtMs,
      };
    },
  );

  return res.updated && res.doc ? res.doc.speedFactor : null;
}
