import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent } from "../../core/enterprise.ts";
import { PostgresDriverError } from "./postgres-native.ts";
import type { SqlApplicationError } from "./sql-application-errors.ts";

// Route handlers use the Next.js "@/..." alias; see lib/server/http.test.ts.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

// The Postgres path: a non-demo identity through the trusted gateway, with an HTTP SQL transport that records every
// statement. Nothing here talks to a real database; db/postgres/tests/data-issue-reports.{sql,mjs} cover the SQL itself.
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const GATEWAY_SECRET = "data-issue-gateway-secret";
const CASE_ID = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const USER_ID = "99999999-9999-4999-8999-999999999999";
const SNAPSHOT = "44444444-4444-4444-8444-444444444444";

process.env.CORVIS_DEMO_MODE = "";
process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = GATEWAY_SECRET;
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
console.warn = console.info = console.error = () => undefined;

type Query = { sql: string; parameters: unknown[] };
const queries: Query[] = [];
let respond: (query: Query) => unknown[] = () => [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as Query;
  const query = { sql: sql.trim(), parameters };
  queries.push(query);
  return new Response(JSON.stringify({ rows: respond(query) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { GET: listGet, POST: reportPost } = await import("@/app/api/v1/data-issues/route");
const { GET: itemGet, PATCH: itemPatch } = await import("@/app/api/v1/data-issues/[caseId]/route");
const { GET: queueGet } = await import("@/app/api/v1/admin/data-issues/route");
const { PATCH: adminItemPatch } = await import("@/app/api/v1/admin/data-issues/[caseId]/route");
const { POST: correctionPost } = await import("@/app/api/v1/admin/data-corrections/route");
const { overrideDataIssueService, dataIssueService, postgresDataIssueService } = await import("./data-issue-service.ts");

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: TENANT, case_id: CASE_ID, workspace_id: WORKSPACE, reporter_auth_method: "oidc", reporter_subject: "idp|reporter", reporter_user_id: USER_ID,
    figure: "review", fund_id: "fund-1", fund_label: null, company_id: null, company_label: null, metric_code: null, metric_label: null, report_period: "Q2 2026",
    snapshot_id: SNAPSHOT, snapshot_version: 3, comment: "Revenue looks too high", status: "received", routed_to: "data_operations", correction_incident_id: null,
    replacement_snapshot_id: null, replacement_snapshot_version: null, resolution_note: null, status_changed_at: "2026-10-01 10:00:00+00",
    created_at: "2026-10-01 10:00:00+00", reporter_seen_status: "received", cursor_created_at: "2026-10-01T10:00:00.000000Z", ...overrides,
  };
}

type Caller = { roles?: string; subject?: string; funds?: string[]; method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> };
let sequence = 0;
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const method = caller.method ?? "GET";
  const hasBody = caller.body !== undefined || caller.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-correlation-id": `corr-data-issue-${sequence}`,
      "x-corvis-gateway-secret": GATEWAY_SECRET,
      "x-corvis-auth-subject": caller.subject ?? "idp|reporter",
      "x-corvis-auth-tenant": TENANT,
      "x-corvis-auth-workspace": WORKSPACE,
      "x-corvis-auth-roles": caller.roles ?? "analyst",
      "x-corvis-entitled-funds": (caller.funds ?? ["fund-1"]).join(","),
      "x-corvis-entitled-documents": "",
      "x-corvis-source-access": "false",
      "x-corvis-redistribution": "false",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...caller.headers,
    },
    body: hasBody ? (caller.rawBody ?? JSON.stringify(caller.body)) : undefined,
  });
}
const params = (caseId: string) => ({ params: Promise.resolve({ caseId }) });
type CaseJson = {
  caseId: string; status: string; figure: string; routedTo: string; reportedBy: string; reportedByMe: boolean; hasUnseenUpdate: boolean;
  resolutionNote: string | null; correctionIncidentId?: string; replacement: { snapshotId: string; snapshotVersion: number } | null; history: unknown[];
};
/** The API answers a single case or a list under `data`; the intersection lets one helper type serve both in these tests. */
type Body = {
  error?: string; replayed?: boolean; correlationId?: string; nextCursor?: string | null; unseenUpdateCount?: number; truncated?: boolean;
  data: CaseJson & Array<CaseJson>;
};
const body = async (response: Response) => (await response.json()) as Body;
const seed = (handler: (query: Query) => unknown[] = () => []) => { queries.length = 0; respond = handler; };
const report = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: "k-1", figure: "review", comment: "Revenue looks too high",
  scope: { fundId: "fund-1", reportPeriod: "Q2 2026", snapshotId: SNAPSHOT, snapshotVersion: 3 }, ...overrides,
});
const isReportFunction = (query: Query) => /report_data_issue\(/.test(query.sql);
const isAudit = (query: Query) => /insert into corvis_control\.audit_event/.test(query.sql);

test("the Postgres service is selected outside demo mode", () => {
  assert.equal(dataIssueService(), postgresDataIssueService);
});

test("reporting touches only the report function and the audit log: it can never change data or publication state", async () => {
  seed((query) => isReportFunction(query) ? [row({ case_id: query.parameters[1] })] : []);
  const response = await reportPost(request("/data-issues", { method: "POST", body: report() }));
  assert.equal(response.status, 201);
  assert.equal((await body(response)).data.status, "received");

  assert.deepEqual(queries.map((query) => (isReportFunction(query) ? "report" : isAudit(query) ? "audit" : query.sql.slice(0, 40))).sort(), ["audit", "report"].sort(),
    "exactly the case write and its audit event; the rate limiter and identity lookups are not data writes");
  for (const query of queries) {
    assert.doesNotMatch(query.sql, /fund_period_snapshot|snapshot_publication_event|consolidated_fact|corvis_facts|data_correction_incident|outbox_event|processing_job|append_snapshot_transition|email_outbox/i,
      `a report must not read or write publication, correction, processing or outbox state: ${query.sql.slice(0, 80)}`);
  }
  const call = queries.find(isReportFunction)!;
  assert.equal(call.parameters[0], TENANT, "tenant comes from the authenticated identity, never the body");
  assert.deepEqual([call.parameters[2], call.parameters[3], call.parameters[4]], [WORKSPACE, "oidc", "idp|reporter"]);
  const audit = queries.find(isAudit)!;
  assert.ok(audit.parameters.includes("data_issue.report") && audit.parameters.includes("data_issue_case"));
  assert.ok(!audit.parameters.some((value) => typeof value === "string" && value.includes("Revenue looks too high")), "the comment is not copied into the audit event");
});

test("a replayed report is a 200 with the original case and writes no second audit event", async () => {
  seed((query) => isReportFunction(query) ? [row()] : []);
  const response = await reportPost(request("/data-issues", { method: "POST", body: report(), headers: { "idempotency-key": "k-1" } }));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.deepEqual([payload.replayed, payload.data.caseId], [true, CASE_ID]);
  assert.equal(queries.filter(isAudit).length, 0);
});

test("a fund outside the caller's entitlement is refused before any database access", async () => {
  seed();
  const response = await reportPost(request("/data-issues", { method: "POST", funds: ["fund-9"], body: report() }));
  assert.equal(response.status, 403);
  assert.equal((await body(response)).error, "fund_not_entitled");
  assert.equal(queries.length, 0);
  seed();
  const none = await reportPost(request("/data-issues", { method: "POST", funds: [], body: report() }));
  assert.equal(none.status, 403);
  assert.equal(queries.length, 0, "no fund entitlement fails closed");
});

test("a read-only role may report and read its own cases, and the list is bound to the reporter and their funds", async () => {
  seed((query) => /count\(\*\)/.test(query.sql) ? [{ unseen: 1 }] : [row()]);
  const response = await listGet(request("/data-issues?limit=5", { roles: "read_only", funds: ["fund-1", "fund-2"] }));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.data.length, 1);
  assert.equal(payload.unseenUpdateCount, 1);
  const select = queries.find((query) => /from corvis_control\.data_issue_case c/.test(query.sql) && !/count\(\*\)/.test(query.sql))!;
  assert.deepEqual(select.parameters, [TENANT, "oidc", "idp|reporter", JSON.stringify(["fund-1", "fund-2"]), 6]);
});

