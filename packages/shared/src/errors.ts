export const ERROR_CODES = {
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  CAS_CONFLICT: "CAS_CONFLICT",
  LEDGER_UNBALANCED: "LEDGER_UNBALANCED",
  DUPLICATE_IDEMPOTENCY_KEY: "DUPLICATE_IDEMPOTENCY_KEY",
  INSUFFICIENT_YARN_POOL: "INSUFFICIENT_YARN_POOL",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  YARN_CLAIM_MIN_QTY: "YARN_CLAIM_MIN_QTY",
  SELF_ORDER_FORBIDDEN: "SELF_ORDER_FORBIDDEN",
  PHONE_REQUIRED: "PHONE_REQUIRED",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}
