import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type { DataIssueCase, ReportDataIssueCommand } from "../../domain/data-issue.ts";
import {
  DataIssueRequestError,
  PostgresDataIssueBackend,
  assertCanReport,
  assertCanViewAll,
  canViewDataIssue,
  closeDataIssuesForCorrection,
  dataIssueAuditEvent,
  entitledToFund,
  isReporter,
  isTenantAdminIdentity,
  isUuid,
  reportFingerprint,
  toDataIssueCase,
} from "./data-issue.ts";
import { InvalidCursorError, decodeCursor, encodeCursor } from "../../../../platform/http/api/pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const CASE_ID = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const USER_ID = "99999999-9999-4999-8999-999999999999";
const SNAPSHOT = "44444444-4444-4444-8444-444444444444";
const INCIDENT = "55555555-5555-4555-8555-555555555555";
const REPLACEMENT = "66666666-6666-4666-8666-666666666666";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "idp|reporter", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["analyst"], authMethod: "oidc", sessionId: "session-1",
    entitlements: { workspaceIds: [WORKSPACE], fundIds: ["fund-1", "fund-2"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const admin = identity({ subject: "idp|admin", roles: ["admin"], isTenantAdmin: true });

function row(overrides: PostgresRow = {}): PostgresRow {
  return {
    tenant_id: TENANT, case_id: CASE_ID, workspace_id: WORKSPACE, reporter_auth_method: "oidc", reporter_subject: "idp|reporter", reporter_user_id: USER_ID,
    figure: "review", fund_id: "fund-1", fund_label: "Fund One", company_id: "company-1", company_label: "ABC Corp", metric_code: "revenue", metric_label: "Revenue",
    report_period: "Q2 2026", snapshot_id: SNAPSHOT, snapshot_version: 3, comment: "Looks too high", status: "received", routed_to: "data_operations",
    correction_incident_id: null, replacement_snapshot_id: null, replacement_snapshot_version: null, resolution_note: null,
    status_changed_at: "2026-10-01 10:00:00+00", created_at: "2026-10-01 10:00:00+00", reporter_seen_status: "received",
    cursor_created_at: "2026-10-01T10:00:00.123456Z", ...overrides,
  };
}

type Call = { sql: string; parameters: PostgresPrimitive[] };
class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  readonly executed: Call[] = [];
  private readonly handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[];
  failExecute?: (sql: string) => boolean;
  constructor(handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[] = () => []) { this.handler = handler; }
  async query(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); return this.handler(sql, parameters); }
  async execute(sql: string, parameters: PostgresPrimitive[] = []) {
    this.executed.push({ sql, parameters });
    if (this.failExecute?.(sql)) throw new Error(`execute failed: ${sql}`);
  }
  async health() { return true; }
}

const command: ReportDataIssueCommand = {
  idempotencyKey: "report-1", figure: "review", comment: "Looks too high",
  scope: { fundId: "fund-1", fundLabel: "Fund One", companyId: "company-1", companyLabel: "ABC Corp", metricCode: "revenue", metricLabel: "Revenue", reportPeriod: "Q2 2026", snapshotId: SNAPSHOT, snapshotVersion: 3 },
};
const refusal = (code: string, status: number) => (error: unknown) => error instanceof DataIssueRequestError && error.code === code && error.status === status;

