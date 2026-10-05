import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { TenantExportRequest } from "../../domain/tenant-export.ts";
import { PostgresDriverError } from "../../../../platform/database/postgres-native.ts";
import { trustedIdentityHeaders } from "../../../../test-support/identity-assertion.ts";
import "../../../../test-support/http-sql-driver.ts";

// Route handlers use the Next.js "@/..." alias; see src/platform/http/api/http.test.ts.
register(new URL("../../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

// The Postgres path: a non-demo identity through the trusted gateway, with an HTTP SQL test double that records every
// statement. Nothing here talks to a real database; db/postgres/tests/tenant-data-export.{sql,mjs} cover the SQL itself.
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const GATEWAY_SECRET = "tenant-export-gateway-secret";
const REQUEST = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";

process.env.CORVIS_DEMO_MODE = "";
process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = GATEWAY_SECRET;
process.env.CORVIS_DATABASE_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
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

const { GET: retentionGet } = await import("@/app/api/v1/access/retention/route");
const { GET: listGet, POST: requestPost } = await import("@/app/api/v1/access/data-exports/route");
const { GET: itemGet, POST: itemPost } = await import("@/app/api/v1/access/data-exports/[exportId]/route");
const { GET: downloadGet } = await import("@/app/api/v1/access/data-exports/[exportId]/download/route");
const { GET: buildsGet } = await import("@/app/api/v1/admin/tenant-export-builds/route");
const { dataGovernanceErrorResponse, assertOrganizationAdmin, DataGovernanceError } = await import("../../../governance/server/lifecycle/data-governance.ts");
const { tenantExportService, overrideTenantExportService, createTenantExportService, postgresTenantExportService } = await import("./tenant-export-service.ts");
const { retentionService, postgresRetentionService } = await import("../../../governance/server/lifecycle/data-retention.ts");

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: REQUEST, state: "pending_approval", reason: "Records review", requested_by_auth_method: "oidc", requested_by_subject: "idp|alex",
    requested_at: "2026-10-01 10:00:00+00", approval_expires_at: "2026-10-08 10:00:00+00", decided_by_subject: null, decided_at: null, decision_note: null,
    cancelled_at: null, state_changed_at: "2026-10-01 10:00:00+00", checksum_sha256: null, size_bytes: null, artifact_expires_at: null, manifest: null,
    approval_lapsed: false, download_available: false, ...overrides,
  };
}

type Caller = { roles?: string; subject?: string; method?: string; body?: unknown; unauthenticated?: boolean };
let sequence = 0;
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const method = caller.method ?? "GET";
  const hasBody = caller.body !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-correlation-id": `corr-tenant-export-${sequence}`,
      ...(caller.unauthenticated ? {} : {
        ...trustedIdentityHeaders(GATEWAY_SECRET, { subject: caller.subject ?? "idp|alex", tenantId: TENANT, workspaceId: WORKSPACE, roles: caller.roles ?? "admin" }),
      }),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(caller.body) : undefined,
  });
}
const params = (exportId: string) => ({ params: Promise.resolve({ exportId }) });
const seed = (handler: (query: Query) => unknown[] = () => []) => { queries.length = 0; respond = handler; };
type Json = { error?: string; data: TenantExportRequest & TenantExportRequest[] & { policies: Array<Record<string, unknown>>; legalHolds: Array<Record<string, unknown>>; downloadUrl: string } };
const body = async (response: Response) => (await response.json()) as Json;
const isAudit = (query: Query) => /insert into corvis_control\.audit_event/.test(query.sql);

test("the Postgres services are selected outside demo mode", () => {
  assert.equal(tenantExportService(), postgresTenantExportService);
  assert.equal(retentionService(), postgresRetentionService);
});

