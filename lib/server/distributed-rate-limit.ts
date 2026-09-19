import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { RateLimitError, enforceRateLimit, type RateLimiter } from "./rate-limit.ts";

/** Production counters live in Postgres, shared by every Cloud Run instance.
 * Database failure deliberately fails closed; never fall back to local counters.
 */
export async function enforceRequestRateLimit(
  tenantId: string,
  subject: string,
  options: { limiter?: RateLimiter; now?: number; db?: PostgresSqlApi } = {},
): Promise<void> {
  const config = getServerConfig();
  if (config.environment !== "production" && !options.db) {
    enforceRateLimit(JSON.stringify([tenantId, subject]), options);
    return;
  }
  const db = options.db ?? postgres(config.postgresDsn);
  const rows = await db.query(
    "select allowed, retry_after_seconds from corvis_control.consume_api_rate_limit($1::uuid,$2,$3)",
    [tenantId, subject, config.rateLimitRequestsPerMinute],
  );
  const row = rows[0];
  if (!row || typeof row.allowed !== "boolean") throw new Error("Invalid rate-limit database response");
  if (!row.allowed) {
    const seconds = Number(row.retry_after_seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error("Invalid rate-limit retry interval");
    throw new RateLimitError(seconds);
  }
}
