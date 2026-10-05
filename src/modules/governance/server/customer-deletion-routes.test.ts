import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { DeletionRequestView } from "../domain/data-retention.ts";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { PostgresDriverError } from "../../../platform/database/postgres-native.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { trustedIdentityHeaders } from "../../../test-support/identity-assertion.ts";
import "../../../test-support/http-sql-driver.ts";

// Route handlers use the Next.js "@/..." alias; see src/platform/http/http.test.ts.
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

// The Postgres path: a non-demo identity through the trusted gateway, with an HTTP SQL test double that records every
// statement. Nothing here talks to a real database; db/postgres/tests/customer-deletion-requests.sql covers the SQL itself.
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const GATEWAY_SECRET = "customer-deletion-gateway-secret";
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
const { POST: requestPost } = await import("@/app/api/v1/access/deletion-requests/route");
const { POST: decidePost } = await import("@/app/api/v1/access/deletion-requests/[requestId]/route");
const { DataGovernanceError } = await import("./data-governance.ts");
const { PostgresCustomerDeletionBackend, createCustomerDeletionService, customerDeletionService, overrideCustomerDeletionService, postgresCustomerDeletionService } = await import("./customer-deletion.ts");

/** A `deletion_request` row as DELETION_REQUEST_COLUMNS returns it for a request an Organization Admin made. */
function customerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: REQUEST, origin: "customer", state: "pending_customer_approval", scope: { dataClasses: ["financials", "audit"] },
    requested_at: "2026-10-01 10:00:00+00", requested_by: "idp|alex", requested_by_auth_method: "oidc", reason: "Contract ends this quarter",
    approval_expires_at: "2026-10-08 10:00:00+00", decided_by: null, decision_note: null, decided_at: null, completed_at: null,
    approval_lapsed: false, legal_hold: false, ...overrides,
  };
}

type Caller = { roles?: string; subject?: string; method?: string; body?: unknown; rawBody?: string; unauthenticated?: boolean };
let sequence = 0;
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const hasBody = caller.body !== undefined || caller.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method: caller.method ?? "GET",
    headers: {
      "x-correlation-id": `corr-customer-deletion-${sequence}`,
      ...(caller.unauthenticated ? {} : {
        ...trustedIdentityHeaders(GATEWAY_SECRET, { subject: caller.subject ?? "idp|alex", tenantId: TENANT, workspaceId: WORKSPACE, roles: caller.roles ?? "admin" }),
      }),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? (caller.rawBody ?? JSON.stringify(caller.body)) : undefined,
  });
}
const params = (requestId: string) => ({ params: Promise.resolve({ requestId }) });
const seed = (handler: (query: Query) => unknown[] = () => []) => { queries.length = 0; respond = handler; };
type Json = { error?: string; data: DeletionRequestView & { deletionRequests: DeletionRequestView[] } };
const body = async (response: Response) => (await response.json()) as Json;
const isAudit = (query: Query) => /insert into corvis_control\.audit_event/.test(query.sql);

test("the Postgres service is selected outside demo mode", () => {
  assert.equal(customerDeletionService(), postgresCustomerDeletionService);
});

test("every deletion route refuses a caller with no credentials, and a role without admin:manage, before touching data", async () => {
  const runs: Array<[string, (extra: Caller) => Promise<Response>]> = [
    ["request", (extra) => requestPost(request("/access/deletion-requests", { method: "POST", body: { dataClasses: ["audit"], reason: "Closing the account" }, ...extra }))],
    ["decide", (extra) => decidePost(request(`/access/deletion-requests/${REQUEST}`, { method: "POST", body: { action: "approve" }, ...extra }), params(REQUEST))],
  ];
  for (const [name, run] of runs) {
    seed();
    assert.equal((await run({ unauthenticated: true })).status, 401, name);
    for (const roles of ["analyst", "reviewer", "read_only", "api_client"]) {
      const denied = await run({ roles });
      assert.equal(denied.status, 403, `${name} as ${roles}`);
      assert.equal((await body(denied)).error, "forbidden");
    }
    assert.equal(queries.length, 0, `${name} touches no data before authorizing`);
  }
});