test("every route refuses a caller with no credentials, and a role without admin:manage, before touching data", async () => {
  const runs: Array<[string, (extra: Caller) => Promise<Response>]> = [
    ["retention", (extra) => retentionGet(request("/access/retention", extra))],
    ["list", (extra) => listGet(request("/access/data-exports", extra))],
    ["request", (extra) => requestPost(request("/access/data-exports", { method: "POST", body: { reason: "Records review" }, ...extra }))],
    ["get", (extra) => itemGet(request(`/access/data-exports/${REQUEST}`, extra), params(REQUEST))],
    ["decide", (extra) => itemPost(request(`/access/data-exports/${REQUEST}`, { method: "POST", body: { action: "approve" }, ...extra }), params(REQUEST))],
    ["download", (extra) => downloadGet(request(`/access/data-exports/${REQUEST}/download?grant=x`, extra), params(REQUEST))],
  ];
  for (const [name, run] of runs) {
    seed();
    const anonymous = await run({ unauthenticated: true });
    assert.equal(anonymous.status, 401, name);
    for (const roles of ["analyst", "reviewer", "read_only", "api_client"]) {
      const denied = await run({ roles });
      assert.equal(denied.status, 403, `${name} as ${roles}`);
      assert.equal((await body(denied)).error, "forbidden");
    }
  assert.equal(queries.length, 0, `${name} touches no data before authorizing`);
  }
});

test("an Organization Admin sees the tenant's policies and active holds, in plain language and read-only", async () => {
  seed((query) => /from corvis_control\.retention_policy p/.test(query.sql)
    ? [
      { data_class: "financials", retention_days: 2555, delete_on_termination: false, policy_version: "2026-01", effective_from: "2026-01-01 00:00:00+00", in_effect: true, legal_hold: false },
      { data_class: "fund_reports", retention_days: null, delete_on_termination: "true", policy_version: "2027-01", effective_from: "2027-01-01 00:00:00+00", in_effect: false, legal_hold: "true" },
    ]
    : /from corvis_control\.legal_hold/.test(query.sql)
      ? [
        { legal_hold_id: "h1", data_class: "financials", scope: { documentIds: ["a", "b"] }, matter_reference: "MATTER-1", placed_at: "2026-04-12 09:30:00+00" },
        { legal_hold_id: "h2", data_class: null, scope: "{}", matter_reference: "MATTER-2", placed_at: "2026-05-01 09:30:00+00" },
      ]
      : []);
  const response = await retentionGet(request("/access/retention"));
  assert.equal(response.status, 200);
  const { data } = await body(response);
  assert.deepEqual(data.policies, [
    { dataClass: "financials", label: "Financial data", retentionDays: 2555, retentionLabel: "7 years", deleteOnTermination: false, legalHold: false, policyVersion: "2026-01", effectiveFrom: "2026-01-01T00:00:00Z", inEffect: true },
    { dataClass: "fund_reports", label: "Fund reports", retentionDays: null, retentionLabel: "No fixed retention period", deleteOnTermination: true, legalHold: true, policyVersion: "2027-01", effectiveFrom: "2027-01-01T00:00:00Z", inEffect: false },
  ]);
  assert.deepEqual(data.legalHolds, [
    { holdId: "h1", dataClass: "financials", label: "Financial data", scopeLabel: "2 documents within financial data", matterReference: "MATTER-1", placedAt: "2026-04-12T09:30:00Z" },
    { holdId: "h2", dataClass: null, label: "All data", scopeLabel: "all data", matterReference: "MATTER-2", placedAt: "2026-05-01T09:30:00Z" },
  ]);
  // Tenant-scoped, read-only, and only released-less holds.
  assert.equal(queries.every((query) => query.parameters[0] === TENANT && /^select/i.test(query.sql)), true);
  assert.match(queries.find((query) => /from corvis_control\.legal_hold/.test(query.sql))!.sql, /released_at is null/);
  assert.equal(queries.some(isAudit), false, "reading retention is not a mutation");
  seed();
  assert.deepEqual((await body(await retentionGet(request("/access/retention")))).data, { policies: [], legalHolds: [], deletionRequests: [] });
});