test("visibility helpers: the reporter while entitled, an Organization Admin always, nobody else", () => {
  const reporter = { authMethod: "oidc", subject: "idp|reporter" };
  assert.equal(isUuid(CASE_ID), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isTenantAdminIdentity(admin), true);
  assert.equal(isTenantAdminIdentity(identity({ roles: ["admin"] })), false, "a workspace admin is not an Organization Admin");
  assert.equal(isReporter(identity(), reporter), true);
  assert.equal(isReporter(identity({ subject: "idp|other" }), reporter), false);
  assert.equal(isReporter(identity({ authMethod: "saml" }), reporter), false, "the same subject text under another auth method is a different person");
  assert.equal(entitledToFund(identity(), "fund-1"), true);
  assert.equal(entitledToFund(identity(), "fund-9"), false);
  assert.equal(entitledToFund(identity({ entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } }), "fund-1"), false, "no fund list fails closed");
  assert.equal(entitledToFund(identity({ authMethod: "demo", entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } }), "any-demo-fund"), true);
  assert.equal(canViewDataIssue(identity(), { reporter, fundId: "fund-1" }), true);
  assert.equal(canViewDataIssue(identity(), { reporter, fundId: "fund-9" }), false, "an entitlement the reporter lost hides the case from them");
  assert.equal(canViewDataIssue(identity({ subject: "idp|colleague" }), { reporter, fundId: "fund-1" }), false);
  assert.equal(canViewDataIssue(admin, { reporter, fundId: "fund-9" }), true);
  assert.doesNotThrow(() => assertCanReport(identity(), "fund-1"));
  assert.throws(() => assertCanReport(identity(), "fund-9"), refusal("fund_not_entitled", 403));
  assert.doesNotThrow(() => assertCanViewAll(admin));
  assert.throws(() => assertCanViewAll(identity()), refusal("tenant_admin_required", 403));
});

test("the report fingerprint binds the whole report and ignores nothing that is part of it", () => {
  const base = reportFingerprint(command);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(reportFingerprint({ ...command, idempotencyKey: "another-key" }), base, "the key itself is not part of the content");
  assert.equal(reportFingerprint({ ...command, scope: { ...command.scope } }), base);
  assert.notEqual(reportFingerprint({ ...command, comment: "different" }), base);
  assert.notEqual(reportFingerprint({ ...command, figure: "overview" }), base);
  assert.notEqual(reportFingerprint({ ...command, scope: { ...command.scope, snapshotVersion: 4 } }), base);
  assert.notEqual(reportFingerprint({ ...command, scope: { fundId: "fund-1", reportPeriod: "Q2 2026" } }), base);
});

test("rows map to cases with admin-only correction ids, the reporter's own unseen indicator and no hidden columns", () => {
  const mine = toDataIssueCase(row({ status: "corrected", reporter_seen_status: "investigating", correction_incident_id: INCIDENT, replacement_snapshot_id: REPLACEMENT, replacement_snapshot_version: "4", resolution_note: "Republished." }), identity());
  assert.equal(mine.reportedByMe, true);
  assert.equal(mine.hasUnseenUpdate, true);
  assert.deepEqual(mine.replacement, { snapshotId: REPLACEMENT, snapshotVersion: 4 });
  assert.equal(mine.resolutionNote, "Republished.");
  assert.equal("correctionIncidentId" in mine, false, "the governed incident id is for Organization Admins");
  assert.deepEqual(mine.scope, { fundId: "fund-1", reportPeriod: "Q2 2026", fundLabel: "Fund One", companyId: "company-1", companyLabel: "ABC Corp", metricCode: "revenue", metricLabel: "Revenue", snapshotId: SNAPSHOT, snapshotVersion: 3 });
  assert.equal(mine.routedTo, "data_operations");
  assert.equal("reporter_user_id" in mine || "reporterUserId" in mine, false);

  const seen = toDataIssueCase(row({ status: "corrected", reporter_seen_status: "corrected" }), identity());
  assert.equal(seen.hasUnseenUpdate, false);
  assert.equal(seen.replacement, null);

  const asAdmin = toDataIssueCase(row({ status: "investigating", correction_incident_id: INCIDENT }), admin, [{ fromStatus: null, toStatus: "received", at: "t", note: null }]);
  assert.equal(asAdmin.reportedByMe, false);
  assert.equal(asAdmin.hasUnseenUpdate, false, "someone else's case never shows an update badge");
  assert.equal(asAdmin.correctionIncidentId, INCIDENT);
  assert.equal(asAdmin.history?.length, 1);
  assert.equal(toDataIssueCase(row(), admin).correctionIncidentId, undefined);

  const bare = toDataIssueCase(row({ fund_label: null, company_id: null, company_label: null, metric_code: null, metric_label: null, snapshot_id: null, snapshot_version: null }), identity());
  assert.deepEqual(bare.scope, { fundId: "fund-1", reportPeriod: "Q2 2026" });
});