test("the retention view lists the tenant's deletion requests with status, dates and hold, and never an operator's identity, reason, note or evidence", async () => {
  seed((query) => /from corvis_control\.deletion_request r/.test(query.sql)
    ? [
      customerRow({ request_id: "c1", state: "approved", decided_by: "idp|morgan", decided_at: "2026-10-02 09:00:00+00", decision_note: "Agreed", legal_hold: true }),
      // The SQL returns NULL for these on an operator row; the mapping must not trust that, so a row that leaked them still shows none.
      {
        request_id: "o1", origin: "operator", state: "blocked", scope: { dataClasses: ["source_documents"], documentIds: ["d1", "d2"] }, requested_at: "2026-09-01 08:00:00+00",
        requested_by: "ops-admin@corvis.example", requested_by_auth_method: "oidc", reason: "INTERNAL NOTE: churn risk", approval_expires_at: "2026-09-08 08:00:00+00",
        decided_by: "ops-approver@corvis.example", decision_note: "INTERNAL", decided_at: "2026-09-02 08:00:00+00", completed_at: null, approval_lapsed: false, legal_hold: true,
        last_error: "adapter exploded", completion_evidence: { secret: true }, evidence_hash: "abc", approved_by: "ops-approver@corvis.example",
      },
      { request_id: "o2", origin: "operator", state: "completed", scope: "{\"dataClasses\":[\"audit\"]}", requested_at: "2026-08-01 08:00:00+00", decided_at: "2026-08-02 08:00:00+00", completed_at: "2026-08-02 09:00:00+00", approval_lapsed: false, legal_hold: false },
      customerRow({ request_id: "c2", state: "pending_customer_approval", approval_lapsed: true, requested_by: "idp|morgan" }),
    ]
    : []);
  const response = await retentionGet(request("/access/retention"));
  assert.equal(response.status, 200);
  const raw = JSON.stringify(await response.clone().json());
  for (const secret of ["ops-admin", "ops-approver", "INTERNAL", "churn risk", "adapter exploded", "evidence", "abc", "secret"]) assert.equal(raw.includes(secret), false, `${secret} is never returned`);
  const { deletionRequests } = (await body(response)).data;
  assert.deepEqual(deletionRequests.map((item) => [item.requestId, item.origin, item.status, item.scopeLabel, item.legalHoldBlocks, item.requestedByMe]), [
    ["c1", "customer", "approved", "Audit records, financial data", true, true],
    ["o1", "corvis", "blocked", "2 documents within source documents", true, false],
    ["o2", "corvis", "completed", "Audit records", false, false],
    ["c2", "customer", "expired", "Audit records, financial data", false, false],
  ]);
  assert.deepEqual(deletionRequests.map((item) => [item.requestedAt, item.decidedAt, item.executedAt]).slice(1, 3), [
    ["2026-09-01T08:00:00Z", "2026-09-02T08:00:00Z", null],
    ["2026-08-01T08:00:00Z", "2026-08-02T08:00:00Z", "2026-08-02T09:00:00Z"],
  ], "requested, decided and executed dates");
  assert.deepEqual(deletionRequests[1], {
    requestId: "o1", origin: "corvis", status: "blocked", dataClasses: ["source_documents"], scopeLabel: "2 documents within source documents",
    requestedAt: "2026-09-01T08:00:00Z", decidedAt: "2026-09-02T08:00:00Z", executedAt: null, legalHoldBlocks: true,
    reason: null, requestedBy: null, approvalExpiresAt: null, decidedBy: null, decisionNote: null, requestedByMe: false,
    actions: { canApprove: false, canReject: false, canCancel: false },
  });
  assert.deepEqual([deletionRequests[0]!.reason, deletionRequests[0]!.decidedBy, deletionRequests[0]!.decisionNote], ["Contract ends this quarter", "idp|morgan", "Agreed"], "an Organization Admin's own request shows its reason and decision");
  assert.deepEqual(deletionRequests[3]!.actions, { canApprove: false, canReject: false, canCancel: false }, "a lapsed request cannot be decided");
  const sql = queries.find((query) => /from corvis_control\.deletion_request r/.test(query.sql))!;
  assert.deepEqual(sql.parameters, [TENANT], "tenant-scoped from the authenticated identity");
  assert.match(sql.sql, /limit 100/);
  assert.match(sql.sql, /case when r\.origin = 'customer' then r\.reason end/, "operator-only columns are NULL in the query itself");
  assert.doesNotMatch(sql.sql, /last_error|completion_evidence|evidence_hash|blocked_reason|approved_by|select \*/, "operator-only columns are never selected");
  assert.equal(queries.every((query) => /^select/i.test(query.sql)) && !queries.some(isAudit), true, "reading is not a mutation");
});

