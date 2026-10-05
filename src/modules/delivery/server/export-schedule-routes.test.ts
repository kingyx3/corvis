import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { PostgresDriverError } from "../../../platform/database/postgres-native.ts";
import type { SqlApplicationError } from "../../../platform/database/sql-application-errors.ts";
import { trustedIdentityHeaders } from "../../../test-support/identity-assertion.ts";
import "../../../test-support/http-sql-driver.ts";

// Route handlers use the Next.js "@/..." alias; see src/platform/http/http.test.ts.
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

// The Postgres path: a non-demo identity through the trusted gateway, with an HTTP SQL test double that records every
// statement. Nothing here talks to a real database; db/postgres/tests/export-schedules.{sql,mjs} cover the SQL itself.
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const GATEWAY_SECRET = "export-schedule-gateway-secret";
const SCHEDULE = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const RUN = "7f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const EXPORT = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT = "44444444-4444-4444-8444-444444444444";

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

const { GET: listGet, POST: createPost } = await import("@/app/api/v1/export-schedules/route");
const { GET: itemGet, PATCH: itemPatch, DELETE: itemDelete } = await import("@/app/api/v1/export-schedules/[scheduleId]/route");
const { GET: runsGet } = await import("@/app/api/v1/export-schedules/runs/route");
const { overrideExportScheduleService, exportScheduleService, postgresExportScheduleService } = await import("./export-schedule-service.ts");

const POSITION = { positionFinancials: { fundId: "fund-1", holdingId: "holding-1", companyId: "company-1", periodicity: "quarterly" } };

function scheduleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: TENANT, schedule_id: SCHEDULE, workspace_id: WORKSPACE, owner_auth_method: "oidc", owner_subject: "idp|owner", label: "Monthly sparrow",
    scope: POSITION, scope_label: "Position financials · company-1 · quarterly", format: "csv", trigger_kind: "monthly", status: "active", stop_reason: null, notify_on_completion: true,
    next_run_at: "2026-11-01 00:00:00+00", created_at: "2026-10-01 10:00:00+00", updated_at: "2026-10-01 10:00:00+00", cursor_created_at: "2026-10-01T10:00:00.000000Z", ...overrides,
  };
}
function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: RUN, schedule_id: SCHEDULE, trigger_key: "monthly:2026-10", outcome: "requested", export_id: EXPORT, failure_reason: null, created_at: "2026-10-01 00:00:05+00",
    schedule_label: "Monthly sparrow", scope_label: "Position financials · company-1 · quarterly", format: "csv", export_state: "queued", cursor_created_at: "2026-10-01T00:00:05.000000Z", ...overrides,
  };
}

