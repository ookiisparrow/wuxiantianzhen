import { COLLECTIONS } from "../../../shared/src/collections.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";
import type { OrderPackageDoc, UserDoc, YarnInventorySlot } from "../../../shared/src/schemas.ts";
import type { DbAdapter } from "./db.ts";

const DEFAULT_SKEIN_G = 50;
const DEFAULT_LOW_ALERT_SKEINS = 1;

function computeSlotStatus(wholeSkeins: number, lowAlertSkeins: number): "ok" | "low" | "empty" {
  if (wholeSkeins <= 0) return "empty";
  if (wholeSkeins <= lowAlertSkeins) return "low";
  return "ok";
}

/**
 * Initializes base-12 yarns with wholeSkeins = 1 upon weaver approval.
 */
export function createBase12Inventory(base12Codes: readonly string[]): Record<string, YarnInventorySlot> {
  const inv: Record<string, YarnInventorySlot> = {};
  for (const code of base12Codes) {
    inv[code] = {
      wholeSkeins: 1,
      usedSinceCheckG: 0,
      needCheck: false,
      status: "low", // 1 skein triggers gentle refill awareness when consumed
    };
  }
  return inv;
}

/**
 * Adds received whole skeins into weaver's dual-granularity inventory upon claim receipt.
 */
export async function receiveYarnClaimToInventory(
  db: DbAdapter,
  weaverId: string,
  items: ReadonlyArray<{ yarnCode: string; qty: number }>,
  lowAlertSkeins: number = DEFAULT_LOW_ALERT_SKEINS,
  nowUtcMs: number = Date.now(),
): Promise<UserDoc> {
  const res = await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    weaverId,
    () => true,
    (u) => {
      const nextInv = { ...u.yarnInventory };
      for (const item of items) {
        const cur = nextInv[item.yarnCode] ?? {
          wholeSkeins: 0,
          usedSinceCheckG: 0,
          needCheck: false,
          status: "empty" as const,
        };
        const wholeSkeins = cur.wholeSkeins + item.qty;
        nextInv[item.yarnCode] = {
          ...cur,
          wholeSkeins,
          status: computeSlotStatus(wholeSkeins, lowAlertSkeins),
        };
      }
      return { ...u, yarnInventory: nextInv, updatedAt: nowUtcMs };
    },
  );
  if (!res.updated || !res.doc) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Weaver not found: ${weaverId}`);
  }
  return res.doc;
}

/**
 * Accumulates BOM grams consumed by an order package and raises `needCheck = true`
 * every time cumulative usage crosses one full skein (default 50g).
 * HARD GUARD: Ready-stock reuse (`isReadyStockReuse === true`) NEVER deducts yarn again!
 */
export async function consumeYarnForPackage(
  db: DbAdapter,
  weaverId: string,
  pkg: Pick<OrderPackageDoc, "isReadyStockReuse" | "itemsSnapshot">,
  unitWeightByYarn: Readonly<Record<string, number>> = {},
  nowUtcMs: number = Date.now(),
): Promise<{ skippedReadyStock: boolean; triggeredCheckCodes: string[] }> {
  if (pkg.isReadyStockReuse) {
    return { skippedReadyStock: true, triggeredCheckCodes: [] };
  }

  const gramUsage = new Map<string, number>();
  for (const item of pkg.itemsSnapshot) {
    for (const bom of item.yarnBomSnapshot) {
      gramUsage.set(bom.yarnCode, (gramUsage.get(bom.yarnCode) ?? 0) + bom.consumedG * item.qty);
    }
  }

  const triggeredCheckCodes: string[] = [];

  const res = await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    weaverId,
    () => true,
    (u) => {
      const nextInv = { ...u.yarnInventory };
      for (const [yarnCode, grams] of gramUsage.entries()) {
        const unitG = unitWeightByYarn[yarnCode] ?? DEFAULT_SKEIN_G;
        const cur = nextInv[yarnCode] ?? {
          wholeSkeins: 0,
          usedSinceCheckG: 0,
          needCheck: false,
          status: "empty" as const,
        };
        const nextUsed = cur.usedSinceCheckG + grams;
        const shouldCheck = cur.needCheck || nextUsed >= unitG;
        if (shouldCheck) triggeredCheckCodes.push(yarnCode);
        nextInv[yarnCode] = {
          ...cur,
          usedSinceCheckG: nextUsed,
          needCheck: shouldCheck,
        };
      }
      return { ...u, yarnInventory: nextInv, updatedAt: nowUtcMs };
    },
  );

  if (!res.updated) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Weaver not found: ${weaverId}`);
  }
  return { skippedReadyStock: false, triggeredCheckCodes };
}

/**
 * Weaver taps actual unopened skein count (e.g., 4 or 3) to zero-out cumulative error.
 * Automatically raises `status = 'low'` when `wholeSkeins <= 1` (proactive refill warning).
 */
export async function confirmWeaverSkeinCheck(
  db: DbAdapter,
  weaverId: string,
  yarnCode: string,
  reportedWholeSkeins: number,
  unitWeightG: number = DEFAULT_SKEIN_G,
  lowAlertSkeins: number = DEFAULT_LOW_ALERT_SKEINS,
  nowUtcMs: number = Date.now(),
): Promise<YarnInventorySlot> {
  if (!Number.isInteger(reportedWholeSkeins) || reportedWholeSkeins < 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid reportedWholeSkeins: ${reportedWholeSkeins}`);
  }

  let resultSlot: YarnInventorySlot | null = null;
  const res = await db.atomicUpdate<UserDoc>(
    COLLECTIONS.USERS,
    weaverId,
    () => true,
    (u) => {
      const cur = u.yarnInventory[yarnCode];
      const remainderG = cur && cur.usedSinceCheckG >= unitWeightG ? cur.usedSinceCheckG % unitWeightG : 0;
      const slot: YarnInventorySlot = {
        wholeSkeins: reportedWholeSkeins,
        usedSinceCheckG: reportedWholeSkeins === 0 ? 0 : remainderG,
        needCheck: false,
        status: computeSlotStatus(reportedWholeSkeins, lowAlertSkeins),
        lastCheckedAt: nowUtcMs,
      };
      resultSlot = slot;
      return {
        ...u,
        yarnInventory: { ...u.yarnInventory, [yarnCode]: slot },
        updatedAt: nowUtcMs,
      };
    },
  );

  if (!res.updated || !resultSlot) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Weaver not found: ${weaverId}`);
  }
  return resultSlot;
}
