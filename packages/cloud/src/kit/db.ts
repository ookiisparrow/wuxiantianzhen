import type { CollectionName } from "../../../shared/src/collections.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";

export interface BaseDoc {
  _id: string;
}

/**
 * Minimal CloudBase-compatible DB abstraction supporting atomic CAS updates
 * and deterministic idempotent inserts. Production plugs in wx-server-sdk;
 * tests run against InMemoryDb with identical concurrency semantics.
 */
export interface DbAdapter {
  get<T extends BaseDoc>(col: CollectionName, id: string): Promise<T | null>;
  find<T extends BaseDoc>(col: CollectionName, predicate: (doc: T) => boolean): Promise<T[]>;
  insert<T extends BaseDoc>(col: CollectionName, doc: T): Promise<{ inserted: boolean }>;
  put<T extends BaseDoc>(col: CollectionName, doc: T): Promise<void>;
  /**
   * Atomic Compare-And-Swap update on a single document.
   * Only commits if `guard(current)` returns true.
   */
  atomicUpdate<T extends BaseDoc>(
    col: CollectionName,
    id: string,
    guard: (current: T) => boolean,
    mutate: (current: T) => T,
  ): Promise<{ updated: boolean; doc: T | null }>;
  remove(col: CollectionName, id: string): Promise<boolean>;
}

function deepClone<T>(val: T): T {
  return structuredClone(val);
}

export class InMemoryDb implements DbAdapter {
  private readonly store = new Map<CollectionName, Map<string, BaseDoc>>();

  private bucket(col: CollectionName): Map<string, BaseDoc> {
    let b = this.store.get(col);
    if (!b) {
      b = new Map<string, BaseDoc>();
      this.store.set(col, b);
    }
    return b;
  }

  async get<T extends BaseDoc>(col: CollectionName, id: string): Promise<T | null> {
    const doc = this.bucket(col).get(id);
    return doc ? deepClone(doc as T) : null;
  }

  async find<T extends BaseDoc>(col: CollectionName, predicate: (doc: T) => boolean): Promise<T[]> {
    const out: T[] = [];
    for (const doc of this.bucket(col).values()) {
      const cloned = deepClone(doc as T);
      if (predicate(cloned)) out.push(cloned);
    }
    return out;
  }

  async insert<T extends BaseDoc>(col: CollectionName, doc: T): Promise<{ inserted: boolean }> {
    if (!doc._id) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Document in ${col} missing _id`);
    }
    const b = this.bucket(col);
    if (b.has(doc._id)) {
      return { inserted: false };
    }
    b.set(doc._id, deepClone(doc));
    return { inserted: true };
  }

  async put<T extends BaseDoc>(col: CollectionName, doc: T): Promise<void> {
    if (!doc._id) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Document in ${col} missing _id`);
    }
    this.bucket(col).set(doc._id, deepClone(doc));
  }

  async atomicUpdate<T extends BaseDoc>(
    col: CollectionName,
    id: string,
    guard: (current: T) => boolean,
    mutate: (current: T) => T,
  ): Promise<{ updated: boolean; doc: T | null }> {
    const b = this.bucket(col);
    const existing = b.get(id) as T | undefined;
    if (!existing) return { updated: false, doc: null };
    const snap = deepClone(existing);
    if (!guard(snap)) {
      return { updated: false, doc: snap };
    }
    const next = mutate(deepClone(existing));
    if (next._id !== id) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Cannot change _id during atomicUpdate (${id} -> ${next._id})`);
    }
    b.set(id, deepClone(next));
    return { updated: true, doc: deepClone(next) };
  }

  async remove(col: CollectionName, id: string): Promise<boolean> {
    return this.bucket(col).delete(id);
  }
}