test("only an Organization Admin lists the tenant; a workspace admin without the tenant role is refused", async () => {
  seed();
  const denied = await listGet(request("/data-issues?scope=all"));
  assert.equal(denied.status, 403);
  assert.equal((await body(denied)).error, "tenant_admin_required");
  assert.equal(queries.length, 0);
  seed((query) => /count\(\*\)/.test(query.sql) ? [] : [row({ reporter_subject: "idp|someone-else" })]);
  const allowed = await listGet(request("/data-issues?scope=all", { roles: "admin", subject: "idp|boss" }));
  assert.equal(allowed.status, 200);
  const item = (await body(allowed)).data[0];
  assert.equal(item.reportedByMe, false);
  assert.equal(item.reportedBy, "idp|someone-else");
  const select = queries.find((query) => /from corvis_control\.data_issue_case c/.test(query.sql) && !/count\(\*\)/.test(query.sql))!;
  assert.doesNotMatch(select.sql, /reporter_subject/);
  assert.equal((await queueGet(request("/admin/data-issues", { roles: "analyst" }))).status, 403);
  assert.equal((await queueGet(request("/admin/data-issues?status=received", { roles: "admin" }))).status, 200);
});

test("one case: the reporter's predicate is in the query and a hidden case is a 404", async () => {
  seed((query) => /data_issue_case_event/.test(query.sql) ? [{ from_status: null, to_status: "received", occurred_at: "2026-10-01 10:00:00+00", note: null }] : [row()]);
  const found = await itemGet(request(`/data-issues/${CASE_ID}`), params(CASE_ID));
  assert.equal(found.status, 200);
  assert.equal((await body(found)).data.history.length, 1);
  const lookup = queries[queries.length - 2]!;
  assert.deepEqual(lookup.parameters, [TENANT, CASE_ID, false, "oidc", "idp|reporter", JSON.stringify(["fund-1"])]);

  seed();
  const hidden = await itemGet(request(`/data-issues/${CASE_ID}`, { subject: "idp|colleague" }), params(CASE_ID));
  assert.equal(hidden.status, 404);
  assert.equal((await body(hidden)).error, "data_issue_not_found");
  seed();
  assert.equal((await itemGet(request("/data-issues/not-a-uuid"), params("not-a-uuid"))).status, 404);
  assert.equal(queries.length, 0, "a malformed id never reaches the uuid cast");
});