test("a malformed or unreadable scope still lists, as unspecified data", async () => {
  seed((query) => /from corvis_control\.deletion_request r/.test(query.sql) ? [customerRow({ scope: "not json", state: "mystery", requested_by_auth_method: "saml" })] : []);
  const [item] = (await body(await retentionGet(request("/access/retention")))).data.deletionRequests;
  assert.deepEqual([item!.scopeLabel, item!.dataClasses, item!.status, item!.requestedByMe], ["Unspecified data", [], "in_progress", false], "a state this code does not know is shown as in progress; another auth method is another person");
});

test("requesting writes the request and its audit event together, attributed to the caller, with the scope and reason", async () => {
  seed((query) => /request_customer_deletion/.test(query.sql) ? [customerRow()] : []);
  const response = await requestPost(request("/access/deletion-requests", { method: "POST", body: { dataClasses: ["financials", "audit", "audit"], reason: "  Contract ends this quarter  ", tenantId: "someone-else", workspaceId: "ignored" } }));
  assert.equal(response.status, 201);
  const { data } = await body(response);
  assert.deepEqual([data.status, data.requestedByMe, data.reason], ["pending_approval", true, "Contract ends this quarter"]);
  const call = queries.find((query) => /request_customer_deletion/.test(query.sql))!;
  assert.equal(call.parameters[0], TENANT, "the tenant comes from the authenticated identity, never the body");
  assert.equal(call.parameters[2], WORKSPACE);
  assert.deepEqual(call.parameters.slice(3), ["oidc", "idp|alex", JSON.stringify(["audit", "financials"]), "Contract ends this quarter", 168]);
  assert.match(call.sql, /deletion_scope_legal_hold/);
  const audit = queries.find(isAudit)!;
  for (const expected of ["deletion_request.customer_requested", "deletion_request", "idp|alex"]) assert.ok(audit.parameters.includes(expected), expected);
  assert.equal(JSON.stringify(audit.parameters).includes("audit,financials"), true, "the audit event names the data classes");
  assert.equal(queries.some((query) => /update corvis_control\.deletion_request|insert into corvis_control\.deletion_request/.test(query.sql)), false, "the operator lifecycle tables are written only by the SQL function");
});

test("a decision runs through the SQL function with its own audit event, and tells the function which status it expects", async () => {
  seed((query) => /decide_customer_deletion/.test(query.sql) ? [customerRow({ state: "approved", decided_by: "idp|morgan", decided_at: "2026-10-02 09:00:00+00" })] : []);
  const approved = await decidePost(request(`/access/deletion-requests/${REQUEST}`, { method: "POST", subject: "idp|morgan", body: { action: "approve", expectedStatus: "pending_approval", note: "ok" } }), params(REQUEST));
  assert.equal(approved.status, 200);
  assert.equal((await body(approved)).data.status, "approved");
  assert.deepEqual(queries.find((query) => /decide_customer_deletion/.test(query.sql))!.parameters.slice(2, 7), ["approve", "oidc", "idp|morgan", "ok", "pending_customer_approval"]);
  assert.ok(queries.find(isAudit)!.parameters.includes("deletion_request.customer_approved"));

  seed((query) => /decide_customer_deletion/.test(query.sql) ? [customerRow({ state: "rejected" })] : []);
  await decidePost(request(`/access/deletion-requests/${REQUEST}`, { method: "POST", body: { action: "reject", note: "No" } }), params(REQUEST));
  assert.deepEqual(queries.find((query) => /decide_customer_deletion/.test(query.sql))!.parameters.slice(2, 7), ["reject", "oidc", "idp|alex", "No", null]);
  assert.ok(queries.find(isAudit)!.parameters.includes("deletion_request.customer_rejected"));

  seed((query) => /decide_customer_deletion/.test(query.sql) ? [customerRow({ state: "cancelled" })] : []);
  await decidePost(request(`/access/deletion-requests/${REQUEST}`, { method: "POST", body: { action: "cancel" } }), params(REQUEST));
  assert.equal(queries.find((query) => /decide_customer_deletion/.test(query.sql))!.parameters[5], null, "no note, none sent");
  assert.ok(queries.find(isAudit)!.parameters.includes("deletion_request.customer_cancelled"));
});