type Caller = { roles?: string; subject?: string; funds?: string[]; redistribution?: boolean; method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> };
let sequence = 0;
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const method = caller.method ?? "GET";
  const hasBody = caller.body !== undefined || caller.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-correlation-id": `corr-export-schedule-${sequence}`,
      ...trustedIdentityHeaders(GATEWAY_SECRET, { subject: caller.subject ?? "idp|owner", tenantId: TENANT, workspaceId: WORKSPACE, roles: caller.roles ?? "analyst", fundIds: caller.funds ?? ["fund-1"], redistribution: caller.redistribution ?? true }),
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...caller.headers,
    },
    body: hasBody ? (caller.rawBody ?? JSON.stringify(caller.body)) : undefined,
  });
}
const params = (scheduleId: string) => ({ params: Promise.resolve({ scheduleId }) });
type ScheduleJson = { notifyOnCompletion: boolean; scheduleId: string; label: string; status: string; ownedByMe: boolean; owner: string; format: string; trigger: string; nextRunAt: string | null; lastRun: { runId: string; exportState?: string } | null };
type Body = { error?: string; replayed?: boolean; correlationId?: string; nextCursor?: string | null; data: ScheduleJson & Array<ScheduleJson & { outcome?: string; failureReason?: string }> };
const body = async (response: Response) => (await response.json()) as Body;
const seed = (handler: (query: Query) => unknown[] = () => []) => { queries.length = 0; respond = handler; };
const create = (overrides: Record<string, unknown> = {}) => ({ idempotencyKey: "k-1", label: "Monthly sparrow", scope: POSITION, format: "csv", trigger: "monthly", ...overrides });
const isCreateFunction = (query: Query) => /create_export_schedule\(/.test(query.sql);
const isStatusFunction = (query: Query) => /set_export_schedule_status\(/.test(query.sql);
const isNotificationFunction = (query: Query) => /set_export_schedule_notification\(/.test(query.sql);
const isAudit = (query: Query) => /insert into corvis_control\.audit_event/.test(query.sql);
const isLastRuns = (query: Query) => /distinct on \(r\.schedule_id\)/.test(query.sql);

test("the Postgres service is selected outside demo mode", () => {
  assert.equal(exportScheduleService(), postgresExportScheduleService);
});

test("creating a schedule writes only the schedule and its audit event: nothing is exported and no export job or outbox row is touched", async () => {
  seed((query) => isCreateFunction(query) ? [scheduleRow({ schedule_id: query.parameters[1] })] : []);
  const response = await createPost(request("/export-schedules", { method: "POST", body: create() }));
  assert.equal(response.status, 201);
  const payload = await body(response);
  assert.equal(payload.data.status, "active");
  assert.equal(payload.data.ownedByMe, true);
  assert.equal(payload.replayed, false);
  assert.equal(payload.data.nextRunAt, "2026-11-01T00:00:00.000Z");

  // (The latest-run lookup after the write only reads an export's delivery state.)
  for (const query of queries.filter((candidate) => !isLastRuns(candidate))) {
    assert.doesNotMatch(query.sql, /export_job|outbox_event|fund_period_snapshot|email_outbox|processing_job/i,
      `scheduling must not create an export or touch publication state: ${query.sql.slice(0, 80)}`);
  }
  const call = queries.find(isCreateFunction)!;
  assert.equal(call.parameters[0], TENANT, "tenant comes from the authenticated identity, never the body");
  assert.deepEqual([call.parameters[2], call.parameters[3], call.parameters[4], call.parameters[5]], [WORKSPACE, "oidc", "idp|owner", "k-1"]);
  assert.equal(call.parameters[8], JSON.stringify(POSITION));
  const audit = queries.find(isAudit)!;
  assert.ok(audit.parameters.includes("export_schedule.create") && audit.parameters.includes("export_schedule"));
  const { sessionId, ...metadata } = JSON.parse(String(audit.parameters[10])) as Record<string, unknown>;
  assert.equal(typeof sessionId, "string");
  assert.deepEqual(metadata, { label: "Monthly sparrow", trigger: "monthly", format: "csv", status: "active" });
  assert.equal(call.parameters[12], true, "emails about the schedule are on unless the owner says otherwise");
  assert.equal(payload.data.notifyOnCompletion, true);
});

test("the performance scorecard can be scheduled: the canonical scope with its filters is saved, and the owner must be entitled to a fund", async () => {
  const scope = { performanceScorecard: true, fundId: "fund-1", period: "Q1 2026" };
  seed((query) => isCreateFunction(query) ? [scheduleRow({ schedule_id: query.parameters[1], scope, scope_label: query.parameters[9], trigger_kind: "on_publish", next_run_at: null })] : []);
  const response = await createPost(request("/export-schedules", { method: "POST", body: create({ scope: { ...scope, fundId: " fund-1 ", extra: 1 }, trigger: "on_publish" }) }));
  assert.equal(response.status, 201);
  const call = queries.find(isCreateFunction)!;
  assert.equal(call.parameters[8], JSON.stringify(scope), "canonical: trimmed, unknown keys dropped");
  assert.equal(call.parameters[9], "Performance scorecard · fund-1 · Q1 2026");
  assert.equal(call.parameters[11], "on_publish");

  seed((query) => isCreateFunction(query) ? [scheduleRow({ schedule_id: query.parameters[1] })] : []);
  const all = await createPost(request("/export-schedules", { method: "POST", body: create({ scope: { performanceScorecard: true } }) }));
  assert.equal(all.status, 201, "all funds the owner is entitled to");
  assert.equal(queries.find(isCreateFunction)!.parameters[9], "Performance scorecard · all entitled funds");

  seed(() => []);
  const elsewhere = await createPost(request("/export-schedules", { method: "POST", body: create({ scope: { performanceScorecard: true, fundId: "fund-9" } }) }));
  assert.equal(elsewhere.status, 403);
  const nobody = await createPost(request("/export-schedules", { method: "POST", funds: [], body: create({ scope: { performanceScorecard: true } }) }));
  assert.equal(nobody.status, 403, "all funds is nothing without a fund");
  for (const bad of [{ performanceScorecard: false }, { performanceScorecard: true, fundId: "" }, { performanceScorecard: true, snapshotId: "x" }]) {
    const invalid = await createPost(request("/export-schedules", { method: "POST", body: create({ scope: bad }) }));
    assert.equal(invalid.status, 400, JSON.stringify(bad));
    assert.equal((await body(invalid)).error, "invalid_scope");
  }
  assert.equal(queries.some(isCreateFunction), false, "nothing is written for a refused scope");
});

test("the owner can opt a schedule out of emails when creating it", async () => {
  seed((query) => isCreateFunction(query) ? [scheduleRow({ schedule_id: query.parameters[1], notify_on_completion: query.parameters[12] })] : []);
  const response = await createPost(request("/export-schedules", { method: "POST", body: create({ notifyOnCompletion: false }) }));
  assert.equal(response.status, 201);
  assert.equal((await body(response)).data.notifyOnCompletion, false);
  assert.equal(queries.find(isCreateFunction)!.parameters[12], false);

  seed();
  const bad = await createPost(request("/export-schedules", { method: "POST", body: create({ notifyOnCompletion: "no" }) }));
  assert.deepEqual([bad.status, (await body(bad)).error], [400, "invalid_notify_on_completion"]);
  assert.equal(queries.length, 0);
});

test("a replayed create is a 200 with the original schedule and writes no second audit event", async () => {
  seed((query) => isCreateFunction(query) ? [scheduleRow()] : []);
  const response = await createPost(request("/export-schedules", { method: "POST", body: create(), headers: { "idempotency-key": "k-1" } }));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.deepEqual([payload.replayed, payload.data.scheduleId], [true, SCHEDULE]);
  assert.equal(queries.filter(isAudit).length, 0);
});

test("a schedule cannot widen access: a fund the owner is not entitled to, or missing redistribution rights, is refused before any write", async () => {
  seed();
  const stranger = await createPost(request("/export-schedules", { method: "POST", funds: ["fund-9"], body: create() }));
  assert.equal(stranger.status, 403);
  assert.equal((await body(stranger)).error, "export_scope_not_entitled");
  assert.equal(queries.some(isCreateFunction), false);

  seed();
  const noFunds = await createPost(request("/export-schedules", { method: "POST", funds: [], body: create() }));
  assert.equal(noFunds.status, 403);
  assert.equal((await body(noFunds)).error, "export_scope_not_entitled", "no fund entitlement fails closed");

  seed();
  const noRights = await createPost(request("/export-schedules", { method: "POST", redistribution: false, body: create() }));
  assert.equal(noRights.status, 403);
  assert.equal((await body(noRights)).error, "forbidden");
  assert.equal(queries.length, 0, "contractual data rights are checked before the database is touched");

  seed(() => []);
  const missingSnapshot = await createPost(request("/export-schedules", { method: "POST", body: create({ scope: { snapshotId: SNAPSHOT } }) }));
  assert.equal(missingSnapshot.status, 403);
  assert.equal((await body(missingSnapshot)).error, "export_scope_not_entitled", "an unknown snapshot is refused the same way as an unentitled one");
  const snapshotLookup = queries.find((query) => /from corvis_consolidated\.fund_period_snapshot/.test(query.sql))!;
  assert.deepEqual(snapshotLookup.parameters, [TENANT, SNAPSHOT]);

  seed();
  const bad = await createPost(request("/export-schedules", { method: "POST", body: create({ scope: { snapshotId: "not-a-uuid" } }) }));
  assert.equal(bad.status, 400);
  assert.equal((await body(bad)).error, "invalid_scope");
});

test("a request that cannot be a schedule is a 400 with a stable code before anything is read or written", async () => {
  const cases: Array<[Record<string, unknown> | string, string]> = [
    [create({ idempotencyKey: undefined }), "idempotency_key_required"],
    [create({ label: "" }), "invalid_label"],
    [create({ format: "pdf" }), "invalid_export_format"],
    [create({ trigger: "weekly" }), "invalid_trigger"],
    [create({ scope: {} }), "invalid_scope"],
    ["not json", "invalid_request"],
  ];
  for (const [payload, error] of cases) {
    seed();
    const response = await createPost(request("/export-schedules", typeof payload === "string" ? { method: "POST", rawBody: payload } : { method: "POST", body: payload }));
    assert.deepEqual([response.status, (await body(response)).error], [400, error], error);
    assert.equal(queries.length, 0);
  }
  seed();
  const array = await createPost(request("/export-schedules", { method: "POST", body: [] }));
  assert.equal((await body(array)).error, "invalid_request");
});

test("the list is the caller's own schedules, newest first with each one's latest run", async () => {
  seed((query) => isLastRuns(query) ? [runRow()] : /from corvis_control\.export_schedule s where/.test(query.sql) ? [scheduleRow()] : []);
  const response = await listGet(request("/export-schedules?limit=5", { roles: "reviewer" }));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0]!.lastRun?.exportState, "queued");
  assert.equal(payload.nextCursor, null);
  const select = queries.find((query) => /from corvis_control\.export_schedule s where/.test(query.sql))!;
  assert.deepEqual(select.parameters, [TENANT, "oidc", "idp|owner", 6]);
});

test("only an Organization Admin lists every schedule in the tenant, and sees the owner of each", async () => {
  seed();
  const denied = await listGet(request("/export-schedules?scope=all"));
  assert.equal(denied.status, 403);
  assert.equal((await body(denied)).error, "tenant_admin_required");
  assert.equal(queries.length, 0);

  seed((query) => isLastRuns(query) ? [] : /from corvis_control\.export_schedule s where/.test(query.sql) ? [scheduleRow({ owner_subject: "idp|someone-else" })] : []);
  const allowed = await listGet(request("/export-schedules?scope=all", { roles: "admin", subject: "idp|boss" }));
  assert.equal(allowed.status, 200);
  const item = (await body(allowed)).data[0]!;
  assert.deepEqual([item.ownedByMe, item.owner], [false, "idp|someone-else"]);
  const select = queries.find((query) => /from corvis_control\.export_schedule s where/.test(query.sql))!;
  assert.doesNotMatch(select.sql, /owner_subject/);
});

test("list parameters are validated before the database is read", async () => {
  for (const [path, error] of [
    ["/export-schedules?scope=everything", "invalid_scope"],
    ["/export-schedules?limit=abc", "invalid_limit"],
    ["/export-schedules?cursor=garbage", "invalid_cursor"],
    ["/export-schedules/runs?scope=everything", "invalid_scope"],
    ["/export-schedules/runs?limit=0", "invalid_limit"],
    ["/export-schedules/runs?cursor=garbage", "invalid_cursor"],
  ] as const) {
    seed();
    const response = await (path.includes("/runs") ? runsGet : listGet)(request(path));
    assert.deepEqual([response.status, (await body(response)).error], [400, error], path);
    assert.equal(queries.length, 0);
  }
});

test("the run history lists every run including refused ones, optionally narrowed to one schedule", async () => {
  seed(() => [runRow(), runRow({ run_id: "6f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f", trigger_key: "monthly:2026-09", outcome: "failed", export_id: null, export_state: null, failure_reason: "redistribution_not_permitted", cursor_created_at: "2026-09-01T00:00:05.000000Z" })]);
  const response = await runsGet(request(`/export-schedules/runs?scheduleId=${SCHEDULE}&limit=1`));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.data.length, 1);
  assert.ok(payload.nextCursor);
  assert.deepEqual(queries[0]!.parameters, [TENANT, "oidc", "idp|owner", SCHEDULE, 2]);

  seed(() => [runRow({ outcome: "failed", export_id: null, export_state: null, failure_reason: "owner_inactive" })]);
  const failed = await body(await runsGet(request("/export-schedules/runs?scope=all", { roles: "admin" })));
  assert.deepEqual([failed.data[0]!.outcome, failed.data[0]!.failureReason], ["failed", "owner_inactive"]);
  seed();
  assert.equal((await runsGet(request("/export-schedules/runs?scope=all"))).status, 403);
  assert.equal(queries.length, 0);
  seed();
  const malformed = await runsGet(request("/export-schedules/runs?scheduleId=not-a-uuid"));
  assert.deepEqual([malformed.status, (await body(malformed)).error], [404, "export_schedule_not_found"]);
});