test("requesting writes the request and its audit event together, attributed to the caller, with the reason", async () => {
  seed((query) => /request_tenant_export/.test(query.sql) ? [row()] : []);
  const response = await requestPost(request("/access/data-exports", { method: "POST", body: { reason: "Records review", tenantId: "someone-else", workspaceId: "ignored" } }));
  assert.equal(response.status, 201);
  const { data } = await body(response);
  assert.deepEqual([data.status, data.requestedByMe, data.reason], ["pending_approval", true, "Records review"]);
  const call = queries.find((query) => /request_tenant_export/.test(query.sql))!;
  assert.equal(call.parameters[0], TENANT, "the tenant comes from the authenticated identity, never the body");
  assert.equal(call.parameters[2], WORKSPACE);
  const audit = queries.find(isAudit)!;
  assert.ok(audit.parameters.includes("data_export.requested"));
  assert.ok(audit.parameters.includes("tenant_export_request"));
  assert.ok(audit.parameters.includes("idp|alex"));
  assert.equal(queries.some((query) => /export_job|outbox_event/.test(query.sql)), false, "the per-user export queue is untouched");
});

test("listing and reading a request are tenant-scoped; an unknown id is a 404 and a malformed one never reaches SQL", async () => {
  seed((query) => /tenant_export_request_event/.test(query.sql) ? [{ event_type: "requested", from_state: null, to_state: "pending_approval", actor_subject: "idp|alex", note: null, occurred_at: "2026-10-01 10:00:00+00" }] : [row()]);
  const list = await body(await listGet(request("/access/data-exports")));
  assert.equal(list.data.length, 1);
  assert.equal(queries[0]!.parameters[0], TENANT);
  assert.equal(queries[0]!.parameters.at(-1), 51, "the default page is 50, and one more is read to know whether there is a next page");
  const one = await body(await itemGet(request(`/access/data-exports/${REQUEST}`), params(REQUEST)));
  assert.equal(one.data.history!.length, 1);
  seed();
  const missing = await itemGet(request(`/access/data-exports/${REQUEST}`), params(REQUEST));
  assert.equal(missing.status, 404);
  assert.equal((await body(missing)).error, "data_export_not_found");
  seed();
  assert.equal((await itemGet(request("/access/data-exports/not-a-uuid"), params("not-a-uuid"))).status, 404);
  assert.equal(queries.length, 0);
});

test("a decision, a link and a download go through the service with their own audit events", async () => {
  const manifest = { manifestVersion: 1, files: [], artifact: { fundIds: [], documentIds: [] } };
  seed((query) => /decide_tenant_export/.test(query.sql)
    ? [row({ state: "approved", decided_by_subject: "idp|morgan", decided_at: "2026-10-01 11:00:00+00" })]
    : /from corvis_control\.tenant_export_request r\s+where/.test(query.sql) ? [row({ state: "complete", checksum_sha256: "a".repeat(64), size_bytes: 10, artifact_expires_at: "2026-10-04 10:00:00+00", manifest, download_available: true })]
      : /tenant_export_scope_changed/.test(query.sql) ? [{ changed: false }]
        : /insert into corvis_control\.tenant_export_download_grant/.test(query.sql) ? [{ expires_at: "2026-10-03 10:10:00+00" }]
          : []);
  const approved = await itemPost(request(`/access/data-exports/${REQUEST}`, { method: "POST", subject: "idp|morgan", body: { action: "approve", expectedStatus: "pending_approval", note: "ok" } }), params(REQUEST));
  assert.equal(approved.status, 200);
  assert.deepEqual(queries.find((query) => /decide_tenant_export/.test(query.sql))!.parameters.slice(2, 7), ["approve", "oidc", "idp|morgan", "ok", "pending_approval"]);
  assert.ok(queries.find(isAudit)!.parameters.includes("data_export.approved"));

  seed((query) => /from corvis_control\.tenant_export_request r\s+where/.test(query.sql)
    ? [row({ state: "complete", checksum_sha256: "a".repeat(64), size_bytes: 10, artifact_expires_at: "2026-10-04 10:00:00+00", manifest, download_available: true })]
    : /tenant_export_scope_changed/.test(query.sql) ? [{ changed: false }]
      : /insert into corvis_control\.tenant_export_download_grant/.test(query.sql) ? [{ expires_at: "2026-10-03 10:10:00+00" }] : []);
  const link = await itemPost(request(`/access/data-exports/${REQUEST}`, { method: "POST", body: { action: "prepare_download" } }), params(REQUEST));
  assert.equal(link.status, 200);
  assert.match((await body(link)).data.downloadUrl, /\/download\?grant=/);
  assert.ok(queries.find(isAudit)!.parameters.includes("data_export.link_issued"));

  // A link that matches nothing answers 404 and writes no audit event.
  seed();
  const none = await downloadGet(request(`/access/data-exports/${REQUEST}/download?grant=nothing`), params(REQUEST));
  assert.equal(none.status, 404);
  assert.equal(queries.some(isAudit), false);
  const noGrant = await downloadGet(request(`/access/data-exports/${REQUEST}/download`), params(REQUEST));
  assert.equal(noGrant.status, 404);
});