test("audit events carry identifiers and the status, never the comment or a note", () => {
  const item = toDataIssueCase(row({ status: "corrected", resolution_note: "secret note", replacement_snapshot_id: REPLACEMENT, replacement_snapshot_version: 4 }), admin);
  const event = dataIssueAuditEvent(admin, "corr-1", "data_issue.correct", item);
  assert.equal(event.targetType, "data_issue_case");
  assert.equal(event.targetId, CASE_ID);
  assert.equal(event.action, "data_issue.correct");
  assert.deepEqual(event.metadata, { status: "corrected", figure: "review", fundId: "fund-1", reportPeriod: "Q2 2026", snapshotVersion: 3, replacementSnapshotVersion: 4 });
  assert.ok(!JSON.stringify(event).includes("secret note") && !JSON.stringify(event).includes("Looks too high"));
  const bare = dataIssueAuditEvent(admin, "corr-1", "data_issue.report", toDataIssueCase(row({ snapshot_version: null }), admin));
  assert.deepEqual([bare.metadata?.snapshotVersion, bare.metadata?.replacementSnapshotVersion], [null, null]);
});

test("reporting calls only the report function, binds tenant, workspace, reporter and a content hash, and flags a replay", async () => {
  const created = new FakeDb((_sql, parameters) => [row({ case_id: parameters[1] })]);
  const backend = new PostgresDataIssueBackend(() => created);
  const result = await backend.report(identity(), command);
  assert.equal(result.created, true);
  assert.equal(created.calls.length, 1, "one statement: the report function");
  assert.match(created.calls[0]!.sql, /corvis_control\.report_data_issue\(/);
  assert.equal(created.executed.length, 0);
  const parameters = created.calls[0]!.parameters;
  assert.deepEqual([parameters[0], parameters[2], parameters[3], parameters[4], parameters[5], parameters[6]], [TENANT, WORKSPACE, "oidc", "idp|reporter", "report-1", reportFingerprint(command)]);
  assert.deepEqual(parameters.slice(7), ["review", "fund-1", "Fund One", "company-1", "ABC Corp", "revenue", "Revenue", "Q2 2026", SNAPSHOT, 3, "Looks too high"]);

  // A replay returns the original case under a different id.
  const replayed = await new PostgresDataIssueBackend(() => new FakeDb(() => [row()])).report(identity(), { ...command, scope: { fundId: "fund-1", reportPeriod: "Q2 2026" } }, new FakeDb(() => [row()]));
  assert.equal(replayed.created, false);
  assert.equal(replayed.item.caseId, CASE_ID);

  const sparse = new FakeDb((_sql, p) => [row({ case_id: p[1] })]);
  await backend.report(identity(), { idempotencyKey: "k", figure: "overview", comment: "c", scope: { fundId: "fund-1", reportPeriod: "Q2 2026" } }, sparse);
  assert.deepEqual(sparse.calls[0]!.parameters.slice(9, 17), [null, null, null, null, null, "Q2 2026", null, null]);
});

test("reporting refuses a malformed workspace or snapshot id before the database, and maps a lost key race to a retryable conflict", async () => {
  const untouched = new FakeDb();
  const backend = new PostgresDataIssueBackend(() => untouched);
  await assert.rejects(() => backend.report(identity({ workspaceId: "workspace_demo" }), command), refusal("invalid_scope", 400));
  await assert.rejects(() => backend.report(identity(), { ...command, scope: { ...command.scope, snapshotId: "seed-snapshot-1" } }), refusal("invalid_scope", 400));
  assert.equal(untouched.calls.length, 0);

  const raced = new FakeDb(() => { throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }); });
  await assert.rejects(() => backend.report(identity(), command, raced), refusal("data_issue_report_conflict", 409));
  const down = new FakeDb(() => { throw new Error("connection reset"); });
  await assert.rejects(() => backend.report(identity(), command, down), /connection reset/);
  const empty = new FakeDb(() => []);
  await assert.rejects(() => backend.report(identity(), command, empty), /data issue case was not created/);
});