test("one schedule: its owner's predicate is in the query and a hidden one is a 404", async () => {
  seed((query) => isLastRuns(query) ? [runRow()] : [scheduleRow()]);
  const found = await itemGet(request(`/export-schedules/${SCHEDULE}`), params(SCHEDULE));
  assert.equal(found.status, 200);
  assert.equal((await body(found)).data.lastRun?.runId, RUN);
  assert.deepEqual(queries[0]!.parameters, [TENANT, SCHEDULE, false, "oidc", "idp|owner"]);

  seed();
  const hidden = await itemGet(request(`/export-schedules/${SCHEDULE}`, { subject: "idp|colleague" }), params(SCHEDULE));
  assert.deepEqual([hidden.status, (await body(hidden)).error], [404, "export_schedule_not_found"]);
  seed();
  assert.equal((await itemGet(request("/export-schedules/not-a-uuid"), params("not-a-uuid"))).status, 404);
  assert.equal(queries.length, 0, "a malformed id never reaches the uuid cast");
});

test("the owner pauses and resumes: one SQL transition keyed on their identity and one audit event each", async () => {
  seed((query) => isStatusFunction(query) ? [scheduleRow({ status: query.parameters[4] === "pause" ? "paused" : "active", next_run_at: null })] : []);
  const paused = await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", body: { action: "pause" } }), params(SCHEDULE));
  assert.equal(paused.status, 200);
  assert.equal((await body(paused)).data.status, "paused");
  assert.deepEqual(queries.find(isStatusFunction)!.parameters, [TENANT, SCHEDULE, "oidc", "idp|owner", "pause"]);
  assert.ok(queries.find(isAudit)!.parameters.includes("export_schedule.pause"));

  seed((query) => isStatusFunction(query) ? [scheduleRow()] : []);
  const resumed = await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", body: { action: "resume" } }), params(SCHEDULE));
  assert.equal((await body(resumed)).data.status, "active");
  assert.ok(queries.find(isAudit)!.parameters.includes("export_schedule.resume"));
});

