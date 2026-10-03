import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { ServiceAccount, ServiceAccountCreated } from "../../core/service-account.ts";
import { PostgresDriverError } from "./postgres-native.ts";

// Route handlers use the Next.js "@/..." alias; see lib/server/http.test.ts.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

// The Postgres path: a non-demo identity through the trusted gateway, with an HTTP SQL transport that records every
// statement. Nothing here talks to a real database; db/postgres/tests/service-accounts.{sql,mjs} cover the SQL itself.
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const ACCOUNT = "44444444-dddd-4ddd-8ddd-444444444444";
const GATEWAY_SECRET = "service-account-gateway-secret";

process.env.CORVIS_DEMO_MODE = "";
process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = GATEWAY_SECRET;
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
console.warn = console.info = console.error = () => undefined;

type Query = { sql: string; parameters: unknown[] };
const queries: Query[] = [];
let respond: (query: Query) => unknown[] = () => [];
let fail: ((query: Query) => unknown) | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as Query;
  const query = { sql: sql.trim(), parameters };
  queries.push(query);
  const failure = fail?.(query);
  if (failure) throw failure;
  return new Response(JSON.stringify({ rows: respond(query) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { GET: listGet, POST: createPost } = await import("@/app/api/v1/access/service-accounts/route");
const { GET: itemGet, POST: itemPost } = await import("@/app/api/v1/access/service-accounts/[serviceAccountId]/route");
const { serviceAccountErrorResponse } = await import("./service-account-http.ts");
const { serviceAccountService, postgresServiceAccountService, overrideServiceAccountService, createServiceAccountService } = await import("./service-account-service.ts");
const { ServiceAccountError } = await import("./service-account.ts");
const { ServiceAccountValidationError } = await import("../../core/service-account.ts");

function accountRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service_account_id: ACCOUNT, user_id: "55555555-eeee-4eee-8eee-555555555555", display_name: "Reporting sync", purpose: "Nightly", workspace_id: WORKSPACE,
    workspace_name: "Primary Workspace", role_name: "analyst", status: "active", created_by_subject: "idp|alex", created_at: "2026-10-01 08:00:00+00",
    expires_at: "2027-10-01 08:00:00+00", disabled_at: null, disabled_by_subject: null, disable_reason: null, ...overrides,
  };
}
function credentialRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { service_account_id: ACCOUNT, credential_id: id, status: "active", created_by_subject: "idp|alex", created_at: "2026-10-01 08:00:00+00", expires_at: "2027-01-01 08:00:00+00", ends_at: null, revoked_at: null, last_used_at: null, ...overrides };
}
const isAudit = (query: Query) => /insert into corvis_control\.audit_event/.test(query.sql);

type Caller = { roles?: string; subject?: string; method?: string; body?: unknown; unauthenticated?: boolean; authMethod?: string };
let sequence = 0;
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const hasBody = caller.body !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method: caller.method ?? "GET",
    headers: {
      "x-correlation-id": `corr-service-account-${sequence}`,
      ...(caller.unauthenticated ? {} : {
        "x-corvis-gateway-secret": GATEWAY_SECRET, "x-corvis-auth-subject": caller.subject ?? "idp|alex", "x-corvis-auth-tenant": TENANT, "x-corvis-auth-workspace": WORKSPACE,
        "x-corvis-auth-roles": caller.roles ?? "admin", "x-corvis-entitled-funds": "", "x-corvis-entitled-documents": "", "x-corvis-source-access": "false", "x-corvis-redistribution": "false",
        ...(caller.authMethod ? { "x-corvis-auth-method": caller.authMethod } : {}),
      }),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(caller.body) : undefined,
  });
}
const params = (serviceAccountId: string) => ({ params: Promise.resolve({ serviceAccountId }) });
const seed = (handler: (query: Query) => unknown[] = () => []) => { queries.length = 0; respond = handler; fail = undefined; };
type Json = { error?: string; data: ServiceAccountCreated & { serviceAccounts: ServiceAccount[] } & ServiceAccount & { serviceAccount: ServiceAccount; credential?: { secret: string; credentialId: string } } };
const body = async (response: Response) => (await response.json()) as Json;

