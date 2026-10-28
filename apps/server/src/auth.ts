import jwt from "jsonwebtoken";
import argon2 from "argon2";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { redis } from "./db.js";
import { AuditLog } from "./models.js";

export interface AccessPayload {
  sub: string; // userId
  jti: string;
}

export async function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

export function signAccessToken(userId: string): string {
  const jti = nanoid();
  return jwt.sign({ sub: userId, jti } satisfies AccessPayload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtl,
  });
}

/** Every live refresh session for one user, so all of them can be revoked at once. */
const userSessionsKey = (userId: string) => `usersessions:${userId}`;

export async function issueRefreshToken(userId: string): Promise<string> {
  const jti = nanoid(32);
  const token = jwt.sign({ sub: userId, jti }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshTtl,
  });
  // Store the refresh session in Redis so it can be revoked (schema.md §3), and
  // index it under the user so offboarding can revoke every session at once
  // rather than only the one that happens to present itself.
  await redis.set(`session:${jti}`, userId, "EX", config.jwt.refreshTtl);
  await redis.sadd(userSessionsKey(userId), jti);
  await redis.expire(userSessionsKey(userId), config.jwt.refreshTtl);
  return token;
}

/**
 * Immediate account suspension.
 *
 * The database `status` is the source of truth and is checked wherever a token
 * is *issued* (sign-in, SSO, refresh). This Redis marker exists because an
 * access token is verified locally with no database read, so without it a
 * deprovisioned user would keep working for up to the access-token lifetime.
 * If Redis is ever lost the marker goes with it, but no new token can be
 * issued, so the exposure is bounded by that same lifetime.
 */
const SUSPENDED_SET = "suspended:users";

export async function markSuspended(userId: string, suspended: boolean): Promise<void> {
  if (suspended) await redis.sadd(SUSPENDED_SET, userId);
  else await redis.srem(SUSPENDED_SET, userId);
}

export async function isSuspended(userId: string): Promise<boolean> {
  return (await redis.sismember(SUSPENDED_SET, userId)) === 1;
}

/** Drop every refresh session a user holds. Used when access is withdrawn. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const key = userSessionsKey(userId);
  const jtis = await redis.smembers(key);
  if (jtis.length) await redis.del(...jtis.map((j) => `session:${j}`));
  await redis.del(key);
  return jtis.length;
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, config.jwt.accessSecret) as AccessPayload;
}

export async function verifyRefreshToken(token: string): Promise<string | null> {
  try {
    const payload = jwt.verify(token, config.jwt.refreshSecret) as { sub: string; jti: string };
    const stored = await redis.get(`session:${payload.jti}`);
    if (!stored || stored !== payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function revokeRefreshToken(token: string): Promise<void> {
  try {
    const payload = jwt.decode(token) as { jti?: string; sub?: string } | null;
    if (payload?.jti) await redis.del(`session:${payload.jti}`);
    if (payload?.jti && payload?.sub) await redis.srem(userSessionsKey(payload.sub), payload.jti);
  } catch {
    /* ignore */
  }
}

/**
 * Client IP for an audit entry. `x-forwarded-for` is only honoured when the
 * deployment says it sits behind a trusted proxy — otherwise any client could
 * forge the header and poison the audit trail.
 */
export function clientIp(req: {
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
  ip?: string;
}): string | undefined {
  if (config.trustProxy) {
    const fwd = req.headers?.["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : String(fwd ?? "")).split(",")[0]?.trim();
    if (first) return first;
  }
  const raw = req.ip ?? req.socket?.remoteAddress ?? undefined;
  // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1) to plain IPv4.
  return raw?.replace(/^::ffff:/, "");
}

/** Append-only audit entry (rules.md §3.8). Fire-and-forget safe. */
export async function audit(entry: {
  workspaceId?: string;
  actorId?: string;
  action: string;
  target?: unknown;
  meta?: unknown;
  ip?: string;
}): Promise<void> {
  try {
    await AuditLog.create(entry);
  } catch (err) {
    console.error("[audit] failed", err);
  }
}