test("a reporter lists only their own cases in entitled funds; an Organization Admin lists the tenant", async () => {
  const unseenQuery = (sql: string) => sql.includes("count(*)");
  const mine = new FakeDb((sql) => unseenQuery(sql) ? [{ unseen: 2 }] : [row({ case_id: "a" + CASE_ID.slice(1) })]);
  const backend = new PostgresDataIssueBackend(() => mine);
  const own = await backend.list(identity(), { scope: "mine", limit: 50 });
  assert.equal(own.items.length, 1);
  assert.equal(own.unseenUpdateCount, 2);
  assert.equal(own.nextCursor, null);
  const select = mine.calls.find((call) => !unseenQuery(call.sql))!;
  assert.match(select.sql, /c\.tenant_id=\$1::uuid and c\.reporter_auth_method=\$2 and c\.reporter_subject=\$3\s+and c\.fund_id in \(select jsonb_array_elements_text\(\$4::jsonb\)\)/);
  assert.match(select.sql, /order by c\.created_at desc,c\.case_id desc limit \$5::integer/);
  assert.deepEqual(select.parameters, [TENANT, "oidc", "idp|reporter", JSON.stringify(["fund-1", "fund-2"]), 51]);

  const all = new FakeDb((sql) => unseenQuery(sql) ? [] : [row()]);
  const tenantWide = await new PostgresDataIssueBackend(() => all).list(admin, { scope: "all", limit: 10, status: "investigating" });
  const allSelect = all.calls.find((call) => !unseenQuery(call.sql))!;
  assert.doesNotMatch(allSelect.sql, /reporter_subject/, "the whole tenant is not narrowed to the caller");
  assert.match(allSelect.sql, /c\.status=\$2/);
  assert.deepEqual(allSelect.parameters, [TENANT, "investigating", 11]);
  assert.equal(tenantWide.unseenUpdateCount, 0, "no row means nothing unseen");
  const unseen = all.calls.find((call) => unseenQuery(call.sql))!;
  assert.match(unseen.sql, /reporter_seen_status<>c\.status/);
  assert.deepEqual(unseen.parameters.slice(0, 3), [TENANT, "oidc", "idp|admin"], "the indicator counts the caller's own cases even for an admin");

  const noFunds = new FakeDb(() => []);
  await new PostgresDataIssueBackend(() => noFunds).list(identity({ entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } }), { scope: "mine", limit: 5 });
  assert.equal(noFunds.calls[0]!.parameters[3], "[]", "no fund entitlement fails closed to an empty list");
});

test("paging is a newest-first keyset: the cursor carries the last row's microsecond timestamp and id", async () => {
  const second = "b0000000-0000-4000-8000-00000000000b";
  const rows = [row({ case_id: CASE_ID, cursor_created_at: "2026-10-01T10:00:00.000002Z" }), row({ case_id: second, cursor_created_at: "2026-10-01T10:00:00.000001Z" }), row({ case_id: "c0000000-0000-4000-8000-00000000000c" })];
  const db = new FakeDb((sql) => sql.includes("count(*)") ? [{ unseen: 0 }] : rows);
  const backend = new PostgresDataIssueBackend(() => db);
  const page = await backend.list(admin, { scope: "all", limit: 2 });
  assert.deepEqual(page.items.map((item) => item.caseId), [CASE_ID, second]);
  assert.ok(page.nextCursor);
  assert.equal(decodeCursor(page.nextCursor), `2026-10-01T10:00:00.000001Z|${second}`);

  await backend.list(admin, { scope: "all", limit: 2, cursor: page.nextCursor });
  const next = db.calls.filter((call) => !call.sql.includes("count(*)")).at(-1)!;
  assert.match(next.sql, /\(c\.created_at,c\.case_id\) < \(\$2::timestamptz,\$3::uuid\)/);
  assert.deepEqual(next.parameters, [TENANT, "2026-10-01T10:00:00.000001Z", second, 3]);

  const exact = new FakeDb((sql) => sql.includes("count(*)") ? [{ unseen: 0 }] : rows.slice(0, 2));
  assert.equal((await new PostgresDataIssueBackend(() => exact).list(admin, { scope: "all", limit: 2 })).nextCursor, null, "exactly a full page is the last page");
  const none = new FakeDb(() => []);
  assert.deepEqual((await new PostgresDataIssueBackend(() => none).list(admin, { scope: "all", limit: 2 })).items, []);
});

