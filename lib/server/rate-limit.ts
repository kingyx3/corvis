import { getServerConfig } from "./config.ts";

/**
 * Development/test process-local request budget for
 * app/api/v1. This sits underneath Cloudflare's edge rate limiting; it does
 * not replace it. Production uses distributed-rate-limit.ts and Postgres.
 *
 * A fixed-window counter is used (not a sliding window) for simplicity and
 * predictable, easily-tested reset semantics: a window opens on first use of
 * a key and the count resets once `windowMs` has elapsed since that window
 * started.
 */

export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Every distinct (tenant, subject) key used to stay in memory forever. Once
 * this many keys are tracked, a new key first evicts all expired windows.
 */
export const SWEEP_THRESHOLD = 10_000;

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Rate limit exceeded");
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

type Bucket = { windowStart: number; count: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number = RATE_LIMIT_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records one request against `key` and reports whether it is allowed. */
  consume(key: string, now: number = Date.now()): RateLimitDecision {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      if (!bucket && this.buckets.size >= SWEEP_THRESHOLD) this.sweep(now);
      this.buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true };
    }
    if (bucket.count < this.limit) {
      bucket.count += 1;
      return { allowed: true };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStart + this.windowMs - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  /** Number of identities currently tracked. */
  get size(): number {
    return this.buckets.size;
  }

  /** Drops buckets whose window has elapsed; they would be reset on next use anyway. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
    }
  }

  /** Test-only escape hatch to drop accumulated state between cases. */
  reset(): void {
    this.buckets.clear();
  }
}

let sharedLimiter: RateLimiter | undefined;

/** The process-wide limiter used by development/test request handling. */
export function tenantRateLimiter(): RateLimiter {
  if (!sharedLimiter) {
    sharedLimiter = new RateLimiter(getServerConfig().rateLimitRequestsPerMinute, RATE_LIMIT_WINDOW_MS);
  }
  return sharedLimiter;
}

/**
 * Enforces the per-tenant/per-service-account budget for `key`, throwing a
 * `RateLimitError` (carrying `Retry-After` seconds) once it is exhausted.
 */
export function enforceRateLimit(key: string, options: { limiter?: RateLimiter; now?: number } = {}): void {
  const limiter = options.limiter ?? tenantRateLimiter();
  const decision = limiter.consume(key, options.now);
  if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
}