test("the owner switches the emails about a schedule on and off: one SQL change keyed on their identity and one audit event with the new value", async () => {
  seed((query) => isNotificationFunction(query) ? [scheduleRow({ notify_on_completion: query.parameters[4] })] : []);
  const off = await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", body: { notifyOnCompletion: false } }), params(SCHEDULE));
  assert.equal(off.status, 200);
  assert.equal((await body(off)).data.notifyOnCompletion, false);
  assert.deepEqual(queries.find(isNotificationFunction)!.parameters, [TENANT, SCHEDULE, "oidc", "idp|owner", false]);
  assert.equal(queries.some(isStatusFunction), false, "the schedule's status is not touched");
  const audit = queries.find(isAudit)!;
  assert.ok(audit.parameters.includes("export_schedule.notify"));
  const { sessionId: _session, ...metadata } = JSON.parse(String(audit.parameters[10])) as Record<string, unknown>;
  void _session;
  assert.deepEqual(metadata, { label: "Monthly sparrow", trigger: "monthly", format: "csv", status: "active", notifyOnCompletion: false });

  seed((query) => isNotificationFunction(query) ? [scheduleRow({ notify_on_completion: query.parameters[4] })] : []);
  const on = await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", body: { notifyOnCompletion: true } }), params(SCHEDULE));
  assert.equal((await body(on)).data.notifyOnCompletion, true);
  assert.deepEqual(JSON.parse(String(queries.find(isAudit)!.parameters[10])).notifyOnCompletion, true);
});