test("a tampered or foreign cursor is rejected before any query runs", async () => {
  const db = new FakeDb();
  const backend = new PostgresDataIssueBackend(() => db);
  const bad = [
    "not-base64-json",
    encodeCursor("no-separator"),
    encodeCursor(`2026-10-01T10:00:00Z|${CASE_ID}`),
    encodeCursor(`2026-10-01T10:00:00.000000Z|not-a-uuid`),
    encodeCursor(`0000-10-01T10:00:00.000000Z|${CASE_ID}`),
    encodeCursor(`2026-02-30T10:00:00.000000Z|${CASE_ID}`),
    encodeCursor(`2026-13-01T10:00:00.000000Z|${CASE_ID}`),
  ];
  for (const cursor of bad) await assert.rejects(() => backend.list(admin, { scope: "all", limit: 5, cursor }), InvalidCursorError, cursor);
  assert.equal(db.calls.length, 0);
  // Uppercase ids are normalised, so a client cannot split a page boundary by re-casing the cursor.
  const ok = new FakeDb(() => []);
  await new PostgresDataIssueBackend(() => ok).list(admin, { scope: "all", limit: 5, cursor: encodeCursor(`2026-10-01T10:00:00.000000Z|${CASE_ID.toUpperCase()}`) });
  assert.equal(ok.calls[0]!.parameters[2], CASE_ID);
});

test("reading one case applies the same visibility predicate and returns its history; anything else is a plain 404", async () => {
  const events = [{ from_status: null, to_status: "received", occurred_at: "2026-10-01 10:00:00+00", note: null }, { from_status: "received", to_status: "investigating", occurred_at: "2026-10-02 10:00:00+00", note: "Looking." }];
  const db = new FakeDb((sql) => sql.includes("data_issue_case_event") ? events : [row()]);
  const backend = new PostgresDataIssueBackend(() => db);
  const found = await backend.get(identity(), CASE_ID);
  assert.deepEqual(found.history, [
    { fromStatus: null, toStatus: "received", at: "2026-10-01 10:00:00+00", note: null },
    { fromStatus: "received", toStatus: "investigating", at: "2026-10-02 10:00:00+00", note: "Looking." },
  ]);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, CASE_ID, false, "oidc", "idp|reporter", JSON.stringify(["fund-1", "fund-2"])]);
  assert.match(db.calls[0]!.sql, /\(\$3::boolean or \(c\.reporter_auth_method=\$4 and c\.reporter_subject=\$5 and c\.fund_id in/);
  assert.equal(db.calls[1]!.parameters[1], CASE_ID);
  await backend.get(admin, CASE_ID);
  assert.equal(db.calls[2]!.parameters[2], true, "an Organization Admin is not narrowed to their own reports");

  const unreachable = new FakeDb();
  const hidden = new PostgresDataIssueBackend(() => unreachable);
  await assert.rejects(() => hidden.get(identity(), "not-a-uuid"), refusal("data_issue_not_found", 404));
  assert.equal(unreachable.calls.length, 0);
  await assert.rejects(() => new PostgresDataIssueBackend(() => new FakeDb()).get(identity(), CASE_ID), refusal("data_issue_not_found", 404));
});