/** Answers the reads of one account; the credential row carries whichever id the last write minted. */
function world(): (query: Query) => unknown[] {
  let minted = "";
  return (query) => {
    if (/create_service_account|issue_service_account_credential/.test(query.sql)) minted = String(query.parameters[/create_service_account/.test(query.sql) ? 2 : 2]);
    if (/revoke_service_account_credentials/.test(query.sql)) return [{ revoked: 2 }];
    if (/from corvis_control\.workspace/.test(query.sql)) return [{ workspace_id: WORKSPACE, display_name: "Primary Workspace" }];
    if (/from corvis_control\.service_account a\b/.test(query.sql)) return [accountRow()];
    if (/from corvis_control\.service_account_credential c\b/.test(query.sql)) return [credentialRow(minted)];
    return [];
  };
}

test("the Postgres service is selected outside demo mode", () => {
  assert.equal(serviceAccountService(), postgresServiceAccountService);
});

test("every route refuses a caller with no credentials, a role without admin:manage, and a service account, before touching data", async () => {
  const runs: Array<[string, (extra: Caller) => Promise<Response>]> = [
    ["list", (extra) => listGet(request("/access/service-accounts", extra))],
    ["create", (extra) => createPost(request("/access/service-accounts", { method: "POST", body: { name: "Reporting sync", purpose: "Nightly", workspaceId: WORKSPACE, roleName: "viewer" }, ...extra }))],
    ["get", (extra) => itemGet(request(`/access/service-accounts/${ACCOUNT}`, extra), params(ACCOUNT))],
    ["act", (extra) => itemPost(request(`/access/service-accounts/${ACCOUNT}`, { method: "POST", body: { action: "disable", reason: "Retired" }, ...extra }), params(ACCOUNT))],
  ];
  for (const [name, run] of runs) {
    seed();
    assert.equal((await run({ unauthenticated: true })).status, 401, name);
    for (const roles of ["analyst", "reviewer", "read_only", "api_client"]) {
      const denied = await run({ roles });
      assert.equal(denied.status, 403, `${name} as ${roles}`);
      assert.equal((await body(denied)).error, "forbidden");
    }
    // A service account never manages service accounts, even one that somehow holds the admin application role.
    const machine = await run({ authMethod: "service_account", subject: `service-account:${ACCOUNT}` });
    assert.deepEqual([machine.status, (await body(machine)).error], [403, "tenant_admin_required"], `${name} as a service account`);
    assert.equal(queries.length, 0, `${name} touches no data before authorizing`);
  }
});