test("anyone but the owner finds nothing to change the emails of, an Organization Admin included, and nothing is audited", async () => {
  seed();
  const response = await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", roles: "admin", subject: "idp|boss", body: { notifyOnCompletion: false } }), params(SCHEDULE));
  assert.deepEqual([response.status, (await body(response)).error], [404, "export_schedule_not_found"]);
  assert.equal(queries.filter(isAudit).length, 0);
  assert.equal(queries.find(isNotificationFunction)!.parameters[3], "idp|boss", "keyed on the caller, so a schedule they do not own is not found");

  for (const payload of [{ notifyOnCompletion: "no" }, { notifyOnCompletion: null }, { action: "pause", notifyOnCompletion: false }]) {
    seed();
    const refused = await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", body: payload }), params(SCHEDULE));
    assert.equal(refused.status, 400);
    assert.equal(queries.length, 0, "refused before the schedule is touched");
  }
});

test("anyone but the owner finds nothing to pause, resume or delete, an Organization Admin included, and nothing is audited", async () => {
  for (const method of ["PATCH", "DELETE"] as const) {
    seed();
    const response = await (method === "PATCH" ? itemPatch : itemDelete)(
      request(`/export-schedules/${SCHEDULE}`, { method, roles: "admin", subject: "idp|boss", body: method === "PATCH" ? { action: "pause" } : undefined }), params(SCHEDULE));
    assert.deepEqual([response.status, (await body(response)).error], [404, "export_schedule_not_found"], method);
    assert.equal(queries.filter(isAudit).length, 0);
  }
});