test("SQL refusals reach the client as stable codes, and typed errors keep their own status", async () => {
  const refusing = (message: string) => createTenantExportService({
    demo: false,
    request: async () => { throw new Error(message); }, list: async () => ({ items: [], nextCursor: null }), get: async () => { throw new DataGovernanceError("data_export_not_found", 404); },
    decide: async () => { throw new PostgresDriverError("query", "P0001", message as never); },
    issueDownload: async () => { throw new Error("boom"); }, redeemDownload: async () => null, openArtifact: async () => null,
  });
  overrideTenantExportService(refusing("tenant export already in progress"));
  try {
    const duplicate = await requestPost(request("/access/data-exports", { method: "POST", body: { reason: "Records review" } }));
    assert.equal(duplicate.status, 409);
    assert.equal((await body(duplicate)).error, "data_export_already_active");
    overrideTenantExportService(refusing("tenant export requires an independent approver"));
    const self = await itemPost(request(`/access/data-exports/${REQUEST}`, { method: "POST", body: { action: "approve" } }), params(REQUEST));
    assert.equal(self.status, 403);
    assert.equal((await body(self)).error, "data_export_independent_approver_required");
    assert.equal((await itemGet(request(`/access/data-exports/${REQUEST}`), params(REQUEST))).status, 404);
    const broken = await itemPost(request(`/access/data-exports/${REQUEST}`, { method: "POST", body: { action: "prepare_download" } }), params(REQUEST));
    assert.equal(broken.status, 500, "an unexpected failure is not disguised as a client error");
  } finally {
    overrideTenantExportService();
  }
});

test("the list route pages through the Postgres backend: nextCursor when more remain, then the cursor drives the keyset (F10f)", async () => {
  const older = "9f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
  seed(() => [row({ cursor_at: "2026-10-01T10:00:00.000002Z" }), row({ request_id: older, cursor_at: "2026-10-01T09:00:00.000001Z" })]);
  const page = (await (await listGet(request("/access/data-exports?limit=1"))).json()) as { data: unknown[]; nextCursor: string | null };
  assert.equal(page.data.length, 1);
  assert.ok(page.nextCursor);
  seed(() => [row({ request_id: older, cursor_at: "2026-10-01T09:00:00.000001Z" })]);
  const second = (await (await listGet(request(`/access/data-exports?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`))).json()) as { data: unknown[]; nextCursor: string | null };
  assert.equal(second.nextCursor, null);
  assert.match(queries[0]!.sql, /\(r\.requested_at, r\.request_id\) < \(\$2::timestamptz, \$3::uuid\)/);
  assert.deepEqual(queries[0]!.parameters, [TENANT, "2026-10-01T10:00:00.000002Z", REQUEST, 2]);
  seed();
  const bad = await listGet(request("/access/data-exports?cursor=garbage"));
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "invalid_cursor");
  assert.equal(queries.length, 0, "a bad cursor never reaches SQL");
  assert.equal((await listGet(request("/access/data-exports?limit=abc"))).status, 400);
});