test("acknowledging updates only the caller's own seen marker", async () => {
  seed((query) => /update corvis_control\.data_issue_case/.test(query.sql) ? [row({ status: "corrected", reporter_seen_status: "corrected" })] : []);
  const response = await itemPatch(request(`/data-issues/${CASE_ID}`, { method: "PATCH", body: { seen: true } }), params(CASE_ID));
  assert.equal(response.status, 200);
  const update = queries.find((query) => /update corvis_control\.data_issue_case/.test(query.sql))!;
  assert.deepEqual(update.parameters.slice(0, 4), [TENANT, CASE_ID, "oidc", "idp|reporter"]);
  assert.equal(queries.filter(isAudit).length, 0, "reading your own case is not an audited mutation");
  seed();
  assert.equal((await itemPatch(request(`/data-issues/${CASE_ID}`, { method: "PATCH", body: { seen: true } }), params(CASE_ID))).status, 404);
});

test("Data Operations moves a case: one SQL state machine call, one audit event, one notice, nothing else", async () => {
  seed((query) => /transition_data_issue_case/.test(query.sql) ? [row({ status: "investigating" })] : []);
  const response = await adminItemPatch(request(`/admin/data-issues/${CASE_ID}`, { method: "PATCH", roles: "admin", subject: "idp|ops", body: { action: "investigate", expectedStatus: "received", note: "Looking." } }), params(CASE_ID));
  assert.equal(response.status, 200);
  assert.equal((await body(response)).data.status, "investigating");
  const move = queries.find((query) => /transition_data_issue_case/.test(query.sql))!;
  assert.deepEqual(move.parameters, [TENANT, CASE_ID, "investigate", "received", "idp|ops", "Looking.", null]);
  const audit = queries.find(isAudit)!;
  assert.ok(audit.parameters.includes("data_issue.investigate"));
  const notice = queries.find((query) => /insert into corvis_control\.email_outbox/.test(query.sql))!;
  assert.ok(notice.parameters.includes("data_issue_update") && notice.parameters.includes(USER_ID));
  assert.ok(!queries.some((query) => /fund_period_snapshot|append_snapshot_transition|outbox_event/i.test(query.sql)), "moving a case never publishes or republishes anything");

  seed();
  assert.equal((await adminItemPatch(request(`/admin/data-issues/${CASE_ID}`, { method: "PATCH", roles: "admin", body: { action: "investigate" } }), params(CASE_ID))).status, 404);
  seed();
  const analyst = await adminItemPatch(request(`/admin/data-issues/${CASE_ID}`, { method: "PATCH", roles: "analyst", body: { action: "investigate" } }), params(CASE_ID));
  assert.equal(analyst.status, 403);
  assert.equal(queries.length, 0);
});

