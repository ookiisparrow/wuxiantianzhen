import crypto from "node:crypto";
import { AppError, COLLECTIONS, ERROR_CODES } from "@wxtz/shared";
import type { DbAdapter } from "../kit/db.ts";
import { newAuditId } from "../kit/ids.ts";

export interface AdminTokenPayload {
  sub: string; // admin userId (usr_...)
  role: "admin";
  exp: number; // UTC ms
}

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/**
 * Zero-dependency HMAC-SHA256 short-lived JWT for `admin` Web console (docs/07 §2.3).
 * Never expose `secret` to any client bundle.
 */
export function signAdminJwt(payload: AdminTokenPayload, secret: string): string {
  if (!secret || secret.length < 16) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Admin JWT secret must be at least 16 chars");
  }
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyAdminJwt(token: string | undefined, secret: string, nowUtcMs: number = Date.now()): AdminTokenPayload {
  if (!secret || secret.length < 16) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Admin JWT secret must be at least 16 chars");
  }
  if (!token) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "缺少运营后台登录凭证");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "运营后台凭证格式非法");
  }
  const [header, body, sig] = parts as [string, string, string];
  let headerObj: { alg?: string } | null = null;
  try {
    headerObj = JSON.parse(b64urlDecode(header)) as { alg?: string };
  } catch {
    throw new AppError(ERROR_CODES.FORBIDDEN, "运营后台凭证头部非法");
  }
  if (!headerObj || headerObj.alg !== "HS256") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "运营后台凭证签名算法非法");
  }

  const expectedSig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "运营后台凭证签名无效");
  }

  let parsed: AdminTokenPayload | null = null;
  try {
    parsed = JSON.parse(b64urlDecode(body)) as AdminTokenPayload;
  } catch {
    throw new AppError(ERROR_CODES.FORBIDDEN, "运营后台凭证载荷非法");
  }
  if (!parsed || typeof parsed !== "object" || parsed.role !== "admin" || !parsed.sub || parsed.exp <= nowUtcMs) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "运营后台登录已过期，请重新登录");
  }
  return parsed;
}

export interface AuditLogDoc {
  _id: string;
  actorUserId: string;
  action: string;
  targetId?: string;
  summary: string;
  createdAt: number;
}

export async function recordAdminAudit(
  db: DbAdapter,
  params: { actorUserId: string; action: string; targetId?: string; summary: string; nowUtcMs?: number },
): Promise<void> {
  await db.insert<AuditLogDoc>(COLLECTIONS.AUDIT_LOG, {
    _id: newAuditId(),
    actorUserId: params.actorUserId,
    action: params.action,
    targetId: params.targetId,
    summary: params.summary,
    createdAt: params.nowUtcMs ?? Date.now(),
  });
}
