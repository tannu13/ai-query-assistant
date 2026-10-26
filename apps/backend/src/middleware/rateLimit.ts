import type { NextFunction, Request, Response } from 'express';

import { RateLimitedError } from '../lib/errors';

export interface RateLimitOptions {
  /** Maximum burst: how many requests are allowed back-to-back. */
  capacity: number;
  /** Sustained rate: tokens added per minute, up to `capacity`. */
  refillPerMinute: number;
  /**
   * Bucket key. Defaults to the client IP, which is the only thing available
   * on an unauthenticated route; protected routes pass the JWT subject so the
   * limit follows the account rather than the network path.
   */
  keyOf?: (req: Request) => string;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Above this many tracked keys, idle buckets are swept. An unbounded Map
 * keyed on client-controlled input is a slow memory exhaustion vector: a
 * spray of requests from many addresses costs the attacker nothing and the
 * process a bucket each.
 */
const SWEEP_THRESHOLD = 10_000;

/**
 * In-memory token bucket.
 *
 * Deliberately per-process and non-coordinating: with N tasks behind a load
 * balancer the effective limit is N x capacity, and a deploy resets every
 * bucket. That is acceptable for this exercise and wrong for production,
 * where the same algorithm belongs in Redis. It is listed as a known
 * limitation rather than left to be discovered.
 *
 * A factory rather than a singleton so each route can set its own budget and
 * each test can start from an empty bucket.
 */
export function createRateLimit(options: RateLimitOptions) {
  const { capacity, refillPerMinute, keyOf = defaultKeyOf } = options;
  const buckets = new Map<string, Bucket>();

  /**
   * Drops buckets that have refilled to capacity: a full bucket is
   * indistinguishable from one that was never used, so forgetting it changes
   * no decision. Called inline rather than on a `setInterval`, which would
   * hold the event loop open and leak a timer into every test.
   */
  function sweep(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      const refilled = refill(bucket, nowMs);
      if (refilled >= capacity) buckets.delete(key);
    }
  }

  function refill(bucket: Bucket, nowMs: number): number {
    const elapsedMinutes = (nowMs - bucket.lastRefillMs) / 60_000;
    return Math.min(capacity, bucket.tokens + elapsedMinutes * refillPerMinute);
  }

  return function rateLimit(req: Request, _res: Response, next: NextFunction): void {
    const nowMs = Date.now();
    if (buckets.size >= SWEEP_THRESHOLD) sweep(nowMs);

    const key = keyOf(req);
    const bucket = buckets.get(key) ?? { tokens: capacity, lastRefillMs: nowMs };
    const tokens = refill(bucket, nowMs);

    if (tokens < 1) {
      // Keep the bucket as-is: the refill clock must not restart on a
      // rejected request, or a client polling hard would never recover.
      buckets.set(key, { tokens, lastRefillMs: nowMs });
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(((1 - tokens) / refillPerMinute) * 60),
      );
      next(new RateLimitedError(retryAfterSeconds));
      return;
    }

    buckets.set(key, { tokens: tokens - 1, lastRefillMs: nowMs });
    next();
  };
}

/**
 * `req.ip` reflects the socket peer unless Express is told to trust a proxy.
 * Behind the ALB in the deployment plan that peer is the load balancer, which
 * would put every client in one bucket — so a production deployment must set
 * `trust proxy` and this comment is the reminder that it is a deployment
 * concern, not a code default. Trusting `X-Forwarded-For` unconditionally is
 * the opposite mistake: the header is forgeable, making the limit trivially
 * bypassable.
 */
function defaultKeyOf(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export default createRateLimit;