test("an invalid action is refused before the schedule is touched", async () => {
  for (const payload of [{ action: "delete" }, { action: "run_now" }, {}, undefined]) {
    seed();
    const response = await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", ...(payload === undefined ? { rawBody: "null" } : { body: payload }) }), params(SCHEDULE));
    assert.equal(response.status, 400);
    assert.equal(queries.length, 0);
  }
});

test("deleting a schedule is audited and answers with what was deleted, never with data", async () => {
  seed((query) => isStatusFunction(query) ? [scheduleRow({ status: "deleted", next_run_at: null })] : []);
  const response = await itemDelete(request(`/export-schedules/${SCHEDULE}`, { method: "DELETE" }), params(SCHEDULE));
  assert.equal(response.status, 200);
  assert.deepEqual((await body(response)).data, { scheduleId: SCHEDULE, status: "deleted" });
  assert.equal(queries.find(isStatusFunction)!.parameters[4], "delete");
  const audit = queries.find(isAudit)!;
  assert.ok(audit.parameters.includes("export_schedule.delete"));
  assert.equal(JSON.parse(String(audit.parameters[10])).status, "deleted");
});

test("SQL refusals reach the client as stable codes", async () => {
  const cases: Array<[SqlApplicationError, number, string]> = [
    ["idempotency key reused with different export schedule", 409, "idempotency_key_reused"],
    ["export schedule scope is invalid", 400, "invalid_scope"],
    ["export schedule limit reached", 409, "export_schedule_limit_reached"],
    ["export schedule transition not allowed", 409, "export_schedule_transition_not_allowed"],
  ];
  for (const [fragment, status, code] of cases) {
    overrideExportScheduleService({
      ...postgresExportScheduleService,
      create: async () => { throw new PostgresDriverError("query", "P0001", fragment); },
      setStatus: async () => { throw new PostgresDriverError("query", "P0001", fragment); },
    });
    try {
      const created = await createPost(request("/export-schedules", { method: "POST", body: create() }));
      assert.deepEqual([created.status, (await body(created)).error], [status, code]);
      const moved = await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", body: { action: "pause" } }), params(SCHEDULE));
      assert.deepEqual([moved.status, (await body(moved)).error], [status, code]);
    } finally { overrideExportScheduleService(); }
  }
  overrideExportScheduleService({ ...postgresExportScheduleService, create: async () => { throw new Error("database exploded"); } });
  try {
    const failed = await createPost(request("/export-schedules", { method: "POST", body: create() }));
    assert.equal(failed.status, 500);
    assert.equal((await body(failed)).error, "internal_error");
  } finally { overrideExportScheduleService(); }
});