test("the operator build view is for the operations tenant's admins only, and lists failed builds without any customer detail (F10f)", async () => {
  const failed = { tenant_id: TENANT, tenant_name: "Meridian", request_id: REQUEST, state: "failed", build_attempts: 5, last_error: "export build lease expired before completion",
    requested_at: "2026-10-01 10:00:00+00", state_changed_at: "2026-10-02 10:00:00+00", build_next_attempt_at: null, cursor_at: "2026-10-02T10:00:00.000000Z" };
  const original = process.env.CORVIS_OPERATIONS_TENANT_ID;
  try {
    // No operations tenant configured: nobody, not even an Organization Admin, may read it.
    delete process.env.CORVIS_OPERATIONS_TENANT_ID;
    seed(() => [failed]);
    const unconfigured = await buildsGet(request("/admin/tenant-export-builds"));
    assert.equal(unconfigured.status, 403);
    assert.equal((await body(unconfigured)).error, "operations_admin_required");
    // A customer's own Organization Admin is refused.
    process.env.CORVIS_OPERATIONS_TENANT_ID = "00000000-0000-4000-8000-000000000001";
    const customer = await buildsGet(request("/admin/tenant-export-builds"));
    assert.equal(customer.status, 403);
    assert.equal((await body(customer)).error, "operations_admin_required");
    assert.equal((await buildsGet(request("/admin/tenant-export-builds", { roles: "analyst" }))).status, 403);
    assert.equal((await buildsGet(request("/admin/tenant-export-builds", { unauthenticated: true }))).status, 401);
    assert.equal(queries.length, 0, "refused before any query");

    process.env.CORVIS_OPERATIONS_TENANT_ID = TENANT;
    const ok = await buildsGet(request("/admin/tenant-export-builds?status=failed&limit=5"));
    assert.equal(ok.status, 200);
    const page = (await ok.json()) as { data: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.deepEqual(page.data.map((item) => [item.tenantName, item.requestId, item.status, item.attempts, item.lastError]), [["Meridian", REQUEST, "failed", 5, "export build lease expired before completion"]]);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(Object.keys(page.data[0]!).sort(), ["attempts", "changedAt", "lastError", "nextAttemptAt", "requestId", "requestedAt", "status", "tenantId", "tenantName"], "no requester, reason or approver");
    assert.match(queries[0]!.sql, /where r\.state = 'failed'/);
    assert.equal((await buildsGet(request("/admin/tenant-export-builds?status=weird"))).status, 400);
    assert.equal((await buildsGet(request("/admin/tenant-export-builds?cursor=garbage"))).status, 400);
  } finally {
    if (original === undefined) delete process.env.CORVIS_OPERATIONS_TENANT_ID; else process.env.CORVIS_OPERATIONS_TENANT_ID = original;
  }
});

test("the error mapper handles typed, validation, authorization and unknown failures", async () => {
  assert.equal(dataGovernanceErrorResponse(new DataGovernanceError("x", 409), "c").status, 409);
  assert.equal((await dataGovernanceErrorResponse(new DataGovernanceError("tenant_admin_required", 403), "c").json() as { error: string }).error, "tenant_admin_required");
  assert.equal(dataGovernanceErrorResponse(new Error("who knows"), "c").status, 500);
  assert.doesNotThrow(() => assertOrganizationAdmin({ isTenantAdmin: true } as never));
  for (const flag of [false, undefined, "true", 1]) assert.throws(() => assertOrganizationAdmin({ isTenantAdmin: flag } as never), (error) => error instanceof DataGovernanceError && error.status === 403);
});
