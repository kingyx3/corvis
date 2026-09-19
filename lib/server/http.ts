import { AuthorizationError } from "@/core/enterprise";
import { DeletionExecutionError, LegalHoldError } from "@/lib/server/data-lifecycle";
import { FeatureFlagGovernanceError } from "@/lib/server/feature-flags";
import { InvalidCursorError } from "@/lib/server/pagination";
import { ConflictError, PublicationGateError } from "@/lib/server/platform";
import { ResearchCancelledError, ResearchProviderError, ResearchTimeoutError } from "@/lib/server/research";
import { AuthenticationError } from "@/lib/server/request-context";
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
  if (error instanceof WebhookSubscriptionError) {
    logEvent("warn", "webhook_subscription.denied", { correlationId }, { code: error.code });
    const status = error.code === "webhook_subscription_not_found" ? 404 : error.code === "webhook_subscription_transition_denied" ? 409 : 400;
    return json({ error: error.code, correlationId }, { status });
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
  logEvent("error", "api.unhandled_error", { correlationId }, { errorName: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "Unknown error" });
  return json({ error: "internal_error", correlationId }, { status: 500 });
}

export function correlationId(request: Request): string {
  return request.headers.get("x-correlation-id") || crypto.randomUUID();
}