test("SQL refusals reach the client as stable conflict codes", async () => {
  const cases: Array<[SqlApplicationError, number, string]> = [
    ["data issue transition not allowed", 409, "data_issue_transition_not_allowed"],
    ["data issue case status changed", 409, "data_issue_status_changed"],
    ["data issue correction is not resolved", 409, "data_issue_correction_not_resolved"],
    ["data issue correction not found", 404, "data_issue_correction_not_found"],
    ["data issue snapshot not found for fund", 404, "data_issue_snapshot_not_found"],
  ];
  for (const [fragment, status, code] of cases) {
    overrideDataIssueService({
      ...postgresDataIssueService,
      transition: async () => { throw new PostgresDriverError("query", "P0001", fragment); },
      report: async () => { throw new PostgresDriverError("query", "P0001", fragment); },
    });
    try {
      const moved = await adminItemPatch(request(`/admin/data-issues/${CASE_ID}`, { method: "PATCH", roles: "admin", body: { action: "correct" } }), params(CASE_ID));
      assert.deepEqual([moved.status, (await body(moved)).error], [status, code]);
      const reported = await reportPost(request("/data-issues", { method: "POST", body: report() }));
      assert.deepEqual([reported.status, (await body(reported)).error], [status, code]);
    } finally {
      overrideDataIssueService();
    }
  }
  overrideDataIssueService({ ...postgresDataIssueService, report: async () => { throw new Error("database exploded"); } });
  try {
    const failed = await reportPost(request("/data-issues", { method: "POST", body: report() }));
    assert.equal(failed.status, 500);
    assert.equal((await body(failed)).error, "internal_error");
  } finally {
    overrideDataIssueService();
  }
});

