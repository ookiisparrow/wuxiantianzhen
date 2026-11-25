import { AppError, ERROR_CODES, type CollectionName } from "@wxtz/shared";
import type { BaseDoc, DbAdapter } from "../kit/db.ts";

/**
 * Minimal structural typing for `wx-server-sdk` database instance so `@wxtz/cloud`
 * compiles cleanly without requiring `wx-server-sdk` in local unit-test environments.
 */
export interface WxCloudCollection {
  doc(id: string): {
    get(): Promise<{ data?: unknown }>;
    set(params: { data: Record<string, unknown> }): Promise<unknown>;
    remove(): Promise<{ stats?: { removed?: number } }>;
  };
  add(params: { data: Record<string, unknown> }): Promise<unknown>;
  where(query: Record<string, unknown>): {
    limit(n: number): { get(): Promise<{ data: unknown[] }> };
  };
}

export interface WxCloudDatabase {
  collection(name: string): WxCloudCollection;
  runTransaction<T>(fn: (tx: WxCloudDatabase) => Promise<T>): Promise<T>;
}

function stripId(doc: BaseDoc): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(doc as unknown as Record<string, unknown>) };
  delete copy._id;
  return copy;
}

/**
 * Production WeChat CloudBase (`wx-server-sdk`) adapter implementing `DbAdapter`.
 * Zero hardcoded `envId` — caller passes `cloud.database({ env: cloud.DYNAMIC_CURRENT_ENV })`.
 */
export class WxCloudDbAdapter implements DbAdapter {
  private readonly db: WxCloudDatabase;

  constructor(db: WxCloudDatabase) {
    this.db = db;
  }

  async get<T extends BaseDoc>(col: CollectionName, id: string): Promise<T | null> {
    try {
      const res = await this.db.collection(col).doc(id).get();
      if (!res || !res.data) return null;
      return { ...(res.data as Record<string, unknown>), _id: id } as T;
    } catch {
      return null;
    }
  }

  async find<T extends BaseDoc>(col: CollectionName, predicate: (doc: T) => boolean): Promise<T[]> {
    const out: T[] = [];
    // CloudBase cloud-side max page size is 1000; filter in memory for flexible domain predicates
    const res = await this.db.collection(col).where({}).limit(1000).get();
    for (const raw of res.data ?? []) {
      const doc = raw as T;
      if (predicate(doc)) out.push(doc);
    }
    return out;
  }

  async insert<T extends BaseDoc>(col: CollectionName, doc: T): Promise<{ inserted: boolean }> {
    if (!doc._id) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Document in ${col} missing _id`);
    }
    try {
      await this.db.collection(col).add({ data: doc as unknown as Record<string, unknown> });
      return { inserted: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate|exists|-502001/i.test(msg)) {
        return { inserted: false };
      }
      throw err;
    }
  }

  async put<T extends BaseDoc>(col: CollectionName, doc: T): Promise<void> {
    if (!doc._id) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Document in ${col} missing _id`);
    }
    await this.db.collection(col).doc(doc._id).set({ data: stripId(doc) });
  }

  async atomicUpdate<T extends BaseDoc>(
    col: CollectionName,
    id: string,
    guard: (current: T) => boolean,
    mutate: (current: T) => T,
  ): Promise<{ updated: boolean; doc: T | null }> {
    return this.db.runTransaction(async (tx) => {
      let current: T | null = null;
      try {
        const snap = await tx.collection(col).doc(id).get();
        if (snap?.data) {
          current = { ...(snap.data as Record<string, unknown>), _id: id } as T;
        }
      } catch {
        current = null;
      }
      if (!current) return { updated: false, doc: null };
      if (!guard(current)) return { updated: false, doc: current };

      const next = mutate(structuredClone(current));
      await tx.collection(col).doc(id).set({ data: stripId(next) });
      return { updated: true, doc: next };
    });
  }

  async remove(col: CollectionName, id: string): Promise<boolean> {
    const res = await this.db.collection(col).doc(id).remove();
    return (res.stats?.removed ?? 0) > 0;
  }
}
