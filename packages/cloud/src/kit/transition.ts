import type { CollectionName } from "../../../shared/src/collections.ts";
import { AppError, ERROR_CODES } from "../../../shared/src/errors.ts";
import { canTransition, type StateSpec } from "../../../shared/src/status.ts";
import type { BaseDoc, DbAdapter } from "./db.ts";

export interface VersionedStatusDoc<S extends string> extends BaseDoc {
  status: S;
  version: number;
  updatedAt?: number;
}

export interface TransitionResult<T> {
  moved: boolean;
  doc: T | null;
}

/**
 * Single authoritative CAS state transition engine (docs/07 §1.3 #3).
 * All one-time side effects MUST be strictly gated on `result.moved === true`.
 */
export async function transitionStatus<S extends string, T extends VersionedStatusDoc<S>>(
  db: DbAdapter,
  col: CollectionName,
  id: string,
  spec: StateSpec<S>,
  from: S,
  to: S,
  expectedVersion: number,
  patch?: (current: T) => Partial<Omit<T, "_id" | "status" | "version">>,
  nowUtcMs: number = Date.now(),
): Promise<TransitionResult<T>> {
  if (!canTransition(spec, from, to)) {
    throw new AppError(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      `Illegal state transition on ${col}/${id}: ${from} -> ${to}`,
      { col, id, from, to },
    );
  }

  const res = await db.atomicUpdate<T>(
    col,
    id,
    (cur) => cur.status === from && cur.version === expectedVersion,
    (cur) => {
      const extra = patch ? patch(cur) : {};
      return {
        ...cur,
        ...extra,
        status: to,
        version: cur.version + 1,
        updatedAt: nowUtcMs,
      };
    },
  );

  return { moved: res.updated, doc: res.doc };
}
