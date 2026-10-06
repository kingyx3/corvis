import { AuthorizationError } from "@/shared/domain/enterprise";
import { IdempotencyKeyReuseError, InvalidIdempotencyKeyError } from "@/platform/http/limits/idempotency";
import { isApiProblemSource } from "@/platform/http/api/api-problem";
import { InvalidCursorError, InvalidLimitError } from "@/platform/http/api/pagination";
import { ConflictError, PublicationGateError } from "@/platform/data/platform";
import { isTransientPostgresError } from "@/platform/database/postgres-native";
import { RateLimitError } from "@/platform/http/limits/rate-limit";
import { adminSqlErrorClassification } from "@/platform/database/sql-application-errors";
import { logEvent } from "@/platform/observability/telemetry";
import { rfc3339Replacer } from "@/platform/database/timestamps";

/** JSON response; Postgres timestamptz text anywhere in `data` is emitted as RFC 3339 (see timestamps.ts). */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data, rfc3339Replacer), { ...init, headers });
}

/** Seconds a client should wait before retrying after a transient database unavailability. */
export const DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export function apiError(error: unknown, correlationId: string): Response {
  if (error instanceof AuthorizationError) {
    logEvent("warn", "api.authorization_denied", { correlationId }, { requiredPermission: error.requiredPermission });
    return json({ error: "forbidden", correlationId }, { status: 403 });
  }
  if (error instanceof RateLimitError) {
    logEvent("warn", "api.rate_limited", { correlationId }, { retryAfterSeconds: error.retryAfterSeconds });
    return json({ error: "rate_limited", correlationId }, {
      status: 429,
      headers: { "retry-after": String(error.retryAfterSeconds) },
    });
  }
  if (error instanceof ConflictError) {
    logEvent("warn", "api.conflict", { correlationId }, { code: error.code });
    return json({ error: error.code, correlationId }, { status: 409 });
  }
  if (error instanceof PublicationGateError) {
    logEvent("warn", "snapshot.publication_blocked", { correlationId }, { reasons: error.reasons });
    return json({ error: "publication_blocked", reasons: error.reasons, correlationId }, { status: 409 });
  }
  if (error instanceof InvalidCursorError) {
    logEvent("warn", "api.invalid_pagination", { correlationId });
    return json({ error: "invalid_cursor", correlationId }, { status: 400 });
  }
  if (error instanceof InvalidLimitError) {
    logEvent("warn", "api.invalid_pagination", { correlationId });
    return json({ error: "invalid_limit", correlationId }, { status: 400 });
  }
  if (error instanceof InvalidIdempotencyKeyError) {
    logEvent("warn", "api.invalid_idempotency_key", { correlationId });
    return json({ error: error.code, correlationId }, { status: 400 });
  }
  if (error instanceof IdempotencyKeyReuseError) {
    logEvent("warn", "api.idempotency_key_reused", { correlationId });
    return json({ error: error.code, correlationId }, { status: 422 });
  }
  // Errors owned by a module describe their own response (see api-problem.ts).
  if (isApiProblemSource(error)) {
    const problem = error.toApiProblem();
    logEvent(problem.log.level, problem.log.event, { correlationId }, problem.log.fields);
    return json({ ...problem.body, correlationId }, { status: problem.status });
  }
  if (isTransientPostgresError(error)) {
    logEvent("error", "api.database_unavailable", { correlationId }, { phase: error.phase, code: error.code });
    return json({ error: "service_unavailable", correlationId }, {
      status: 503,
      headers: { "retry-after": String(DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS) },
    });
  }
  // Business outcomes raised by the admin SQL functions (identity lifecycle,
  // access policy, support access) are client errors, not internal faults.
  const sqlOutcome = adminSqlErrorClassification(error);
  if (sqlOutcome) {
    logEvent("warn", "admin.sql_request_denied", { correlationId }, { code: sqlOutcome.code });
    return json({ error: sqlOutcome.code, correlationId }, { status: sqlOutcome.status });
  }
  // `await request.json()` on a malformed body rejects with a SyntaxError;
  // that is a client error, not a server fault.
  if (error instanceof SyntaxError) {
    logEvent("warn", "api.invalid_json", { correlationId });
    return json({ error: "invalid_json", correlationId }, { status: 400 });
  }
  logEvent("error", "api.unhandled_error", { correlationId }, { errorName: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "Unknown error" });
  return json({ error: "internal_error", correlationId }, { status: 500 });
}

// A client-supplied correlation id is echoed in every response body and log
// record, so only a bounded, log-safe token is accepted; anything else is
// replaced rather than propagated.
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function correlationId(request: Request): string {
  const supplied = request.headers.get("x-correlation-id");
  return supplied && CORRELATION_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
}
