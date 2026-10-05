import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { RateLimiter, enforceRateLimit } from "../../../../platform/http/limits/rate-limit.ts";

/**
 * The per-administrator budget for starting a source connection (B1d): a credential connect, an OAuth start, or the
 * start of an OAuth reauthorization. It sits under the per-tenant API budget every request already spends
 * (src/platform/http/limits/distributed-rate-limit.ts) and exists because each attempt writes a secret and calls a provider: an
 * administrator (or a stolen session) must not be able to loop on it. The counter is process-local, like the SCIM and
 * development limiters; Cloudflare's edge limiting and the shared API budget remain the cross-instance control.
 * Finishing a sign-in (`oauth/complete`) is not counted again: it can only consume an attempt that was counted when it started.
 */
export const SOURCE_CONNECT_ATTEMPTS_PER_WINDOW = 10;
export const SOURCE_CONNECT_WINDOW_MS = 10 * 60 * 1000;

// On `globalThis` so `next dev` re-evaluating this module does not hand every administrator a fresh budget.
const shared = globalThis as typeof globalThis & { sourceConnectLimiter?: RateLimiter };
let override: RateLimiter | undefined;

/** Pins a limiter (or, with no argument, restores the shared one). Used by tests that make many attempts or probe the limit. */
export function overrideSourceConnectLimiter(limiter?: RateLimiter): void { override = limiter; }

/** Spends one attempt for this administrator, throwing `RateLimitError` (429 with `Retry-After`) once the window's budget is gone. */
export function enforceSourceConnectAttemptLimit(identity: RequestIdentity, now?: number): void {
  const limiter = override ?? (shared.sourceConnectLimiter ??= new RateLimiter(SOURCE_CONNECT_ATTEMPTS_PER_WINDOW, SOURCE_CONNECT_WINDOW_MS));
  enforceRateLimit(JSON.stringify([identity.tenantId, identity.subject]), { limiter, now });
}
