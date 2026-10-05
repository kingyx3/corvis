import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// http.ts imports route-facing modules through the Next.js "@/..." alias.
register(new URL("../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const { apiError, correlationId, SESSION_ENDED_BY_POLICY_ERROR } = await import("@/platform/http/http");
const { AuthenticationError, SessionEndedByPolicyError } = await import("@/platform/http/request-context");
const { IdempotencyKeyReuseError, InvalidIdempotencyKeyError } = await import("@/platform/http/idempotency");
const { TenantInvitationError } = await import("@/modules/identity-access/server/tenant-invitations");
const { WebhookSubscriptionError } = await import("@/modules/delivery/server/webhook-subscriptions");

function withCorrelation(value: string): Request {
  return new Request("https://corvis.test/api/v1/me", { headers: { "x-correlation-id": value } });
}

test("correlationId echoes a bounded log-safe client id", () => {
  assert.equal(correlationId(withCorrelation("corr-1.a:b_C")), "corr-1.a:b_C");
});

test("correlationId replaces oversized or unsafe client ids instead of reflecting them", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const value of ["x".repeat(129), "evil id with spaces", "<script>", "a\"b"]) {
    assert.match(correlationId(withCorrelation(value)), uuid);
  }
  assert.match(correlationId(new Request("https://corvis.test/")), uuid);
});

test("a malformed JSON request body is a 400 invalid_json, not a 500", async () => {
  const request = new Request("https://corvis.test/api/v1/exports", { method: "POST", body: "{not json" });
  const error = await request.json().then(() => undefined, (reason: unknown) => reason);
  const response = apiError(error, "corr-json");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json", correlationId: "corr-json" });
  // Unrelated failures still fall through to the opaque 500.
  const internal = apiError(new Error("boom select * from secret"), "corr-2");
  assert.equal(internal.status, 500);
  assert.deepEqual(await internal.json(), { error: "internal_error", correlationId: "corr-2" });
});

test("an invalid idempotency key is a 400 with a stable code, not a 500", async () => {
  const response = apiError(new InvalidIdempotencyKeyError(), "corr-1");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_idempotency_key", correlationId: "corr-1" });
});

test("reusing an idempotency key for a different request is a 422, not a replay or a 500", async () => {
  const response = apiError(new IdempotencyKeyReuseError(), "corr-reuse");
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "idempotency_key_reused", correlationId: "corr-reuse" });
});

test("expected tenant-admin request errors keep their own 4xx status instead of a 500", async () => {
  const response = apiError(new TenantInvitationError("invitation_not_pending", 409), "corr-tenant");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "invitation_not_pending", correlationId: "corr-tenant" });
});

test("webhook subscription limits map to 409 (count cap) and 400 (URL length)", async () => {
  const cap = apiError(new WebhookSubscriptionError("webhook_subscription_limit_reached"), "corr-cap");
  assert.equal(cap.status, 409);
  assert.deepEqual(await cap.json(), { error: "webhook_subscription_limit_reached", correlationId: "corr-cap" });
  const long = apiError(new WebhookSubscriptionError("endpoint_url_too_long"), "corr-long");
  assert.equal(long.status, 400);
  assert.deepEqual(await long.json(), { error: "endpoint_url_too_long", correlationId: "corr-long" });
});

const { PostgresDriverError } = await import("@/platform/database/postgres-native");

test("database connection failures and timeouts are a retryable 503, not a 500", async () => {
  for (const error of [
    new PostgresDriverError("connection", "CONNECT_TIMEOUT"),
    new PostgresDriverError("connection", "ECONNREFUSED"),
    new PostgresDriverError("query", "QUERY_TIMEOUT"),
  ]) {
    const response = apiError(error, "corr-db");
    assert.equal(response.status, 503, error.message);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.deepEqual(await response.json(), { error: "service_unavailable", correlationId: "corr-db" });
  }
  // An ordinary failed query stays an opaque 500 and carries no Retry-After.
  const query = apiError(new PostgresDriverError("query", "42P01"), "corr-q");
  assert.equal(query.status, 500);
  assert.equal(query.headers.get("retry-after"), null);
});

test("admin SQL business errors map to their own 4xx status instead of a 500", async () => {
  const cases: Array<[unknown, number, string]> = [
    [new PostgresDriverError("query", "P0001", "disabled identity requires explicit reactivation"), 409, "identity_disabled"],
    [new PostgresDriverError("query", "P0001", "tenant_admin_role_requires_tenant_admin_actor"), 403, "tenant_admin_role_requires_tenant_admin_actor"],
    [new PostgresDriverError("query", "P0001", "support access cannot be self-approved"), 403, "support_access_self_approval_denied"],
    [new PostgresDriverError("query", "P0001", "subject user not found"), 404, "subject_user_not_found"],
    [new PostgresDriverError("query", "P0001", "invalid data-right effective dates"), 400, "invalid_request"],
    // Non-native drivers and fakes are matched on the raw message, longest fragment first.
    [new Error("active support workspace not found"), 404, "support_workspace_not_found"],
  ];
  for (const [error, status, code] of cases) {
    const response = apiError(error, "corr-sql");
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code, correlationId: "corr-sql" });
  }
  // A native driver error with no allowlisted fragment never falls back to message matching.
  assert.equal(apiError(new PostgresDriverError("query", "P0001"), "corr-x").status, 500);
});

test("F7c: a session the organization's policy ended is a 401 with its own stable code, never the generic one, and never says which limit", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => { lines.push(String(line)); });
  for (const reason of ["idle_timeout", "max_session"] as const) {
    const response = apiError(new SessionEndedByPolicyError(reason), "corr-ended");
    assert.equal(response.status, 401);
    assert.equal(SESSION_ENDED_BY_POLICY_ERROR, "session_ended_by_policy");
    assert.deepEqual(await response.json(), { error: "session_ended_by_policy", correlationId: "corr-ended" });
  }
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as { reason: string }).reason), ["idle_timeout", "max_session"], "the reason is logged");
  // A missing, invalid, revoked or foreign identity keeps the generic code, so the response does not say whether an account exists.
  const generic = apiError(new AuthenticationError("No active authoritative authorization context"), "corr-generic");
  assert.equal(generic.status, 401);
  assert.deepEqual(await generic.json(), { error: "authentication_required", correlationId: "corr-generic" });
});