test("resolving a governed correction also corrects the linked cases, audited, in the same transaction and without failing the correction", async () => {
  const INCIDENT = "55555555-5555-4555-8555-555555555555";
  const REPLACEMENT = "66666666-6666-4666-8666-666666666666";
  seed((query) => /resolve_data_correction_incident/.test(query.sql) ? [{ resolved: true }]
    : /close_data_issue_cases_for_correction/.test(query.sql) ? [row({ status: "corrected", correction_incident_id: INCIDENT, replacement_snapshot_id: REPLACEMENT, replacement_snapshot_version: 2 })] : []);
  const response = await correctionPost(request("/admin/data-corrections", { method: "POST", roles: "admin", subject: "idp|ops", body: { action: "resolve", incidentId: INCIDENT, replacementSnapshotId: REPLACEMENT, replacementSnapshotVersion: 2 } }));
  assert.equal(response.status, 200);
  assert.deepEqual((await body(response)).data, { incidentId: INCIDENT, state: "resolved", dataIssuesCorrected: 1 });
  const order = queries.map((query) => /resolve_data_correction_incident/.test(query.sql) ? "resolve" : /close_data_issue_cases_for_correction/.test(query.sql) ? "close" : isAudit(query) ? `audit:${query.parameters[5]}` : /email_outbox/.test(query.sql) ? "notice" : "other");
  assert.deepEqual(order.filter((step) => step !== "other"), ["resolve", "audit:data_correction.resolve", "close", "audit:data_issue.correct", "notice"]);
  const close = queries.find((query) => /close_data_issue_cases_for_correction/.test(query.sql))!;
  assert.deepEqual(close.parameters, [TENANT, INCIDENT, "idp|ops"]);

  // A failure while closing cases is contained: the correction still answers 200 and the cases stay as they were.
  seed((query) => {
    if (/resolve_data_correction_incident/.test(query.sql)) return [{ resolved: true }];
    if (/close_data_issue_cases_for_correction/.test(query.sql)) throw new Error("close failed");
    return [];
  });
  const contained = await correctionPost(request("/admin/data-corrections", { method: "POST", roles: "admin", body: { action: "resolve", incidentId: INCIDENT, replacementSnapshotId: REPLACEMENT, replacementSnapshotVersion: 2 } }));
  assert.equal(contained.status, 200);
  assert.equal(((await body(contained)).data as unknown as { dataIssuesCorrected: number }).dataIssuesCorrected, 0);
});

test("audit events written for case commands are structured and carry no free text", async () => {
  const events: AuditEvent[] = [];
  seed((query) => {
    if (isAudit(query)) events.push({ action: String(query.parameters[5]), targetType: String(query.parameters[6]), targetId: String(query.parameters[7]), metadata: JSON.parse(String(query.parameters[10])) } as unknown as AuditEvent);
    return isReportFunction(query) ? [row({ case_id: query.parameters[1] })] : /transition_data_issue_case/.test(query.sql) ? [row({ status: "no_change", resolution_note: "Private note." })] : [];
  });
  await reportPost(request("/data-issues", { method: "POST", body: report({ idempotencyKey: "k-audit", comment: "A private comment." }) }));
  await adminItemPatch(request(`/admin/data-issues/${CASE_ID}`, { method: "PATCH", roles: "admin", body: { action: "no_change", note: "Private note." } }), params(CASE_ID));
  assert.deepEqual(events.map((event) => event.action), ["data_issue.report", "data_issue.no_change"]);
  assert.ok(events.every((event) => event.targetType === "data_issue_case"));
  assert.ok(!JSON.stringify(events).includes("private") && !JSON.stringify(events).includes("Private"));
});

test("the tenant access audit listing includes data-issue events, so an Organization Admin can see who reported and who moved a case", async () => {
  const { listTenantAccessAudit } = await import("./tenant-admin-self-service.ts");
  const seenSql: string[] = [];
  const db = {
    async query(sql: string) {
      seenSql.push(sql);
      return [{ audit_event_id: SNAPSHOT, occurred_at: "2026-10-01 10:00:00+00", actor_subject: "idp|ops", action: "data_issue.investigate", target_type: "data_issue_case", target_id: CASE_ID, outcome: "success", metadata: { status: "investigating" } }];
    },
    async execute() {},
    async health() { return true; },
  };
  const events = await listTenantAccessAudit({
    subject: "idp|boss", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "s",
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false },
  }, db);
  assert.equal(events[0]?.action, "data_issue.investigate");
  assert.match(seenSql[0]!, /action like 'data_issue\.%'/);
  assert.match(seenSql[0]!, /'data_issue_case'/);
});
