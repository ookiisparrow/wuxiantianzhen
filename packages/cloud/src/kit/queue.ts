import { COLLECTIONS, type OrderPackageDoc } from "@wxtz/shared";
import type { DbAdapter } from "./db.ts";

/**
 * Re-sequences a weaver's active queue (`making` / `photo_review` / `awaiting_seal`)
 * so the oldest remaining package always holds `queueSeq === 1` (unlocking its pattern).
 */
export async function compactWeaverQueue(db: DbAdapter, weaverId: string, nowUtcMs: number): Promise<void> {
  const remaining = await db.find<OrderPackageDoc>(
    COLLECTIONS.ORDER_PACKAGES,
    (p) =>
      p.assignedWeaverId === weaverId &&
      ["making", "photo_review", "awaiting_seal"].includes(p.status) &&
      p.queueSeq !== undefined,
  );
  remaining.sort((a, b) => (a.queueSeq ?? 999) - (b.queueSeq ?? 999));
  for (let i = 0; i < remaining.length; i++) {
    const targetSeq = i + 1;
    const item = remaining[i]!;
    if (item.queueSeq !== targetSeq) {
      await db.atomicUpdate<OrderPackageDoc>(
        COLLECTIONS.ORDER_PACKAGES,
        item._id,
        () => true,
        (cur) => ({ ...cur, queueSeq: targetSeq, updatedAt: nowUtcMs }),
      );
    }
  }
}
