import { COLLECTIONS, AppError, ERROR_CODES, type UserDoc, type UserRole } from "@wxtz/shared";
import type { DbAdapter } from "./db.ts";
import { newUserId } from "./ids.ts";

export type MiniProgramApp = "mp-buyer" | "mp-weaver";

export interface LoginInput {
  app: MiniProgramApp;
  openid: string;
  phone?: string;
  unionid?: string;
  nickname?: string;
  nowUtcMs?: number;
}

/**
 * Cross-mini-program unified identity login & entity-migration healer (docs/07 §2.1).
 * `_id` is ALWAYS internal `usr_<id>`, NEVER `openid`.
 * Resolution order:
 *  1. Match by `buyerOpenid` or `weaverOpenid`;
 *  2. If not found, match by unique `phone` and attach the new openid (seamless cross-MP & company migration);
 *  3. If brand new, require `phone` and create internal `usr_<id>`.
 */
export async function loginOrMergeUser(
  db: DbAdapter,
  input: LoginInput,
): Promise<{ user: UserDoc; created: boolean; mergedByPhone: boolean }> {
  const now = input.nowUtcMs ?? Date.now();
  const openidField = input.app === "mp-buyer" ? "buyerOpenid" : "weaverOpenid";
  const defaultRole: UserRole = input.app === "mp-buyer" ? "buyer" : "weaver";

  // 1. Lookup by current app's openid
  const byOpenid = await db.find<UserDoc>(COLLECTIONS.USERS, (u) => u[openidField] === input.openid);
  if (byOpenid[0]) {
    const existing = byOpenid[0];
    if (input.unionid && !existing.unionid) {
      const updated: UserDoc = { ...existing, unionid: input.unionid, updatedAt: now };
      await db.put(COLLECTIONS.USERS, updated);
      return { user: updated, created: false, mergedByPhone: false };
    }
    return { user: existing, created: false, mergedByPhone: false };
  }

  // 2. Lookup by unique phone (handles cross-mini-program linking AND future 个体户->有限公司 openid reset!)
  const normalizedPhone = input.phone?.trim();
  if (!normalizedPhone) {
    throw new AppError(
      ERROR_CODES.PHONE_REQUIRED,
      "Phone authorization is required to bind or create unified account",
    );
  }

  const byPhone = await db.find<UserDoc>(COLLECTIONS.USERS, (u) => u.phone === normalizedPhone);
  if (byPhone[0]) {
    const existing = byPhone[0];
    const nextRoles: UserRole[] = existing.roles.includes(defaultRole)
      ? existing.roles
      : [...existing.roles, defaultRole];
    const merged: UserDoc = {
      ...existing,
      [openidField]: input.openid,
      unionid: input.unionid ?? existing.unionid,
      roles: nextRoles,
      verifyLevel: existing.verifyLevel === "none" ? "phone" : existing.verifyLevel,
      updatedAt: now,
    };
    await db.put(COLLECTIONS.USERS, merged);
    return { user: merged, created: false, mergedByPhone: true };
  }

  // 3. Brand new user with internal usr_<id>
  const created: UserDoc = {
    _id: newUserId(),
    [openidField]: input.openid,
    unionid: input.unionid,
    phone: normalizedPhone,
    nickname: input.nickname,
    roles: [defaultRole],
    tags: [],
    verifyLevel: "phone",
    funnelStage: "none",
    acceptingOrders: false,
    acceptsTrial: false,
    restDays: [],
    dailyCapacityMin: 0,
    speedFactor: 1.0,
    stockQuota: {},
    yarnInventory: {},
    creditScore: 100,
    consecutiveTimeouts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(COLLECTIONS.USERS, created);
  return { user: created, created: true, mergedByPhone: false };
}

/**
 * Hard anti-self-order check (docs/07 §2.2).
 */
export function assertNotSelfOrder(buyerUserId: string | undefined, candidateWeaverId: string): void {
  if (buyerUserId && buyerUserId === candidateWeaverId) {
    throw new AppError(
      ERROR_CODES.SELF_ORDER_FORBIDDEN,
      `Weaver ${candidateWeaverId} cannot be assigned their own buyer order`,
    );
  }
}