test("creating writes the account and its audit event together, attributed to the caller, and never sends or logs the secret", async () => {
  seed(world());
  const response = await createPost(request("/access/service-accounts", { method: "POST", body: { name: "Reporting sync", purpose: "Nightly", workspaceId: WORKSPACE, roleName: "analyst", tenantId: "someone-else", createdBy: "someone-else" } }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { data } = await body(response);
  assert.match(data.credential!.secret, /^corvis_sa_[0-9a-f]{32}_/);
  const call = queries.find((query) => /create_service_account/.test(query.sql))!;
  assert.equal(call.parameters[0], TENANT, "the tenant comes from the authenticated identity, never the body");
  assert.deepEqual(call.parameters.slice(3, 5), ["oidc", "idp|alex"]);
  assert.equal(call.parameters.includes("someone-else"), false);
  const audit = queries.find(isAudit)!;
  assert.ok(audit.parameters.includes("service_account.created"));
  assert.ok(audit.parameters.includes("service_account"));
  assert.ok(audit.parameters.includes("idp|alex"));
  for (const query of queries) assert.equal(JSON.stringify(query.parameters).includes(data.credential!.secret), false, "the secret is in no statement, including the audit insert");
  assert.deepEqual(queries.indexOf(call) < queries.indexOf(audit), true);
});

test("an account can be listed and read, tenant-scoped; an unknown or malformed id is a 404", async () => {
  seed(world());
  const list = await body(await listGet(request("/access/service-accounts")));
  assert.equal(list.data.serviceAccounts.length, 1);
  assert.equal(list.data.serviceAccounts[0]!.workspaceName, "Primary Workspace");
  assert.ok(queries.every((query) => query.parameters[0] === TENANT));
  const one = await body(await itemGet(request(`/access/service-accounts/${ACCOUNT}`), params(ACCOUNT)));
  assert.equal(one.data.name, "Reporting sync");
  seed();
  const missing = await itemGet(request(`/access/service-accounts/${ACCOUNT}`), params(ACCOUNT));
  assert.deepEqual([missing.status, (await body(missing)).error], [404, "service_account_not_found"]);
  seed();
  assert.equal((await itemGet(request("/access/service-accounts/not-a-uuid"), params("not-a-uuid"))).status, 404);
  assert.equal(queries.length, 0, "a malformed id never reaches SQL");
});

test("rotate, revoke and disable each audit their own action, with no secret in the event", async () => {
  seed(world());
  const rotated = await itemPost(request(`/access/service-accounts/${ACCOUNT}`, { method: "POST", body: { action: "rotate", overlapMinutes: 30 } }), params(ACCOUNT));
  assert.equal(rotated.status, 200);
  const secret = (await body(rotated)).data.credential!.secret;
  const rotateAudit = queries.find(isAudit)!;
  assert.ok(rotateAudit.parameters.includes("service_account.credential_rotated"));
  assert.equal(JSON.stringify(rotateAudit.parameters).includes(secret), false);

  seed(world());
  const revoked = await itemPost(request(`/access/service-accounts/${ACCOUNT}`, { method: "POST", body: { action: "revoke", reason: "Key leaked in a log" } }), params(ACCOUNT));
  assert.equal(revoked.status, 200);
  assert.equal((await body(revoked)).data.credential, undefined);
  assert.ok(queries.find(isAudit)!.parameters.includes("service_account.credential_revoked"));

  seed(world());
  assert.equal((await itemPost(request(`/access/service-accounts/${ACCOUNT}`, { method: "POST", body: { action: "disable", reason: "Integration retired" } }), params(ACCOUNT))).status, 200);
  assert.ok(queries.find(isAudit)!.parameters.includes("service_account.disabled"));

  seed(world());
  assert.equal((await itemPost(request(`/access/service-accounts/${ACCOUNT}`, { method: "POST", body: { action: "issue" } }), params(ACCOUNT))).status, 200);
  assert.ok(queries.find(isAudit)!.parameters.includes("service_account.credential_issued"));
});

test("the SQL function's refusals surface as stable codes, and a refused command leaves no audit event", async () => {
  const refusals: Array<[string, number, string]> = [
    ["service account requires an active organization admin", 403, "tenant_admin_required"],
    ["service account name already in use", 409, "service_account_name_in_use"],
    ["service account limit reached", 409, "service_account_limit_reached"],
    ["service account not found", 404, "service_account_not_found"],
    ["service account is not active", 409, "service_account_not_active"],
    ["service account already has a credential", 409, "service_account_credential_exists"],
    ["workspace not found", 404, "workspace_not_found"],
  ];
  for (const [message, status, error] of refusals) {
    seed(world());
    fail = (query) => /create_service_account|issue_service_account_credential|disable_service_account/.test(query.sql) ? new PostgresDriverError("query", "P0001", message as never) : undefined;
    const response = /workspace|name|limit|organization/.test(message)
      ? await createPost(request("/access/service-accounts", { method: "POST", body: { name: "Reporting sync", purpose: "Nightly", workspaceId: WORKSPACE, roleName: "viewer" } }))
      : await itemPost(request(`/access/service-accounts/${ACCOUNT}`, { method: "POST", body: { action: message.includes("not active") ? "disable" : "issue", reason: "Retired" } }), params(ACCOUNT));
    assert.deepEqual([response.status, (await body(response)).error], [status, error], message);
    assert.equal(queries.some(isAudit), false, `${message}: a refused command is not audited`);
  }
});

test("typed failures keep their code and status; anything else goes through the shared mapper", async () => {
  assert.deepEqual([(serviceAccountErrorResponse(new ServiceAccountError("service_account_not_found", 404), "c")).status], [404]);
  assert.equal((await body(serviceAccountErrorResponse(new ServiceAccountValidationError("invalid_name"), "c"))).error, "invalid_name");
  const unexpected = serviceAccountErrorResponse(new Error("boom"), "c");
  assert.equal(unexpected.status, 500);
  assert.equal(JSON.stringify(await unexpected.json()).includes("boom"), false);
});

test("an override pins the service and is restorable", () => {
  const custom = createServiceAccountService({ demo: true } as never);
  overrideServiceAccountService(custom);
  assert.equal(serviceAccountService(), custom);
  overrideServiceAccountService();
  assert.equal(serviceAccountService(), postgresServiceAccountService);
});