test("a parquet schedule is refused when the format is not enabled for the organization", async () => {
  seed(() => []);
  const response = await createPost(request("/export-schedules", { method: "POST", body: create({ format: "parquet" }) }));
  assert.equal(response.status, 403);
  assert.equal((await body(response)).error, "feature_disabled");
  assert.equal(queries.some(isCreateFunction), false);

  seed((query) => /from corvis_control\.feature_flag /.test(query.sql) ? [{ flag_key: "exports.parquet_delivery", enabled: true, kill_switch: false, configuration: {} }]
    : isCreateFunction(query) ? [scheduleRow({ format: "parquet", schedule_id: query.parameters[1] })] : []);
  const enabled = await createPost(request("/export-schedules", { method: "POST", roles: "admin", body: create({ format: "parquet", idempotencyKey: "k-2" }) }));
  assert.equal(enabled.status, 201);
  assert.equal((await body(enabled)).data.format, "parquet");
});

test("audit events written for schedule commands carry identifiers, the label and the trigger, and nothing from the data", async () => {
  const events: Array<{ action: string; targetType: string; targetId: string; metadata: Record<string, unknown> }> = [];
  seed((query) => {
    if (isAudit(query)) events.push({ action: String(query.parameters[5]), targetType: String(query.parameters[6]), targetId: String(query.parameters[7]), metadata: JSON.parse(String(query.parameters[10])) });
    return isCreateFunction(query) ? [scheduleRow({ schedule_id: query.parameters[1] })] : isStatusFunction(query) ? [scheduleRow({ status: "paused", next_run_at: null })] : [];
  });
  await createPost(request("/export-schedules", { method: "POST", body: create({ idempotencyKey: "k-audit" }) }));
  await itemPatch(request(`/export-schedules/${SCHEDULE}`, { method: "PATCH", body: { action: "pause" } }), params(SCHEDULE));
  await itemDelete(request(`/export-schedules/${SCHEDULE}`, { method: "DELETE" }), params(SCHEDULE));
  assert.deepEqual(events.map((event) => event.action), ["export_schedule.create", "export_schedule.pause", "export_schedule.delete"]);
  assert.ok(events.every((event) => event.targetType === "export_schedule"));
  for (const event of events) assert.deepEqual(Object.keys(event.metadata).sort(), ["format", "label", "sessionId", "status", "trigger"]);
});

test("the tenant access audit lists schedule events, so an Organization Admin sees who scheduled, paused, deleted and what the system stopped", async () => {
  const { listTenantAccessAudit } = await import("../../identity-access/server/tenant-admin-self-service.ts");
  const seenSql: string[] = [];
  const db = {
    async query(sql: string) {
      seenSql.push(sql);
      return [{ audit_event_id: SNAPSHOT, occurred_at: "2026-10-01 10:00:00+00", actor_subject: "system:export-scheduler", action: "export_schedule.stop", target_type: "export_schedule", target_id: SCHEDULE, outcome: "success", metadata: { reason: "owner_inactive" } }];
    },
    async execute() {},
    async health() { return true; },
  };
  const events = await listTenantAccessAudit({
    subject: "idp|boss", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "s",
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false },
  }, db);
  assert.equal(events[0]?.action, "export_schedule.stop");
  assert.match(seenSql[0]!, /action like 'export_schedule\.%'/);
  assert.match(seenSql[0]!, /'export_schedule'/);
});
