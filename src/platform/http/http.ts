import { AuthorizationError } from "@/shared/domain/enterprise";
import { DeletionExecutionError, LegalHoldError } from "@/modules/governance/server/data-lifecycle";
import { FeatureFlagDeniedError, FeatureFlagGovernanceError } from "@/modules/admin/server/feature-flags";
import { IdempotencyKeyReuseError, InvalidIdempotencyKeyError } from "@/platform/http/idempotency";
import { InvalidCursorError, InvalidLimitError } from "@/platform/http/pagination";
import { ConflictError, PublicationGateError } from "@/platform/data/platform";
import { isTransientPostgresError } from "@/platform/database/postgres-native";
import { RateLimitError } from "@/platform/http/rate-limit";
import { ResearchCancelledError, ResearchProviderError, ResearchTimeoutError } from "@/modules/research/server/research";
import { AuthenticationError, SessionEndedByPolicyError } from "@/platform/http/request-context";
import { ConnectorGovernanceError } from "@/modules/sources/server/source-connectors";
import { TenantInvitationError } from "@/modules/identity-access/server/tenant-invitations";
import { adminSqlErrorClassification } from "@/platform/database/sql-application-errors";
import { UploadRequestError } from "@/modules/sources/server/uploads";
import { logEvent } from "@/platform/observability/telemetry";
import { rfc3339Replacer } from "@/platform/database/timestamps";
import { WebhookSubscriptionError } from "@/modules/delivery/server/webhook-subscriptions";

/** JSON response; Postgres timestamptz text anywhere in `data` is emitted as RFC 3339 (see timestamps.ts). */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data, rfc3339Replacer), { ...init, headers });
}

/** Seconds a client should wait before retrying after a transient database unavailability. */
export const DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The stable machine-readable reason of a 401 for a session the organization's policy ended (F7c, #336). */
export const SESSION_ENDED_BY_POLICY_ERROR = "session_ended_by_policy";

export function apiError(error: unknown, correlationId: string): Response {
  if (error instanceof SessionEndedByPolicyError) {
    // Distinguishable from `authentication_required` (a missing, invalid, revoked or foreign identity) so the person is told
    // why they must sign in again. Only reachable after the token verified and membership resolved, so it says nothing to
    // anyone who is not that member. The reason (idle vs maximum length) stays in the log, not in the response.
    logEvent("warn", "api.session_ended_by_policy", { correlationId }, { reason: error.reason });
    return json({ error: SESSION_ENDED_BY_POLICY_ERROR, correlationId }, { status: 401 });
  }
  if (error instanceof AuthenticationError) {
    logEvent("warn", "api.authentication_denied", { correlationId });
    return json({ error: "authentication_required", correlationId }, { status: 401 });
  }
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
  if (error instanceof TenantInvitationError) {
    logEvent("warn", "tenant_admin.request_denied", { correlationId }, { code: error.code });
    return json({ error: error.code, correlationId }, { status: error.status });
  }
  if (error instanceof IdempotencyKeyReuseError) {
    logEvent("warn", "api.idempotency_key_reused", { correlationId });
    return json({ error: error.code, correlationId }, { status: 422 });
  }
  if (error instanceof LegalHoldError) {
    logEvent("warn", "deletion.blocked_by_legal_hold", { correlationId }, { holds: error.holds });
    return json({ error: error.code, holds: error.holds, correlationId }, { status: 409 });
  }
  if (error instanceof DeletionExecutionError) {
    logEvent("warn", "deletion.execution_denied", { correlationId }, { code: error.code });
    return json({ error: error.code, correlationId }, { status: 422 });
  }
  if (error instanceof FeatureFlagGovernanceError) {
    logEvent("warn", "feature_flag.governance_denied", { correlationId }, { code: error.code });
    return json({ error: error.code, correlationId }, { status: 422 });
  }
  if (error instanceof FeatureFlagDeniedError) {
    logEvent("warn", "feature_flag.denied", { correlationId }, { key: error.key, channel: error.channel, reason: error.decisionReason });
    return json({ error: "feature_disabled", flagKey: error.key, reason: error.decisionReason, correlationId }, { status: 403 });
  }
  if (error instanceof WebhookSubscriptionError) {
    logEvent("warn", "webhook_subscription.denied", { correlationId }, { code: error.code });
    const status = error.code === "webhook_subscription_not_found" ? 404 : error.code === "webhook_subscription_transition_denied" || error.code === "webhook_subscription_limit_reached" ? 409 : 400;
    return json({ error: error.code, correlationId }, { status });
  }
  if (error instanceof ConnectorGovernanceError) {
    logEvent("warn", "source_connection.denied", { correlationId }, { code: error.code });
    const status = error.code === "connection_not_found" ? 404
      : error.code === "connection_revoked" || error.code.startsWith("invalid_transition_from_") ? 409
      : error.code === "unregistered_provider" ? 422
      : 400;
    return json({ error: error.code, correlationId }, { status });
  }
  if (error instanceof UploadRequestError) {
    logEvent("warn", "upload.request_denied", { correlationId }, { code: error.code });
    return json({ error: error.code, correlationId }, { status: error.status });
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
  if (error instanceof ResearchTimeoutError) {
    logEvent("warn", "research.timeout", { correlationId });
    return json({ error: error.code, correlationId }, { status: 504 });
  }
  if (error instanceof ResearchCancelledError) {
    logEvent("info", "research.cancelled", { correlationId });
    return json({ error: error.code, correlationId }, { status: 499 });
  }
  if (error instanceof ResearchProviderError) {
    logEvent("error", "research.provider_error", { correlationId }, { provider: error.provider, status: error.status ?? null });
    return json({ error: error.code, correlationId }, { status: 502 });
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