test("an unknown id (or one Corvis operations made) is a 404 and a malformed one never reaches SQL; validation answers 400 before any SQL", async () => {
  seed();
  const missing = await decidePost(request(`/access/deletion-requests/${REQUEST}`, { method: "POST", body: { action: "approve" } }), params(REQUEST));
  assert.equal(missing.status, 404);
  assert.equal((await body(missing)).error, "deletion_request_not_found");
  assert.equal(queries.some(isAudit), false, "nothing changed, nothing audited");
  seed();
  assert.equal((await decidePost(request("/access/deletion-requests/not-a-uuid", { method: "POST", body: { action: "approve" } }), params("not-a-uuid"))).status, 404);
  assert.equal(queries.length, 0);
  for (const [payload, error] of [[{}, "invalid_action"], [{ action: "reject" }, "invalid_note"]] as const) {
    const response = await decidePost(request(`/access/deletion-requests/${REQUEST}`, { method: "POST", body: payload }), params(REQUEST));
    assert.deepEqual([response.status, (await body(response)).error], [400, error]);
  }
  for (const [payload, error] of [[{}, "invalid_data_classes"], [{ dataClasses: ["audit"] }, "invalid_reason"]] as const) {
    const response = await requestPost(request("/access/deletion-requests", { method: "POST", body: payload }));
    assert.deepEqual([response.status, (await body(response)).error], [400, error]);
  }
  assert.equal(queries.length, 0, "validation touches no data");
});

test("a request needs a workspace the caller really has", async () => {
  const backend = new PostgresCustomerDeletionBackend();
  const untouched = { query: async () => { throw new Error("a malformed workspace never reaches SQL"); }, execute: async () => 0 } as unknown as PostgresSqlApi;
  const identity = { subject: "idp|alex", tenantId: TENANT, workspaceId: "not-a-uuid", roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "s", entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } } as RequestIdentity;
  await assert.rejects(() => backend.request(identity, { dataClasses: ["audit"], reason: "Closing the account" }, untouched), (error: unknown) => error instanceof DataGovernanceError && error.code === "invalid_request" && error.status === 400);
});

test("a command never runs outside the audited transaction it is given", async () => {
  const backend = new PostgresCustomerDeletionBackend();
  const identity = { subject: "idp|alex", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "s", entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } } as RequestIdentity;
  await assert.rejects(() => backend.request(identity, { dataClasses: ["audit"], reason: "Closing the account" }), /inside its audited transaction/);
  await assert.rejects(() => backend.decide(identity, REQUEST, { action: "approve" }), /inside its audited transaction/);
});

test("SQL refusals reach the client as stable codes, and the loser of a race for the one pending slot is a 409, not a 500", async () => {
  const refusing = (message: string) => createCustomerDeletionService({
    demo: false,
    request: async () => { throw new Error(message); },
    decide: async () => { throw new PostgresDriverError("query", "P0001", message as never); },
  });
  const cases: Array<[string, number, string]> = [
    ["customer deletion requires an independent approver", 403, "deletion_independent_approver_required"],
    ["customer deletion blocked by legal hold", 409, "deletion_blocked_by_legal_hold"],
    ["customer deletion approval window has passed", 409, "deletion_approval_expired"],
    ["customer deletion scope invalid", 400, "invalid_data_classes"],
  ];
  try {
    for (const [message, status, code] of cases) {
      overrideCustomerDeletionService(refusing(message));
      const requested = await requestPost(request("/access/deletion-requests", { method: "POST", body: { dataClasses: ["audit"], reason: "Closing the account" } }));
      assert.deepEqual([requested.status, (await body(requested)).error], [status, code], `request: ${message}`);
      const decided = await decidePost(request(`/access/deletion-requests/${REQUEST}`, { method: "POST", body: { action: "approve" } }), params(REQUEST));
      assert.deepEqual([decided.status, (await body(decided)).error], [status, code], `decide: ${message}`);
    }
  } finally { overrideCustomerDeletionService(); }

  const failing = (error: Error): PostgresSqlApi => ({ query: async (): Promise<PostgresRow[]> => { throw error; }, execute: async () => 0, health: async () => true }) as unknown as PostgresSqlApi;
  const raced = failing(Object.assign(new Error("duplicate key"), { code: "23505" }));
  const identity = { subject: "idp|alex", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "s", entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } } as RequestIdentity;
  await assert.rejects(() => new PostgresCustomerDeletionBackend().request(identity, { dataClasses: ["audit"], reason: "Closing the account" }, raced),
    (error: unknown) => error instanceof DataGovernanceError && error.code === "deletion_request_already_pending" && error.status === 409);
  const broken = failing(new Error("connection lost"));
  await assert.rejects(() => new PostgresCustomerDeletionBackend().request(identity, { dataClasses: ["audit"], reason: "Closing the account" }, broken), /connection lost/, "any other failure is not hidden");
});
