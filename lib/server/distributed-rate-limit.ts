import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { PostgresDriverError } from "./postgres-native.ts";
import { RateLimitError, enforceRateLimit, type RateLimiter } from "./rate-limit.ts";
import { AuthenticationError } from "./request-context.ts";

/**
 * SQLSTATEs that mean the *claimed* identity cannot own a budget row, not that
 * the database is unhealthy: 23503 (the tenant selector names no tenant, via
 * api_rate_limit's tenant FK), 22P02 (the selector is not a uuid) and 23514
 * (the subject violates the length check). Rate limiting runs before the
 * authoritative membership lookup, so these must surface as an authentication
 * failure (401), never as an unhandled 500.
 */
const UNKNOWN_IDENTITY_SQLSTATES = new Set(["23503", "22P02", "23514"]);

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
  let rows;
  try {
    rows = await db.query(
      "select allowed, retry_after_seconds from corvis_control.consume_api_rate_limit($1::uuid,$2,$3)",
      [tenantId, subject, config.rateLimitRequestsPerMinute],
    );
  } catch (error) {
    if (error instanceof PostgresDriverError && error.phase === "query" && UNKNOWN_IDENTITY_SQLSTATES.has(error.code)) {
      throw new AuthenticationError("No active authoritative authorization context");
    }
    throw error;
  }
  const row = rows[0];
  if (!row || typeof row.allowed !== "boolean") throw new Error("Invalid rate-limit database response");
  if (!row.allowed) {
    const seconds = Number(row.retry_after_seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error("Invalid rate-limit retry interval");
    throw new RateLimitError(seconds);
  }
}