test("acknowledging moves only the reporter's own seen marker", async () => {
  const db = new FakeDb(() => [row({ status: "corrected", reporter_seen_status: "corrected" })]);
  const backend = new PostgresDataIssueBackend(() => db);
  const acknowledged = await backend.acknowledge(identity(), CASE_ID);
  assert.equal(acknowledged.hasUnseenUpdate, false);
  assert.match(db.calls[0]!.sql, /update corvis_control\.data_issue_case c set reporter_seen_status=c\.status/);
  assert.match(db.calls[0]!.sql, /c\.reporter_auth_method=\$3 and c\.reporter_subject=\$4/);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, CASE_ID, "oidc", "idp|reporter", JSON.stringify(["fund-1", "fund-2"])]);
  await assert.rejects(() => new PostgresDataIssueBackend(() => new FakeDb()).acknowledge(identity(), CASE_ID), refusal("data_issue_not_found", 404));
  const untouched = new FakeDb();
  await assert.rejects(() => new PostgresDataIssueBackend(() => untouched).acknowledge(identity(), "nope"), refusal("data_issue_not_found", 404));
  assert.equal(untouched.calls.length, 0);
});

test("a transition runs the SQL state machine, then queues the reporter's notice by status only", async () => {
  const moved = row({ status: "investigating" });
  const db = new FakeDb(() => [moved]);
  const backend = new PostgresDataIssueBackend(() => db);
  const result = await backend.transition(admin, CASE_ID, { action: "investigate", expectedStatus: "received", correctionIncidentId: INCIDENT, note: "Looking." });
  assert.equal(result.status, "investigating");
  assert.match(db.calls[0]!.sql, /transition_data_issue_case\(\$1::uuid,\$2::uuid,\$3,\$4,\$5,\$6,\$7::uuid\)/);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, CASE_ID, "investigate", "received", "idp|admin", "Looking.", INCIDENT]);
  const queued = db.executed.find((call) => call.sql.includes("insert into corvis_control.email_outbox"))!;
  assert.ok(queued, "the reporter is notified in the same transaction");
  assert.ok(queued.parameters.includes("data_issue_update"));
  assert.ok(queued.parameters.includes(USER_ID));
  assert.ok(queued.parameters.includes("fund-1"), "send-time eligibility re-checks the fund entitlement");
  assert.ok(queued.parameters.includes(`data_issue_update:${CASE_ID}:investigating`), "one email per case and status");
  assert.ok(queued.parameters.includes(JSON.stringify({ status: "investigating" })), "the template parameters are the status alone");
  for (const call of db.executed) for (const value of call.parameters) {
    assert.ok(typeof value !== "string" || !/Looks too high|Fund One|ABC Corp|Revenue/.test(value), "no comment, name or figure is queued");
  }

  const bare = new FakeDb(() => [row({ status: "no_change", reporter_user_id: null })]);
  await new PostgresDataIssueBackend(() => bare).transition(admin, CASE_ID, { action: "no_change", note: "Matches." });
  assert.deepEqual(bare.calls[0]!.parameters.slice(3), [null, "idp|admin", "Matches.", null]);
  assert.ok(!bare.executed.some((call) => call.sql.includes("email_outbox")), "a reporter with no human identity has nobody to email");

  await assert.rejects(() => new PostgresDataIssueBackend(() => new FakeDb()).transition(admin, CASE_ID, { action: "investigate" }), refusal("data_issue_not_found", 404));
  await assert.rejects(() => new PostgresDataIssueBackend(() => new FakeDb()).transition(admin, "nope", { action: "investigate" }), refusal("data_issue_not_found", 404));
});

test("a notification fault never fails the status change", async () => {
  const db = new FakeDb(() => [row({ status: "corrected" })]);
  db.failExecute = (sql) => sql.includes("email_outbox");
  const result = await new PostgresDataIssueBackend(() => db).transition(admin, CASE_ID, { action: "correct", correctionIncidentId: INCIDENT });
  assert.equal(result.status, "corrected");
  assert.ok(db.executed.some((call) => call.sql.includes("rollback to savepoint")), "the failed enqueue was rolled back to its savepoint");
});

