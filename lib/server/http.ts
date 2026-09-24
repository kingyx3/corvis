import { AuthorizationError } from "@/core/enterprise";
import { DeletionExecutionError, LegalHoldError } from "@/lib/server/data-lifecycle";
import { FeatureFlagDeniedError, FeatureFlagGovernanceError } from "@/lib/server/feature-flags";
import { InvalidIdempotencyKeyError } from "@/lib/server/idempotency";
import { InvalidCursorError } from "@/lib/server/pagination";
import { ConflictError, PublicationGateError } from "@/lib/server/platform";
import { RateLimitError } from "@/lib/server/rate-limit";
import { ResearchCancelledError, ResearchProviderError, ResearchTimeoutError } from "@/lib/server/research";
import { AuthenticationError } from "@/lib/server/request-context";
import { ConnectorGovernanceError } from "@/lib/server/source-connectors";
import { UploadRequestError } from "@/lib/server/uploads";
import { logEvent } from "@/lib/server/telemetry";
import { WebhookSubscriptionError } from "@/lib/server/webhook-subscriptions";

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(init.headers || {}),
    },
  });
}

export function apiError(error: unknown, correlationId: string): Response {
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
  if (error instanceof InvalidIdempotencyKeyError) {
    logEvent("warn", "api.invalid_idempotency_key", { correlationId });
    return json({ error: error.code, correlationId }, { status: 400 });
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
    const status = error.code === "webhook_subscription_not_found" ? 404 : error.code === "webhook_subscription_transition_denied" ? 409 : 400;
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
