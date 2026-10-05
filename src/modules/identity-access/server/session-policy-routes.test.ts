import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { SessionPolicyView } from "../domain/session-policy.ts";
import { PostgresDriverError } from "../../../platform/database/postgres-native.ts";
import { trustedIdentityHeaders } from "../../../test-support/identity-assertion.ts";
import "../../../test-support/http-sql-driver.ts";

// Route handlers use the Next.js "@/..." alias; see src/platform/http/http.test.ts.
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

// The Postgres path: a non-demo identity through the trusted gateway, with an HTTP SQL test double that records every
// statement. Nothing here talks to a real database; db/postgres/tests/session-policy.sql covers the SQL itself.
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const USER = "9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const GATEWAY_SECRET = "session-policy-gateway-secret";

process.env.CORVIS_DEMO_MODE = "";
process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = GATEWAY_SECRET;
process.env.CORVIS_DATABASE_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
process.env.CORVIS_AUTH_ISSUER = "https://login.example.test";
console.warn = console.info = console.error = () => undefined;

type Query = { sql: string; parameters: unknown[] };
const queries: Query[] = [];
let respond: (query: Query) => unknown[] = () => [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_DATABASE_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as Query;
  const query = { sql: sql.trim(), parameters };
  queries.push(query);
  return new Response(JSON.stringify({ rows: respond(query) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { GET: policyGet, PUT: policyPut } = await import("@/app/api/v1/access/session-policy/route");
const { POST: signOutPost } = await import("@/app/api/v1/access/session-policy/sign-out/route");
const { createSessionPolicyService, overrideSessionPolicyService, postgresSessionPolicyService, sessionPolicyService } = await import("./session-policy.ts");
const { DataGovernanceError } = await import("../../governance/server/data-governance.ts");
const { SessionPolicyValidationError } = await import("../domain/session-policy.ts");

type Caller = { roles?: string; subject?: string; method?: string; body?: unknown; unauthenticated?: boolean; rawBody?: string };
let sequence = 0;
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const method = caller.method ?? "GET";
  const hasBody = caller.body !== undefined || caller.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-correlation-id": `corr-session-policy-${sequence}`,
      ...(caller.unauthenticated ? {} : {
        ...trustedIdentityHeaders(GATEWAY_SECRET, { subject: caller.subject ?? "idp|alex", tenantId: TENANT, workspaceId: WORKSPACE, roles: caller.roles ?? "admin" }),
      }),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? (caller.rawBody ?? JSON.stringify(caller.body)) : undefined,
  });
}
const seed = (handler: (query: Query) => unknown[] = () => []) => { queries.length = 0; respond = handler; };
const errorOf = async (response: Response) => ((await response.json()) as { error?: string }).error;
const isAudit = (query: Query) => /insert into corvis_control\.audit_event/.test(query.sql);

const update = { idleTimeoutMinutes: 30, maxSessionMinutes: 480, expectedVersion: 0, reason: "Align with our policy" };
const policyRow = { idle_timeout_minutes: 30, max_session_minutes: 480, version: 1, updated_at: "2026-10-03 09:00:00+00", updated_by_subject: "idp|alex" };

test("the Postgres service is selected outside demo mode", () => {
  assert.equal(sessionPolicyService(), postgresSessionPolicyService);
});

test("every route refuses a caller with no credentials, and a role without admin:manage, before touching data", async () => {
  const runs: Array<[string, (extra: Caller) => Promise<Response>]> = [
    ["view", (extra) => policyGet(request("/access/session-policy", extra))],
    ["update", (extra) => policyPut(request("/access/session-policy", { method: "PUT", body: update, ...extra }))],
    ["sign-out", (extra) => signOutPost(request("/access/session-policy/sign-out", { method: "POST", body: { userId: USER, reason: "Left the firm" }, ...extra }))],
  ];
  for (const [name, run] of runs) {
    seed();
    assert.equal((await run({ unauthenticated: true })).status, 401, name);
    for (const roles of ["analyst", "reviewer", "read_only", "api_client"]) {
      const denied = await run({ roles });
      assert.equal(denied.status, 403, `${name} as ${roles}`);
      assert.equal(await errorOf(denied), "forbidden");
    }
    assert.equal(queries.length, 0, `${name} touches no data before authorizing`);
  }
});

test("an Organization Admin reads the view, scoped to their own tenant", async () => {
  seed((query) => {
    if (/from corvis_control\.tenant_session_policy where/.test(query.sql)) return [policyRow];
    if (/make_interval/.test(query.sql)) return [{ user_id: USER, label: "alex@example.test", is_current: true, active_sessions: 1 }];
    return [];
  });
  const response = await policyGet(request("/access/session-policy"));
  assert.equal(response.status, 200);
  const { data } = await response.json() as { data: SessionPolicyView };
  assert.deepEqual([data.policy.idleTimeoutMinutes, data.policy.version, data.identityProvider.issuer, data.members[0]!.isCurrentUser], [30, 1, "https://login.example.test", true]);
  assert.equal(queries.every((query) => query.parameters[0] === TENANT && /^select/i.test(query.sql)), true, "read-only and tenant-scoped");
  assert.equal(queries.some(isAudit), false, "reading is not a mutation");
});

test("changing the policy writes the change, its audit event and the security notice, attributed to the caller and the tenant from the identity", async () => {
  seed((query) => (/set_tenant_session_policy/.test(query.sql) ? [policyRow] : []));
  const response = await policyPut(request("/access/session-policy", { method: "PUT", body: { ...update, tenantId: "someone-else" } }));
  assert.equal(response.status, 200);
  const { data } = await response.json() as { data: { version: number; idleTimeoutMinutes: number } };
  assert.deepEqual([data.version, data.idleTimeoutMinutes], [1, 30]);
  assert.deepEqual(queries.find((query) => /set_tenant_session_policy/.test(query.sql))!.parameters, [TENANT, "oidc", "idp|alex", 30, 480, 0, null, null, null]);
  const audit = queries.find(isAudit)!;
  for (const expected of ["access.session_policy.updated", "session_policy", "idp|alex", TENANT]) assert.ok(audit.parameters.includes(expected), expected);
  assert.ok(JSON.stringify(audit.parameters).includes("Align with our policy"), "the reason is audited");
  const notice = queries.find((query) => /insert into corvis_control\.email_outbox/.test(query.sql))!;
  assert.ok(notice, "Organization Admins are sent a security notice");
  assert.ok(notice.parameters.includes("security_policy"));
});

test("F7a: Require SSO is stated as a boolean or left out; anything else is refused before any SQL runs, and a valid value reaches SQL with the actor's verified claims", async () => {
  for (const requireSso of ["true", 1, null, {}]) {
    seed();
    const response = await policyPut(request("/access/session-policy", { method: "PUT", body: { ...update, requireSso } }));
    assert.equal(response.status, 400, JSON.stringify(requireSso));
    assert.equal(await errorOf(response), "invalid_require_sso");
    assert.equal(queries.length, 0);
  }
  seed((query) => (/set_tenant_session_policy/.test(query.sql) ? [{ ...policyRow, require_sso: true }] : []));
  const response = await policyPut(request("/access/session-policy", { method: "PUT", body: { ...update, requireSso: true } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { data: { requireSso: boolean } }).data.requireSso, true);
  assert.deepEqual(queries.find((query) => /set_tenant_session_policy/.test(query.sql))!.parameters.slice(6), [true, null, null]);
});

test("a change that changes nothing is neither audited nor announced", async () => {
  seed((query) => (/tenant_session_policy/.test(query.sql) ? [policyRow] : []));
  const response = await policyPut(request("/access/session-policy", { method: "PUT", body: { ...update, expectedVersion: 1 } }));
  assert.equal(response.status, 200);
  assert.equal(queries.some(isAudit), false);
  assert.equal(queries.some((query) => /email_outbox/.test(query.sql)), false);
});

test("a malformed or out-of-bounds change is refused with a stable code before any SQL runs", async () => {
  const cases: Array<[unknown, string]> = [
    [{ ...update, idleTimeoutMinutes: 5 }, "invalid_idle_timeout"],
    [{ ...update, idleTimeoutMinutes: 9999 }, "invalid_idle_timeout"],
    [{ ...update, maxSessionMinutes: 20000 }, "invalid_max_session"],
    [{ ...update, idleTimeoutMinutes: 400, maxSessionMinutes: 60 }, "idle_exceeds_max_session"],
    [{ ...update, expectedVersion: undefined }, "invalid_version"],
    [{ ...update, reason: "" }, "invalid_reason"],
    [{ idleTimeoutMinutes: 30 }, "invalid_request"],
  ];
  for (const [body, code] of cases) {
    seed();
    const response = await policyPut(request("/access/session-policy", { method: "PUT", body }));
    assert.equal(response.status, 400, code);
    assert.equal(await errorOf(response), code);
    assert.equal(queries.length, 0, `${code}: nothing reached the database`);
  }
  seed();
  assert.equal(await errorOf(await policyPut(request("/access/session-policy", { method: "PUT", rawBody: "not json" }))), "invalid_request");
});

test("signing a user out records who, why and how many sessions ended, and notifies Organization Admins", async () => {
  seed((query) => (/sign_out_user_everywhere/.test(query.sql) ? [{ revoked: 2 }] : /identity_subject s/.test(query.sql) ? [{ label: "morgan.lee@example.test" }] : []));
  const response = await signOutPost(request("/access/session-policy/sign-out", { method: "POST", body: { userId: USER.toUpperCase(), reason: "Left the firm", tenantId: "someone-else" } }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { data: unknown }).data, { userId: USER, label: "morgan.lee@example.test", revokedSessions: 2, idpEndSessionEndpoint: null });
  assert.deepEqual(queries.find((query) => /sign_out_user_everywhere/.test(query.sql))!.parameters, [TENANT, "oidc", "idp|alex", USER, "Left the firm"]);
  const audit = queries.find(isAudit)!;
  for (const expected of ["access.session.signed_out_everywhere", "user_sessions", USER]) assert.ok(audit.parameters.includes(expected), expected);
  assert.ok(queries.some((query) => /email_outbox/.test(query.sql)));
});

test("a malformed sign-out is refused before any SQL runs", async () => {
  for (const [body, code] of [[{ reason: "Left the firm" }, "invalid_user"], [{ userId: "x", reason: "Left the firm" }, "invalid_user"], [{ userId: USER }, "invalid_reason"], [undefined, "invalid_request"]] as const) {
    seed();
    const response = await signOutPost(request("/access/session-policy/sign-out", { method: "POST", ...(body === undefined ? { rawBody: "[]" } : { body }) }));
    assert.equal(response.status, 400, code);
    assert.equal(await errorOf(response), code);
    assert.equal(queries.length, 0);
  }
});

test("refusals from the database surface as their stable codes, not as a 500", async () => {
  const refusals: Array<[string, number, string]> = [
    ["session policy requires an active organization admin", 403, "tenant_admin_required"],
    ["session policy bounds exceeded", 400, "session_policy_out_of_bounds"],
    ["session policy version conflict", 409, "session_policy_version_conflict"],
    ["session sign-out cannot target current user", 409, "cannot_sign_out_current_user"],
    ["session sign-out target not found", 404, "member_not_found"],
    ["session policy sso needs token binding", 409, "sso_requires_token_binding"],
    ["session policy sso would lock out current session", 409, "sso_would_lock_out_current_session"],
  ];
  const failing = (message: string) => createSessionPolicyService({
    demo: true,
    view: async () => { throw new Error("boom"); },
    update: async () => { throw new PostgresDriverError("query", "P0001", message as never); },
    signOut: async () => { throw new PostgresDriverError("query", "P0001", message as never); },
  });
  try {
    for (const [message, status, code] of refusals) {
      overrideSessionPolicyService(failing(message));
      seed();
      const updated = await policyPut(request("/access/session-policy", { method: "PUT", body: update }));
      assert.deepEqual([updated.status, await errorOf(updated)], [status, code], `update: ${message}`);
      const signedOut = await signOutPost(request("/access/session-policy/sign-out", { method: "POST", body: { userId: USER, reason: "Left the firm" } }));
      assert.deepEqual([signedOut.status, await errorOf(signedOut)], [status, code], `sign-out: ${message}`);
    }
    const broken = await policyGet(request("/access/session-policy"));
    assert.equal(broken.status, 500);
    overrideSessionPolicyService(createSessionPolicyService({
      demo: true,
      view: async () => { throw new DataGovernanceError("member_not_found", 404); },
      update: async () => { throw new SessionPolicyValidationError("invalid_reason"); },
      signOut: async () => { throw new Error("unused"); },
    }));
    assert.equal((await policyGet(request("/access/session-policy"))).status, 404);
  } finally { overrideSessionPolicyService(); }
});