test("closing cases for a resolved correction audits and notifies each one, inside a savepoint that releases", async () => {
  const closedRows = [row({ status: "corrected", case_id: CASE_ID, replacement_snapshot_id: REPLACEMENT, replacement_snapshot_version: 4 }), row({ status: "corrected", case_id: "d0000000-0000-4000-8000-00000000000d", reporter_user_id: null })];
  const db = new FakeDb(() => closedRows);
  const audited: string[] = [];
  const closed = await closeDataIssuesForCorrection(db, admin, INCIDENT, "corr-1", async (event) => { audited.push(`${event.action}:${event.targetId}`); });
  assert.deepEqual(closed.map((item) => item.status), ["corrected", "corrected"]);
  assert.deepEqual(audited, [`data_issue.correct:${CASE_ID}`, "data_issue.correct:d0000000-0000-4000-8000-00000000000d"]);
  assert.match(db.calls[0]!.sql, /close_data_issue_cases_for_correction\(\$1::uuid,\$2::uuid,\$3\)/);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, INCIDENT, "idp|admin"]);
  assert.equal(db.executed.filter((call) => call.sql.includes("email_outbox")).length, 1, "only the case with a human reporter queues an email");
  assert.equal(db.executed[0]!.sql, "savepoint corvis_data_issue_close");
  assert.equal(db.executed.at(-1)!.sql, "release savepoint corvis_data_issue_close");

  const nothing = new FakeDb(() => []);
  assert.deepEqual(await closeDataIssuesForCorrection(nothing, admin, INCIDENT, "corr-2", async () => { throw new Error("unreachable"); }), []);
});

test("a fault while closing cases rolls back to the savepoint and never fails the correction", async () => {
  const db = new FakeDb(() => [row({ status: "corrected" })]);
  const result = await closeDataIssuesForCorrection(db, admin, INCIDENT, "corr-3", async () => { throw new Error("audit insert failed"); });
  assert.deepEqual(result, []);
  assert.ok(db.executed.some((call) => call.sql === "rollback to savepoint corvis_data_issue_close"));

  // Outside a transaction the savepoint itself fails: the work still runs best effort, and a rollback failure is swallowed.
  const noTransaction = new FakeDb(() => [row({ status: "corrected" })]);
  noTransaction.failExecute = (sql) => sql.includes("savepoint");
  const closed = await closeDataIssuesForCorrection(noTransaction, admin, INCIDENT, "corr-4", async () => undefined);
  assert.equal(closed.length, 1);
  const broken = new FakeDb(() => { throw "not an error object"; });
  broken.failExecute = (sql) => sql.includes("savepoint");
  assert.deepEqual(await closeDataIssuesForCorrection(broken, admin, INCIDENT, "corr-5", async () => undefined), []);
  const unrecoverable = new FakeDb(() => { throw new Error("connection lost"); });
  unrecoverable.failExecute = (sql) => sql.startsWith("rollback");
  assert.deepEqual(await closeDataIssuesForCorrection(unrecoverable, admin, INCIDENT, "corr-7", async () => undefined), [], "a failed rollback is swallowed too");
  const unreleasable = new FakeDb(() => []);
  unreleasable.failExecute = (sql) => sql.startsWith("release");
  assert.deepEqual(await closeDataIssuesForCorrection(unreleasable, admin, INCIDENT, "corr-6", async () => undefined), [], "a failed release is still contained");
});

// Type-level guard: the case shape exposed to clients has no reporter user id or workspace.
const _shape: Array<keyof DataIssueCase> = ["caseId", "figure", "scope", "comment", "status", "routedTo", "reportedBy", "reportedByMe", "createdAt", "statusChangedAt", "resolutionNote", "replacement", "hasUnseenUpdate"];
test("the client-facing case shape is exactly the documented fields", () => {
  const keys = Object.keys(toDataIssueCase(row(), identity())).sort();
  assert.deepEqual(keys, [..._shape].sort());
});
