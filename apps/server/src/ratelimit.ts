import type { Request, Response, NextFunction } from "express";
import { redis } from "./db.js";
import type { AuthedRequest } from "./middleware.js";

/**
 * Fixed-window rate limiter backed by Redis (rules.md §3.7).
 * Keyed by userId when authenticated, else client IP.
 */
export function rateLimit(opts: { windowSec: number; max: number; scope: string }) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const id = req.userId ?? req.ip ?? "anon";
    const key = `ratelimit:${opts.scope}:${id}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, opts.windowSec);
      if (count > opts.max) {
        const ttl = await redis.ttl(key);
        res.setHeader("Retry-After", String(Math.max(ttl, 1)));
        return res.status(429).json({ error: "Too many requests — please slow down." });
      }
      next();
    } catch {
      // Fail open: never block traffic because the limiter backend hiccuped.
      next();
    }
  };
}

/**
 * Socket-side check (returns true if allowed). Used for chat flood control.
 * `cost` lets a heavier action consume more than one slot of the same budget
 * (e.g. a perf run is N executions, so it costs more than a single run).
 */
export async function socketRateOk(scope: string, userId: string, windowSec: number, max: number, cost = 1) {
  const key = `ratelimit:${scope}:${userId}`;
  try {
    const count = await redis.incrby(key, cost);
    // First increment in this window — start the TTL.
    if (count <= cost) await redis.expire(key, windowSec);
    return count <= max;
  } catch {
    return true;
  }
}
