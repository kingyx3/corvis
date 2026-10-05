import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, type RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type { CreateExportScheduleCommand } from "../../domain/export-schedule.ts";
import type { MembershipAuthorization } from "../../../identity-access/server/authorization.ts";
import {
  ExportScheduleRequestError,
  PostgresExportScheduleBackend,
  assertCanViewAll,
  assertScopeEntitled,
  defaultFormatGate,
  exportScheduleAuditEvent,
  isTenantAdminIdentity,
  isUuid,
  processDueExportSchedules,
  scheduleFingerprint,
  scheduleSessionId,
  stopSchedulesOfInactiveOwners,
  toExportSchedule,
  toExportScheduleRun,
} from "./export-schedule.ts";
import { FeatureFlagDeniedError } from "../../../admin/server/feature-flags.ts";
import { InvalidCursorError, decodeCursor, encodeCursor } from "../../../../platform/http/api/pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const SCHEDULE = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const SECOND_SCHEDULE = "9f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const RUN = "7f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const SNAPSHOT = "44444444-4444-4444-8444-444444444444";
const EXPORT = "55555555-5555-4555-8555-555555555555";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "idp|owner", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["analyst"], authMethod: "oidc", sessionId: "session-1",
    entitlements: { workspaceIds: [WORKSPACE], fundIds: ["fund-1", "fund-2"], sourceDocumentAccessAllowed: false, redistributionAllowed: true }, ...overrides,
  };
}
const admin = identity({ subject: "idp|admin", roles: ["admin"], isTenantAdmin: true });

const positionScope = { positionFinancials: { fundId: "fund-1", holdingId: "holding-1", companyId: "company-1", periodicity: "quarterly" as const } };
const command: CreateExportScheduleCommand = { idempotencyKey: "key-1", label: "Monthly sparrow", scope: positionScope, format: "csv", trigger: "monthly", notifyOnCompletion: true };

function scheduleRow(overrides: PostgresRow = {}): PostgresRow {
  return {
    tenant_id: TENANT, schedule_id: SCHEDULE, workspace_id: WORKSPACE, owner_auth_method: "oidc", owner_subject: "idp|owner",
    label: "Monthly sparrow", scope: positionScope, scope_label: "Position financials · company-1 · quarterly", format: "csv", trigger_kind: "monthly",
    status: "active", stop_reason: null, notify_on_completion: true, next_run_at: "2026-11-01 00:00:00+00", publish_watermark: null,
    created_at: "2026-10-01 10:00:00.123456+00", updated_at: "2026-10-01 10:00:00.123456+00", cursor_created_at: "2026-10-01T10:00:00.123456Z", ...overrides,
  };
}

function runRow(overrides: PostgresRow = {}): PostgresRow {
  return {
    run_id: RUN, schedule_id: SCHEDULE, trigger_key: "monthly:2026-10", outcome: "requested", export_id: EXPORT, failure_reason: null,
    created_at: "2026-10-01 00:00:05.5+00", schedule_label: "Monthly sparrow", scope_label: "Position financials · company-1 · quarterly", format: "csv",
    export_state: "complete", cursor_created_at: "2026-10-01T00:00:05.500000Z", ...overrides,
  };
}

type Call = { sql: string; parameters: PostgresPrimitive[] };
class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  readonly executed: Call[] = [];
  private readonly handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[];
  constructor(handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[] = () => []) { this.handler = handler; }
  async query(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); return this.handler(sql, parameters); }
  async execute(sql: string, parameters: PostgresPrimitive[] = []) { this.executed.push({ sql, parameters }); }
  async health() { return true; }
}

// The worker counts every run as a metric; keep the TAP stream readable.
console.info = () => undefined;

const refusal = (code: string, status: number) => (error: unknown) => error instanceof ExportScheduleRequestError && error.code === code && error.status === status;
const allow = async () => undefined;

test("visibility helpers: the owner, an Organization Admin and nobody else", () => {
  assert.equal(isUuid(SCHEDULE), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isTenantAdminIdentity(admin), true);
  assert.equal(isTenantAdminIdentity(identity({ roles: ["admin"] })), false, "a workspace admin is not an Organization Admin");
  assert.doesNotThrow(() => assertCanViewAll(admin));
  assert.throws(() => assertCanViewAll(identity()), refusal("tenant_admin_required", 403));
  assert.equal(scheduleSessionId(SCHEDULE), `export-schedule:${SCHEDULE}`);
});

test("the fingerprint binds the whole schedule and ignores nothing that is part of it", () => {
  const base = scheduleFingerprint(command);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(scheduleFingerprint({ ...command, idempotencyKey: "another-key" }), base, "the key itself is not part of the content");
  assert.notEqual(scheduleFingerprint({ ...command, label: "other" }), base);
  assert.notEqual(scheduleFingerprint({ ...command, format: "xlsx" }), base);
  assert.notEqual(scheduleFingerprint({ ...command, trigger: "quarterly" }), base);
  assert.notEqual(scheduleFingerprint({ ...command, notifyOnCompletion: false }), base, "the same key with the other notification choice is a different schedule");
  assert.notEqual(scheduleFingerprint({ ...command, scope: { snapshotId: SNAPSHOT } }), base);
  assert.notEqual(scheduleFingerprint({ ...command, scope: { positionFinancials: { ...positionScope.positionFinancials, portfolioId: "pf-1" } } }), base);
  assert.notEqual(scheduleFingerprint({ ...command, scope: { positionFinancials: { ...positionScope.positionFinancials, periodicity: "annual" } } }), base);
  assert.equal(scheduleFingerprint({ ...command, scope: { snapshotId: SNAPSHOT } }), scheduleFingerprint({ ...command, scope: { snapshotId: SNAPSHOT } }));
  const scorecard = scheduleFingerprint({ ...command, scope: { performanceScorecard: true } });
  assert.notEqual(scorecard, base);
  assert.notEqual(scheduleFingerprint({ ...command, scope: { performanceScorecard: true, fundId: "fund-1" } }), scorecard, "a fund filter is a different schedule");
  assert.notEqual(scheduleFingerprint({ ...command, scope: { performanceScorecard: true, period: "Q1 2026" } }), scorecard, "a period filter is a different schedule");
  assert.notEqual(scheduleFingerprint({ ...command, scope: { performanceScorecard: true, fundId: "fund-1", period: "Q1 2026" } }), scheduleFingerprint({ ...command, scope: { performanceScorecard: true, period: "Q1 2026" } }));
  assert.equal(scheduleFingerprint({ ...command, scope: { performanceScorecard: true, fundId: "fund-1" } }), scheduleFingerprint({ ...command, scope: { performanceScorecard: true, fundId: "fund-1" } }));
});

test("the audit event carries identifiers, the label, the trigger and the status, and never data", () => {
  const event = exportScheduleAuditEvent(identity(), "corr-1", "export_schedule.pause", { scheduleId: SCHEDULE, label: "Monthly sparrow", trigger: "monthly", format: "csv", status: "paused" });
  assert.deepEqual(
    { ...event, id: "-", occurredAt: "-" },
    {
      id: "-", occurredAt: "-", tenantId: TENANT, workspaceId: WORKSPACE, actorSubject: "idp|owner", sessionId: "session-1", action: "export_schedule.pause",
      targetType: "export_schedule", targetId: SCHEDULE, outcome: "success", correlationId: "corr-1",
      metadata: { label: "Monthly sparrow", trigger: "monthly", format: "csv", status: "paused" },
    },
  );
  assert.match(event.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(event.occurredAt)));
  const notify = exportScheduleAuditEvent(identity(), "corr-2", "export_schedule.notify", { scheduleId: SCHEDULE, label: "Monthly sparrow", trigger: "monthly", format: "csv", status: "active" }, { notifyOnCompletion: false });
  assert.deepEqual(notify.metadata, { label: "Monthly sparrow", trigger: "monthly", format: "csv", status: "active", notifyOnCompletion: false });
});

test("run rows map to runs with RFC 3339 times, the export's delivery state and only a known failure reason", () => {
  const delivered = toExportScheduleRun(runRow());
  assert.deepEqual(delivered, {
    runId: RUN, scheduleId: SCHEDULE, scheduleLabel: "Monthly sparrow", scopeLabel: "Position financials · company-1 · quarterly", format: "csv",
    triggerKey: "monthly:2026-10", createdAt: "2026-10-01T00:00:05.500Z", outcome: "requested", exportId: EXPORT, exportState: "complete",
  });
  const refused = toExportScheduleRun(runRow({ outcome: "failed", export_id: null, export_state: null, failure_reason: "redistribution_not_permitted" }));
  assert.equal(refused.outcome, "failed");
  assert.equal(refused.failureReason, "redistribution_not_permitted");
  assert.equal("exportId" in refused, false);
  assert.equal("exportState" in refused, false);
  assert.equal("failureReason" in toExportScheduleRun(runRow({ failure_reason: "free text that is not a reason" })), false, "an unknown reason is never passed on");
  assert.throws(() => toExportScheduleRun(runRow({ format: "pdf" })), /unexpected export schedule value/);
});

test("schedule rows map to schedules, with ownership from the caller's identity and the next run only while one is due", () => {
  const mine = toExportSchedule(scheduleRow(), identity(), null);
  assert.equal(mine.ownedByMe, true);
  assert.equal(mine.owner, "idp|owner");
  assert.equal(mine.nextRunAt, "2026-11-01T00:00:00.000Z");
  assert.equal(mine.createdAt, "2026-10-01T10:00:00.123Z");
  assert.equal(mine.stopReason, null);
  assert.equal(mine.lastRun, null);
  assert.deepEqual(mine.scope, positionScope);
  assert.equal(mine.trigger, "monthly");
  assert.equal(mine.notifyOnCompletion, true);
  assert.equal(toExportSchedule(scheduleRow({ notify_on_completion: "true" }), identity(), null).notifyOnCompletion, true, "a driver that returns booleans as text is understood");
  assert.equal(toExportSchedule(scheduleRow({ notify_on_completion: false }), identity(), null).notifyOnCompletion, false);

  const theirs = toExportSchedule(scheduleRow({ status: "stopped", stop_reason: "owner_inactive", next_run_at: null }), admin, toExportScheduleRun(runRow()));
  assert.equal(theirs.ownedByMe, false, "an Organization Admin sees it but does not own it");
  assert.equal(theirs.stopReason, "owner_inactive");
  assert.equal(theirs.nextRunAt, null);
  assert.equal(theirs.lastRun?.runId, RUN);
  assert.equal(toExportSchedule(scheduleRow(), identity({ authMethod: "saml" }), null).ownedByMe, false, "the same subject text under another auth method is another person");

  assert.throws(() => toExportSchedule(scheduleRow({ status: "deleted" }), identity(), null), /unexpected export schedule value/);
  assert.throws(() => toExportSchedule(scheduleRow({ trigger_kind: "weekly" }), identity(), null), /unexpected export schedule value/);
  assert.throws(() => toExportSchedule(scheduleRow({ stop_reason: "boredom" }), identity(), null), /unexpected export schedule value/);
});

test("a scope is only schedulable by someone entitled to its fund, and a missing snapshot is refused the same way", async () => {
  const db = new FakeDb();
  await assertScopeEntitled(identity(), positionScope, db);
  assert.equal(db.calls.length, 0, "a position scope names its fund, no lookup");
  await assert.rejects(assertScopeEntitled(identity(), { positionFinancials: { ...positionScope.positionFinancials, fundId: "fund-9" } }, db), refusal("export_scope_not_entitled", 403));
  await assert.rejects(assertScopeEntitled(identity({ entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } }), positionScope, db), refusal("export_scope_not_entitled", 403), "no fund list fails closed");
  await assert.rejects(assertScopeEntitled(identity(), { snapshotId: "not-a-uuid" }, db), refusal("invalid_scope", 400));

  const known = new FakeDb(() => [{ fund_id: "fund-1" }]);
  await assertScopeEntitled(identity(), { snapshotId: SNAPSHOT }, known);
  assert.match(known.calls[0]!.sql, /s\.tenant_id=\$1::uuid and s\.snapshot_id=\$2::uuid and s\.status='published'/);
  assert.deepEqual(known.calls[0]!.parameters, [TENANT, SNAPSHOT]);
  await assert.rejects(assertScopeEntitled(identity(), { snapshotId: SNAPSHOT }, new FakeDb(() => [])), refusal("export_scope_not_entitled", 403), "an unknown or unpublished snapshot");
  await assert.rejects(assertScopeEntitled(identity(), { snapshotId: SNAPSHOT }, new FakeDb(() => [{ fund_id: "fund-1" }, { fund_id: "fund-9" }])), refusal("export_scope_not_entitled", 403), "every fund behind the snapshot must be entitled");
  await assert.rejects(assertScopeEntitled(identity({ entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } }), { snapshotId: SNAPSHOT }, known), refusal("export_scope_not_entitled", 403));
});

test("a scorecard scope is schedulable by someone entitled to a fund: every fund they hold now, or the one fund it names", async () => {
  const db = new FakeDb();
  await assertScopeEntitled(identity(), { performanceScorecard: true }, db);
  await assertScopeEntitled(identity(), { performanceScorecard: true, period: "Q1 2026" }, db);
  await assertScopeEntitled(identity(), { performanceScorecard: true, fundId: "fund-2" }, db);
  assert.equal(db.calls.length, 0, "decided from the owner's entitlements alone");
  const none = identity({ entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } });
  await assert.rejects(assertScopeEntitled(none, { performanceScorecard: true }, db), refusal("export_scope_not_entitled", 403), "all funds is nothing without any fund");
  await assert.rejects(assertScopeEntitled(identity({ entitlements: { workspaceIds: [], fundIds: [], sourceDocumentAccessAllowed: false } }), { performanceScorecard: true }, db), refusal("export_scope_not_entitled", 403));
  await assert.rejects(assertScopeEntitled(identity(), { performanceScorecard: true, fundId: "fund-9" }, db), refusal("export_scope_not_entitled", 403), "a fund filter never grants a fund");
  await assert.rejects(assertScopeEntitled(none, { performanceScorecard: true, fundId: "fund-1" }, db), refusal("export_scope_not_entitled", 403));
});

test("a scorecard schedule is saved with its scope, its filters and the one wording its exports carry", async () => {
  const db = new FakeDb((sql, parameters) => sql.includes("create_export_schedule") ? [scheduleRow({ schedule_id: parameters[1], scope: JSON.parse(String(parameters[8])), scope_label: parameters[9] })] : []);
  const backend = new PostgresExportScheduleBackend(() => db, allow);
  const scope = { performanceScorecard: true as const, fundId: "fund-1", period: "Q1 2026" };
  const { item } = await backend.create(identity(), { ...command, scope, trigger: "on_publish" }, db);
  const save = db.calls.find((call) => call.sql.includes("create_export_schedule"))!;
  assert.deepEqual(save.parameters.slice(7, 12), ["Monthly sparrow", JSON.stringify(scope), "Performance scorecard · fund-1 · Q1 2026", "csv", "on_publish"]);
  assert.deepEqual(item.scope, scope);
  await assert.rejects(backend.create(identity(), { ...command, scope: { performanceScorecard: true, fundId: "fund-9" } }, db), refusal("export_scope_not_entitled", 403));
});

test("the Parquet format gate is the same feature flag an interactive export request goes through", async () => {
  const gates = new FakeDb();
  await defaultFormatGate(identity(), "csv", gates);
  await defaultFormatGate(identity(), "xlsx", gates);
  assert.equal(gates.calls.length, 0, "only Parquet is gated");

  const disabled = new FakeDb(() => []);
  await assert.rejects(defaultFormatGate(identity(), "parquet", disabled), FeatureFlagDeniedError);
  assert.ok(disabled.calls.some((call) => call.sql.includes("corvis_control.feature_flag ")));

  const enabled = new FakeDb((sql) => sql.includes("from corvis_control.feature_flag ")
    ? [{ flag_key: "exports.parquet_delivery", enabled: true, kill_switch: false, configuration: {} }] : []);
  await defaultFormatGate(identity(), "parquet", enabled);
});

// ---------------------------------------------------------------------------
// The Postgres backend
// ---------------------------------------------------------------------------

test("creating a schedule re-checks what the owner may export, then saves it once per idempotency key", async () => {
  const gated: Array<[string, string]> = [];
  const db = new FakeDb((sql) => {
    if (sql.includes("create_export_schedule")) return [scheduleRow()];
    if (sql.includes("distinct on (r.schedule_id)")) return [runRow()];
    return [];
  });
  const backend = new PostgresExportScheduleBackend(() => db, async (who, format) => { gated.push([who.subject, format]); });
  const { item, created } = await backend.create(identity(), command, db);
  assert.equal(created === false, true, "the row returned is not the id this call generated, so it is a replay");
  assert.equal(item.scheduleId, SCHEDULE);
  assert.equal(item.lastRun?.exportState, "complete");
  assert.deepEqual(gated, [["idp|owner", "csv"]]);
  const save = db.calls.find((call) => call.sql.includes("create_export_schedule"))!;
  assert.deepEqual(save.parameters.slice(0, 1), [TENANT]);
  assert.equal(save.parameters[2], WORKSPACE);
  assert.deepEqual(save.parameters.slice(3, 6), ["oidc", "idp|owner", "key-1"]);
  assert.equal(save.parameters[6], scheduleFingerprint(command));
  assert.deepEqual(save.parameters.slice(7), ["Monthly sparrow", JSON.stringify(positionScope), "Position financials · company-1 · quarterly", "csv", "monthly", true]);
  assert.match(save.sql, /\$13::boolean/, "the owner's notification choice is saved with the schedule");
  await backend.create(identity(), { ...command, notifyOnCompletion: false }, db);
  assert.equal(db.calls.filter((call) => call.sql.includes("create_export_schedule")).at(-1)!.parameters.at(-1), false);

  // A new schedule is the row whose id is the one this call generated.
  const fresh = new FakeDb((sql, parameters) => sql.includes("create_export_schedule") ? [scheduleRow({ schedule_id: parameters[1] })] : []);
  const result = await new PostgresExportScheduleBackend(() => fresh, allow).create(identity(), command, fresh);
  assert.equal(result.created, true);
  assert.equal(result.item.lastRun, null);

  // The default connection is used when none is passed.
  const defaulted = new FakeDb((sql, parameters) => sql.includes("create_export_schedule") ? [scheduleRow({ schedule_id: parameters[1] })] : []);
  assert.equal((await new PostgresExportScheduleBackend(() => defaulted, allow).create(identity(), command)).created, true);
  assert.ok(defaulted.calls.length > 0);
});

test("a schedule cannot be saved without the owner's current rights, a usable workspace, an enabled format and an entitled scope", async () => {
  const db = new FakeDb(() => [scheduleRow()]);
  const backend = new PostgresExportScheduleBackend(() => db, allow);
  await assert.rejects(backend.create(identity({ workspaceId: "workspace_demo" }), command, db), refusal("invalid_workspace", 400));
  await assert.rejects(backend.create(identity({ entitlements: { workspaceIds: [WORKSPACE], fundIds: ["fund-1"], sourceDocumentAccessAllowed: false, redistributionAllowed: false } }), command, db), AuthorizationError);
  await assert.rejects(backend.create(identity({ entitlements: { workspaceIds: [WORKSPACE], fundIds: ["fund-1"], sourceDocumentAccessAllowed: false } }), command, db), AuthorizationError, "redistribution must be explicitly allowed");
  const closed = new PostgresExportScheduleBackend(() => db, async () => { throw new FeatureFlagDeniedError({ key: "exports.parquet_delivery", channel: "export", enabled: false, reason: "not_configured", config: {} }); });
  await assert.rejects(closed.create(identity(), { ...command, format: "parquet" }, db), FeatureFlagDeniedError);
  await assert.rejects(backend.create(identity(), { ...command, scope: { positionFinancials: { ...positionScope.positionFinancials, fundId: "fund-9" } } }, db), refusal("export_scope_not_entitled", 403));
  assert.equal(db.calls.some((call) => call.sql.includes("create_export_schedule")), false, "nothing is written once a check fails");

  const empty = new FakeDb(() => []);
  await assert.rejects(new PostgresExportScheduleBackend(() => empty, allow).create(identity(), command, empty), /export schedule was not created/);
});

test("the list is the caller's own schedules, or every schedule in the tenant, newest first with the latest run of each", async () => {
  const db = new FakeDb((sql) => {
    if (sql.includes("from corvis_control.export_schedule s where")) return [scheduleRow(), scheduleRow({ schedule_id: SECOND_SCHEDULE, cursor_created_at: "2026-09-01T10:00:00.000000Z", created_at: "2026-09-01 10:00:00+00" })];
    if (sql.includes("distinct on (r.schedule_id)")) return [runRow({ schedule_id: SCHEDULE })];
    return [];
  });
  const backend = new PostgresExportScheduleBackend(() => db);
  const mine = await backend.list(identity(), { scope: "mine", limit: 10 }, db);
  assert.deepEqual(mine.items.map((item) => item.scheduleId), [SCHEDULE, SECOND_SCHEDULE]);
  assert.equal(mine.items[0]!.lastRun?.runId, RUN);
  assert.equal(mine.items[1]!.lastRun, null);
  assert.equal(mine.nextCursor, null);
  const query = db.calls[0]!;
  assert.match(query.sql, /s\.tenant_id=\$1::uuid and s\.status<>'deleted' and s\.owner_auth_method=\$2 and s\.owner_subject=\$3/);
  assert.match(query.sql, /order by s\.created_at desc,s\.schedule_id desc limit \$4::integer/);
  assert.deepEqual(query.parameters, [TENANT, "oidc", "idp|owner", 11]);
  const runLookup = db.calls[1]!;
  assert.deepEqual(runLookup.parameters, [TENANT, JSON.stringify([SCHEDULE, SECOND_SCHEDULE])]);

  const all = new FakeDb(() => []);
  assert.deepEqual(await new PostgresExportScheduleBackend(() => all).list(admin, { scope: "all", limit: 5 }, all), { items: [], nextCursor: null });
  assert.doesNotMatch(all.calls[0]!.sql, /owner_subject/, "the whole tenant is not narrowed to an owner");
  assert.equal(all.calls.length, 1, "no runs are looked up for an empty page");

  const defaulted = new FakeDb(() => []);
  await new PostgresExportScheduleBackend(() => defaulted).list(identity(), { scope: "mine", limit: 1 });
  assert.equal(defaulted.calls.length, 1);
});

test("paging is keyset over (created_at, id): the cursor carries the last row and a tampered one never reaches SQL", async () => {
  const rows = [scheduleRow(), scheduleRow({ schedule_id: SECOND_SCHEDULE, cursor_created_at: "2026-09-01T10:00:00.000001Z" })];
  const db = new FakeDb((sql) => sql.includes("from corvis_control.export_schedule s where") ? rows : []);
  const backend = new PostgresExportScheduleBackend(() => db);
  const first = await backend.list(identity(), { scope: "mine", limit: 1 }, db);
  assert.equal(first.items.length, 1);
  assert.equal(decodeCursor(first.nextCursor!), `2026-10-01T10:00:00.123456Z|${SCHEDULE}`);

  const second = await backend.list(identity(), { scope: "mine", limit: 1, cursor: first.nextCursor }, db);
  const keyset = db.calls.filter((call) => call.sql.includes("(s.created_at,s.schedule_id) <"))[0]!;
  assert.deepEqual(keyset.parameters.slice(3, 5), ["2026-10-01T10:00:00.123456Z", SCHEDULE]);
  assert.equal(second.items.length, 1);

  const calls = db.calls.length;
  const tampered = [
    "garbage", encodeCursor("no-separator"), encodeCursor(`2026-10-01|${SCHEDULE}`), encodeCursor(`2026-10-01T10:00:00.123456Z|not-a-uuid`),
    encodeCursor(`2026-02-30T10:00:00.123456Z|${SCHEDULE}`), encodeCursor(`2026-10-01T24:00:00.123456Z|${SCHEDULE}`), encodeCursor(`0000-10-01T10:00:00.123456Z|${SCHEDULE}`),
  ];
  for (const cursor of tampered) {
    await assert.rejects(backend.list(identity(), { scope: "mine", limit: 1, cursor }, db), InvalidCursorError, cursor);
    await assert.rejects(backend.listRuns(identity(), { scope: "mine", limit: 1, cursor }, db), InvalidCursorError, cursor);
  }
  assert.equal(db.calls.length, calls, "no tampered cursor reached the database");
  assert.equal((await backend.list(identity(), { scope: "mine", limit: 1, cursor: encodeCursor(`2026-10-01T10:00:00.123456Z|${SCHEDULE.toUpperCase()}`) }, db)).items.length, 1, "ids are case-insensitive");
});

test("one schedule is read by its owner or an Organization Admin, and a missing, foreign, deleted or malformed id is the same 404", async () => {
  const db = new FakeDb((sql) => {
    if (sql.includes("select s.* from corvis_control.export_schedule s")) return [scheduleRow()];
    if (sql.includes("distinct on (r.schedule_id)")) return [runRow()];
    return [];
  });
  const backend = new PostgresExportScheduleBackend(() => db);
  const owned = await backend.get(identity(), SCHEDULE, db);
  assert.equal(owned.lastRun?.exportId, EXPORT);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, SCHEDULE, false, "oidc", "idp|owner"]);
  await backend.get(admin, SCHEDULE, db);
  assert.equal(db.calls.filter((call) => call.sql.includes("select s.* from"))[1]!.parameters[2], true, "an Organization Admin is not narrowed to an owner");

  const none = new FakeDb(() => []);
  await assert.rejects(new PostgresExportScheduleBackend(() => none).get(identity(), SCHEDULE), refusal("export_schedule_not_found", 404));
  const before = db.calls.length;
  await assert.rejects(backend.get(identity(), "not-a-uuid", db), refusal("export_schedule_not_found", 404));
  assert.equal(db.calls.length, before, "a malformed id never reaches the ::uuid cast");
});

test("only the owner pauses, resumes or deletes: the SQL function is keyed on the owner's identity, and anyone else finds nothing", async () => {
  const db = new FakeDb((sql, parameters) => {
    if (sql.includes("set_export_schedule_status")) return [scheduleRow({ status: parameters[4] === "pause" ? "paused" : parameters[4] === "delete" ? "deleted" : "active", next_run_at: null })];
    if (sql.includes("distinct on (r.schedule_id)")) return [runRow()];
    return [];
  });
  const backend = new PostgresExportScheduleBackend(() => db);
  const paused = await backend.setStatus(identity(), SCHEDULE, "pause", db);
  assert.equal(paused.status, "paused");
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, SCHEDULE, "oidc", "idp|owner", "pause"]);
  assert.equal((await backend.setStatus(identity(), SCHEDULE, "resume", db)).status, "active");
  assert.deepEqual(await backend.remove(identity(), SCHEDULE, db), { scheduleId: SCHEDULE, label: "Monthly sparrow", trigger: "monthly", format: "csv" });
  assert.equal(db.calls.filter((call) => call.sql.includes("set_export_schedule_status")).at(-1)!.parameters[4], "delete");

  const none = new FakeDb(() => []);
  const empty = new PostgresExportScheduleBackend(() => none);
  await assert.rejects(empty.setStatus(admin, SCHEDULE, "pause"), refusal("export_schedule_not_found", 404), "an Organization Admin does not own it");
  await assert.rejects(empty.remove(admin, SCHEDULE), refusal("export_schedule_not_found", 404));
  const before = none.calls.length;
  await assert.rejects(empty.setStatus(identity(), "not-a-uuid", "pause"), refusal("export_schedule_not_found", 404));
  await assert.rejects(empty.remove(identity(), "not-a-uuid"), refusal("export_schedule_not_found", 404));
  assert.equal(none.calls.length, before);
});

test("only the owner switches the emails about a schedule, keyed on their identity, and anyone else finds nothing", async () => {
  const db = new FakeDb((sql, parameters) => {
    if (sql.includes("set_export_schedule_notification")) return [scheduleRow({ notify_on_completion: parameters[4] })];
    if (sql.includes("distinct on (r.schedule_id)")) return [runRow()];
    return [];
  });
  const backend = new PostgresExportScheduleBackend(() => db);
  const off = await backend.setNotification(identity(), SCHEDULE, false, db);
  assert.equal(off.notifyOnCompletion, false);
  assert.equal(off.lastRun?.runId, RUN);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, SCHEDULE, "oidc", "idp|owner", false]);
  assert.equal((await backend.setNotification(identity(), SCHEDULE, true)).notifyOnCompletion, true, "the default connection is used when none is passed");

  const none = new FakeDb(() => []);
  const empty = new PostgresExportScheduleBackend(() => none);
  await assert.rejects(empty.setNotification(admin, SCHEDULE, false), refusal("export_schedule_not_found", 404), "an Organization Admin does not own it");
  const before = none.calls.length;
  await assert.rejects(empty.setNotification(identity(), "not-a-uuid", false), refusal("export_schedule_not_found", 404));
  assert.equal(none.calls.length, before, "a malformed id never reaches SQL");
});

test("the run history joins each run to its schedule and its export's delivery state, scoped to the caller unless an Organization Admin asks for all", async () => {
  const db = new FakeDb(() => [runRow(), runRow({ run_id: "6f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f", cursor_created_at: "2026-09-01T00:00:05.000000Z", outcome: "failed", export_id: null, export_state: null, failure_reason: "owner_inactive" })]);
  const backend = new PostgresExportScheduleBackend(() => db);
  const page = await backend.listRuns(identity(), { scope: "mine", limit: 1 }, db);
  assert.equal(page.items.length, 1);
  assert.equal(decodeCursor(page.nextCursor!), `2026-10-01T00:00:05.500000Z|${RUN}`);
  assert.match(db.calls[0]!.sql, /left join corvis_serving\.export_job j on j\.tenant_id=r\.tenant_id and j\.export_id=r\.export_id/);
  assert.match(db.calls[0]!.sql, /r\.tenant_id=\$1::uuid and s\.owner_auth_method=\$2 and s\.owner_subject=\$3/);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, "oidc", "idp|owner", 2]);

  const everyone = await backend.listRuns(admin, { scope: "all", limit: 10, scheduleId: SCHEDULE, cursor: page.nextCursor }, db);
  assert.equal(everyone.items.length, 2);
  assert.equal(everyone.nextCursor, null);
  assert.doesNotMatch(db.calls[1]!.sql, /owner_subject/);
  assert.match(db.calls[1]!.sql, /r\.schedule_id=\$2::uuid/);
  assert.match(db.calls[1]!.sql, /\(r\.created_at,r\.run_id\) < \(\$3::timestamptz,\$4::uuid\)/);
  assert.deepEqual(db.calls[1]!.parameters, [TENANT, SCHEDULE, "2026-10-01T00:00:05.500000Z", RUN, 11]);

  const before = db.calls.length;
  await assert.rejects(backend.listRuns(identity(), { scope: "mine", limit: 5, scheduleId: "not-a-uuid" }, db), refusal("export_schedule_not_found", 404));
  assert.equal(db.calls.length, before);
  const defaulted = new FakeDb(() => []);
  assert.deepEqual(await new PostgresExportScheduleBackend(() => defaulted).listRuns(identity(), { scope: "mine", limit: 5 }), { items: [], nextCursor: null });
});

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

const authorization: MembershipAuthorization = {
  roles: ["analyst"], workspaceIds: [WORKSPACE], fundIds: ["fund-1"], documentIds: ["doc-1"], sourceDocumentIds: [], internalAnalyticsAllowed: false,
  modelTrainingAllowed: false, redistributionAllowed: true, isTenantAdmin: false, memberships: [],
};

type Runner = {
  db: FakeDb;
  audits: () => Array<{ action: string; outcome: string; actor: string; target: string; metadata: Record<string, unknown> }>;
  runs: () => PostgresPrimitive[][];
};

function runner(options: { due?: PostgresRow[]; claim?: PostgresRow | null; schedule?: PostgresRow; stopInactive?: PostgresRow[]; stopOne?: PostgresRow[] } = {}): Runner {
  const db = new FakeDb((sql) => {
    if (sql.includes("stop_export_schedules_for_inactive_owners")) return options.stopInactive ?? [];
    if (sql.includes("list_due_export_schedules")) return options.due ?? [{ tenant_id: TENANT, schedule_id: SCHEDULE }];
    if (sql.includes("claim_export_schedule_trigger")) return options.claim === null ? [] : [options.claim ?? { trigger_key: "monthly:2026-10", snapshot_id: null, snapshot_version: null }];
    if (sql.includes("from corvis_control.export_schedule where")) return [options.schedule ?? scheduleRow()];
    if (sql.includes("stop_export_schedule(")) return options.stopOne ?? [];
    return [];
  });
  return {
    db,
    audits: () => db.executed.filter((call) => call.sql.includes("insert into corvis_control.audit_event")).map((call) => {
      const metadata = JSON.parse(String(call.parameters[10])) as Record<string, unknown>;
      return { action: String(call.parameters[5]), outcome: String(call.parameters[8]), actor: String(call.parameters[4]), target: String(call.parameters[7]), metadata };
    }),
    runs: () => db.executed.filter((call) => call.sql.includes("insert into corvis_control.export_schedule_run")).map((call) => call.parameters),
  };
}

const exportedManifest = { exportId: EXPORT } as Awaited<ReturnType<NonNullable<Parameters<typeof processDueExportSchedules>[1]>["requestExport"] & (() => never)>>;

test("a due schedule is re-authorized as its owner, exported through the governed pipeline and recorded in one transaction", async () => {
  const seen: Array<{ principal?: unknown; identity?: RequestIdentity; format?: string; options?: unknown; store?: unknown }> = [];
  const { db, audits, runs } = runner();
  const summary = await processDueExportSchedules(7, {
    authorize: async (store, principal) => { seen.push({ principal, store }); return authorization; },
    formatGate: async (who, format, store) => { seen.push({ identity: who, format, store }); },
    requestExport: async (who, format, options, store) => { seen.push({ identity: who, format, options, store }); return exportedManifest; },
  }, db);
  assert.deepEqual(summary, { stopped: 0, requested: 1, failed: 0, errors: 0 });

  const principal = seen[0]!.principal as Record<string, unknown>;
  assert.deepEqual(principal, { tenantId: TENANT, workspaceId: WORKSPACE, subject: "idp|owner", authMethod: "oidc", sessionId: scheduleSessionId(SCHEDULE) });
  const request = seen.find((entry) => entry.options)!;
  assert.deepEqual(request.options, { scope: positionScope, source: "delivery" }, "the same governed request an interactive export makes");
  assert.equal(request.format, "csv");
  assert.deepEqual(request.identity!.entitlements, {
    workspaceIds: [WORKSPACE], fundIds: ["fund-1"], documentIds: ["doc-1"], sourceDocumentIds: [], sourceDocumentAccessAllowed: false,
    internalAnalyticsAllowed: false, modelTrainingAllowed: false, redistributionAllowed: true,
  });
  assert.deepEqual(request.identity!.roles, ["analyst"]);
  assert.equal(request.identity!.subject, "idp|owner");
  assert.equal(request.identity!.sessionId, scheduleSessionId(SCHEDULE), "never a user's revocable session");
  assert.ok(seen.every((entry) => entry.store === undefined || entry.store === db), "every step runs on the one transaction handle");

  assert.equal(runs().length, 1);
  assert.deepEqual(runs()[0]!.slice(0, 1), [TENANT]);
  assert.deepEqual(runs()[0]!.slice(2), [SCHEDULE, "monthly:2026-10", "requested", EXPORT, null]);
  assert.deepEqual(audits().map(({ action, outcome, actor, target }) => ({ action, outcome, actor, target })), [{ action: "export_schedule.run", outcome: "success", actor: "idp|owner", target: SCHEDULE }]);
  assert.deepEqual(audits()[0]!.metadata, { sessionId: scheduleSessionId(SCHEDULE), triggerKey: "monthly:2026-10", format: "csv", exportId: EXPORT });
  assert.deepEqual(db.calls.find((call) => call.sql.includes("list_due_export_schedules"))!.parameters, [7]);
  assert.equal(db.calls.some((call) => call.sql.includes("emit_export_schedule_run_event")), false, "a requested run announces nothing yet: its export has not finished");
});

test("every statement of a run goes through the transaction handle when the transport has one, and nothing is recorded when the export request throws", async () => {
  const outer = runner();
  const inner = new FakeDb((sql) => sql.includes("claim_export_schedule_trigger") ? [{ trigger_key: "monthly:2026-10" }] : sql.includes("from corvis_control.export_schedule where") ? [scheduleRow()] : []);
  let transactions = 0;
  const store: PostgresSqlApi = {
    query: (sql, parameters) => outer.db.query(sql, parameters),
    execute: (sql, parameters) => outer.db.execute(sql, parameters),
    health: async () => true,
    transaction: async (fn) => { transactions += 1; return fn(inner); },
  };
  const summary = await processDueExportSchedules(5, {
    authorize: async () => authorization, formatGate: allow,
    requestExport: async () => { throw new Error("postgres_unavailable"); },
  }, store);
  assert.equal(summary.errors, 1, "an unexpected error is retried next tick, not recorded as a refused run");
  assert.equal(inner.executed.length, 0, "the claim is released with the transaction: no run, no audit");
  assert.equal(outer.runs().length, 0);
  assert.equal(transactions, 2, "one for stopping inactive owners, one for the schedule");
  assert.ok(inner.calls.some((call) => call.sql.includes("claim_export_schedule_trigger")), "the claim ran inside the transaction");
});

test("nothing due, nothing claimed: no export and no run", async () => {
  const idle = runner({ due: [] });
  assert.deepEqual(await processDueExportSchedules(25, {}, idle.db), { stopped: 0, requested: 0, failed: 0, errors: 0 });
  assert.equal(idle.db.executed.length, 0);

  // Another worker claimed it first (or the trigger already has a run): the claim returns nothing.
  const lost = runner({ claim: null });
  let exported = false;
  const summary = await processDueExportSchedules(25, { authorize: async () => authorization, formatGate: allow, requestExport: async () => { exported = true; return exportedManifest; } }, lost.db);
  assert.deepEqual(summary, { stopped: 0, requested: 0, failed: 0, errors: 0 });
  assert.equal(exported, false);
  assert.equal(lost.runs().length, 0);
});

test("an owner who can no longer be authorized fails the run closed, stops the schedule and exports nothing", async () => {
  const { db, audits, runs } = runner({ stopOne: [scheduleRow({ status: "stopped", stop_reason: "owner_inactive" })] });
  let exported = false;
  const summary = await processDueExportSchedules(25, { authorize: async () => null, formatGate: allow, requestExport: async () => { exported = true; return exportedManifest; } }, db);
  assert.deepEqual(summary, { stopped: 0, requested: 0, failed: 1, errors: 0 });
  assert.equal(exported, false, "nothing is exported when the owner cannot be re-authorized");
  assert.deepEqual(runs()[0]!.slice(2), [SCHEDULE, "monthly:2026-10", "failed", null, "owner_inactive"]);
  assert.deepEqual(db.calls.find((call) => call.sql.includes("emit_export_schedule_run_event"))!.parameters.slice(2), ["owner_inactive"], "a fail-closed refusal is announced too");
  assert.deepEqual(audits().map((entry) => [entry.action, entry.outcome, entry.actor]), [["export_schedule.stop", "success", "system:export-scheduler"], ["export_schedule.run", "failure", "idp|owner"]]);
  assert.deepEqual(audits()[0]!.metadata, { sessionId: scheduleSessionId(SCHEDULE), label: "Monthly sparrow", reason: "owner_inactive", owner: "idp|owner" });
  assert.deepEqual(audits()[1]!.metadata, { sessionId: scheduleSessionId(SCHEDULE), triggerKey: "monthly:2026-10", format: "csv", reason: "owner_inactive" });
  assert.ok(db.calls.some((call) => call.sql.includes("stop_export_schedule(") && call.parameters[0] === TENANT && call.parameters[1] === SCHEDULE));

  // Already stopped by someone else in the meantime: the run is still recorded as failed, with no second stop audit.
  const raced = runner();
  await processDueExportSchedules(25, { authorize: async () => null, formatGate: allow, requestExport: async () => exportedManifest }, raced.db);
  assert.deepEqual(raced.audits().map((entry) => entry.action), ["export_schedule.run"]);
});

test("each way re-authorization can refuse is recorded as one stable failed run, never exported", async () => {
  const cases: Array<{ name: string; reason: string; roles?: Array<"analyst" | "read_only">; formatGate?: () => Promise<void>; requestExport?: () => Promise<never> }> = [
    { name: "export permission revoked", reason: "export_permission_revoked", roles: ["read_only"] },
    { name: "redistribution no longer permitted", reason: "redistribution_not_permitted", requestExport: async () => { throw new AuthorizationError("data_rights:redistribution"); } },
    { name: "the scope no longer resolves", reason: "scope_unavailable", requestExport: async () => { throw new AuthorizationError("exports:scope"); } },
    { name: "another denial", reason: "scope_not_entitled", requestExport: async () => { throw new AuthorizationError("documents:read"); } },
    { name: "the owner lost the fund", reason: "scope_not_entitled", requestExport: async () => { throw new ExportScheduleRequestError("export_scope_not_entitled", 403); } },
    { name: "the format flag was turned off", reason: "format_unavailable", formatGate: async () => { throw new FeatureFlagDeniedError({ key: "exports.parquet_delivery", channel: "export", enabled: false, reason: "kill_switch", config: {} }); } },
  ];
  for (const testCase of cases) {
    const { db, audits, runs } = runner();
    let exports = 0;
    const summary = await processDueExportSchedules(25, {
      authorize: async () => ({ ...authorization, roles: testCase.roles ?? authorization.roles }),
      formatGate: testCase.formatGate ?? allow,
      requestExport: testCase.requestExport ?? (async () => { exports += 1; return exportedManifest; }),
    }, db);
    assert.deepEqual(summary, { stopped: 0, requested: 0, failed: 1, errors: 0 }, testCase.name);
    assert.equal(exports, 0, `${testCase.name}: nothing is exported`);
    assert.deepEqual(runs()[0]!.slice(4), ["failed", null, testCase.reason], testCase.name);
    assert.deepEqual(audits().map((entry) => [entry.action, entry.outcome]), [["export_schedule.run", "failure"]], testCase.name);
    assert.equal(audits()[0]!.metadata.reason, testCase.reason);
    // The refusal is announced in the same transaction as its run: a webhook event, and the owner's email, with the reason code only.
    const runId = String(runs()[0]![1]);
    const event = db.calls.find((call) => call.sql.includes("emit_export_schedule_run_event"))!;
    assert.deepEqual(event.parameters, [TENANT, runId, testCase.reason], testCase.name);
    assert.match(event.sql, /'failed'/);
    const email = db.executed.find((call) => call.sql.includes("'export_schedule_failed'"))!;
    assert.deepEqual(email.parameters, [TENANT, runId, testCase.reason], testCase.name);
    assert.equal(db.calls.some((call) => call.sql.includes("stop_export_schedule(")), false, `${testCase.name}: the schedule keeps running; rights may come back`);
  }
});

test("an unexpected error rolls the run back to be retried and never stops the other schedules", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => { lines.push(line); };
  try {
    const db = new FakeDb((sql) => {
      if (sql.includes("list_due_export_schedules")) return [{ tenant_id: TENANT, schedule_id: SCHEDULE }, { tenant_id: TENANT, schedule_id: SECOND_SCHEDULE }];
      if (sql.includes("claim_export_schedule_trigger")) return [{ trigger_key: "monthly:2026-10" }];
      if (sql.includes("from corvis_control.export_schedule where")) return [scheduleRow({ schedule_id: SECOND_SCHEDULE })];
      return [];
    });
    let attempt = 0;
    const summary = await processDueExportSchedules(25, {
      authorize: async () => authorization, formatGate: allow,
      requestExport: async () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("secret detail that must not be logged");
        return exportedManifest;
      },
    }, db);
    assert.deepEqual(summary, { stopped: 0, requested: 1, failed: 0, errors: 1 });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /"event":"export_schedule\.run_failed"/);
    assert.match(lines[0]!, /"errorName":"TypeError"/);
    assert.doesNotMatch(lines[0]!, /secret detail/);

    lines.length = 0;
    const thrown = await processDueExportSchedules(25, { authorize: async () => { throw "not an error object"; }, formatGate: allow, requestExport: async () => exportedManifest }, db);
    assert.equal(thrown.errors, 2);
    assert.match(lines[0]!, /"errorName":"string"/);
  } finally { console.error = original; }
});

test("the default dependencies resolve the owner from the real membership query and gate Parquet on its flag", async () => {
  const membership = {
    workspace_id: WORKSPACE, role_name: "analyst", tenant_display_name: "Tenant", workspace_display_name: "Workspace", resource_type: "fund", resource_id: "fund-1",
    resource_permission: "read", resource_client_visible: true, resource_source_access: false, internal_analytics_allowed: false, model_training_allowed: false, redistribution_allowed: true,
  };
  const db = new FakeDb((sql) => {
    if (sql.includes("list_due_export_schedules")) return [{ tenant_id: TENANT, schedule_id: SCHEDULE }];
    if (sql.includes("claim_export_schedule_trigger")) return [{ trigger_key: "monthly:2026-10" }];
    if (sql.includes("from corvis_control.export_schedule where")) return [scheduleRow()];
    if (sql.includes("from corvis_control.identity_subject s")) return [membership];
    return [];
  });
  const exported: RequestIdentity[] = [];
  const summary = await processDueExportSchedules(25, { requestExport: async (who) => { exported.push(who); return exportedManifest; } }, db);
  assert.equal(summary.requested, 1);
  assert.deepEqual(exported[0]!.entitlements.fundIds, ["fund-1"]);
  assert.equal(exported[0]!.entitlements.redistributionAllowed, true);
  const resolution = db.calls.find((call) => call.sql.includes("from corvis_control.identity_subject s"))!;
  assert.deepEqual(resolution.parameters, [TENANT, "idp|owner", "oidc", scheduleSessionId(SCHEDULE), WORKSPACE, false, null, null, false]);

  // A Parquet schedule with the flag not configured is refused as format_unavailable, through the default gate.
  const parquet = new FakeDb((sql) => {
    if (sql.includes("list_due_export_schedules")) return [{ tenant_id: TENANT, schedule_id: SCHEDULE }];
    if (sql.includes("claim_export_schedule_trigger")) return [{ trigger_key: "monthly:2026-10" }];
    if (sql.includes("from corvis_control.export_schedule where")) return [scheduleRow({ format: "parquet" })];
    if (sql.includes("from corvis_control.identity_subject s")) return [membership];
    return [];
  });
  let requested = false;
  const refused = await processDueExportSchedules(25, { requestExport: async () => { requested = true; return exportedManifest; } }, parquet);
  assert.equal(refused.failed, 1);
  assert.equal(requested, false);
});

test("a run records which snapshot published when the trigger was a publication, and service accounts keep their auth method", async () => {
  const { db, runs } = runner({
    claim: { trigger_key: `publish:${SNAPSHOT}:v3`, snapshot_id: SNAPSHOT, snapshot_version: 3 },
    schedule: scheduleRow({ owner_auth_method: "service_account", trigger_kind: "on_publish", scope: { snapshotId: SNAPSHOT } }),
  });
  let principal: unknown;
  await processDueExportSchedules(25, { authorize: async (_store, who) => { principal = who; return authorization; }, formatGate: allow, requestExport: async (_who, _format, options) => { assert.deepEqual(options?.scope, { snapshotId: SNAPSHOT }); return exportedManifest; } }, db);
  assert.equal((principal as { authMethod: string }).authMethod, "service_account");
  assert.equal(runs()[0]![3], `publish:${SNAPSHOT}:v3`);
});

const scorecardPublishSchedule = (scope: Record<string, unknown> = { performanceScorecard: true }, overrides: PostgresRow = {}) =>
  scheduleRow({ trigger_kind: "on_publish", scope, scope_label: "Performance scorecard · all entitled funds", next_run_at: null, publish_watermark: "2026-10-01 00:00:00+00", ...overrides });
const publishClaim = { trigger_key: `publish:${SNAPSHOT}:v1`, snapshot_id: SNAPSHOT, snapshot_version: 1 };

test("an all-funds scorecard on publish re-authorizes the owner before the claim and claims only publications of the funds they hold now", async () => {
  const order: string[] = [];
  const db = new FakeDb((sql) => {
    if (sql.includes("stop_export_schedules_for_inactive_owners")) return [];
    if (sql.includes("list_due_export_schedules")) return [{ tenant_id: TENANT, schedule_id: SCHEDULE }];
    if (sql.includes("from corvis_control.export_schedule where")) return [scorecardPublishSchedule()];
    if (sql.includes("claim_export_schedule_trigger")) { order.push("claim"); return [publishClaim]; }
    return [];
  });
  const requests: unknown[] = [];
  const summary = await processDueExportSchedules(25, {
    authorize: async () => { order.push("authorize"); return { ...authorization, fundIds: ["fund-1", "fund-3"] }; },
    formatGate: allow,
    requestExport: async (who, _format, options) => { order.push("export"); requests.push([who.entitlements.fundIds, options]); return exportedManifest; },
  }, db);
  assert.deepEqual(summary, { stopped: 0, requested: 1, failed: 0, errors: 0 });
  assert.deepEqual(order, ["authorize", "claim", "export"], "authorized once, before the claim, and that authorization is the run's");
  const claim = db.calls.find((call) => call.sql.includes("claim_export_schedule_trigger"))!;
  assert.match(claim.sql, /\$3::jsonb/);
  assert.deepEqual(claim.parameters, [TENANT, SCHEDULE, JSON.stringify(["fund-1", "fund-3"])], "the owner's current funds narrow the publication trigger");
  assert.deepEqual(requests, [[["fund-1", "fund-3"], { scope: { performanceScorecard: true }, source: "delivery" }]], "the export is requested for all funds the owner holds at this moment");
});

test("a scorecard run for an owner who now holds no fund is claimed unnarrowed and recorded as a refusal the owner can see", async () => {
  const db = new FakeDb((sql) => {
    if (sql.includes("list_due_export_schedules")) return [{ tenant_id: TENANT, schedule_id: SCHEDULE }];
    if (sql.includes("from corvis_control.export_schedule where")) return [scorecardPublishSchedule()];
    if (sql.includes("claim_export_schedule_trigger")) return [publishClaim];
    return [];
  });
  let exported = false;
  const summary = await processDueExportSchedules(25, {
    authorize: async () => ({ ...authorization, fundIds: [] }), formatGate: allow, requestExport: async () => { exported = true; return exportedManifest; },
  }, db);
  assert.deepEqual(summary, { stopped: 0, requested: 0, failed: 1, errors: 0 });
  assert.equal(exported, false);
  assert.equal(db.calls.find((call) => call.sql.includes("claim_export_schedule_trigger"))!.parameters[2], null, "nothing to narrow by: the run is claimed so the refusal is recorded");
  const run = db.executed.find((call) => call.sql.includes("insert into corvis_control.export_schedule_run"))!;
  assert.deepEqual(run.parameters.slice(4, 7), ["failed", null, "scope_not_entitled"]);
});

test("a scorecard run whose owner can no longer be authorized stops the schedule: it is claimed unnarrowed and authorizes once", async () => {
  let authorizations = 0;
  const db = new FakeDb((sql) => {
    if (sql.includes("list_due_export_schedules")) return [{ tenant_id: TENANT, schedule_id: SCHEDULE }];
    if (sql.includes("from corvis_control.export_schedule where")) return [scorecardPublishSchedule()];
    if (sql.includes("claim_export_schedule_trigger")) return [publishClaim];
    if (sql.includes("stop_export_schedule(")) return [scheduleRow({ status: "stopped", stop_reason: "owner_inactive" })];
    return [];
  });
  const summary = await processDueExportSchedules(25, { authorize: async () => { authorizations += 1; return null; }, formatGate: allow }, db);
  assert.deepEqual(summary, { stopped: 0, requested: 0, failed: 1, errors: 0 });
  assert.equal(authorizations, 1, "a null authorization is the answer, not a reason to ask again");
  assert.equal(db.calls.find((call) => call.sql.includes("claim_export_schedule_trigger"))!.parameters[2], null);
});

test("a scorecard with a fund filter, or on a calendar trigger, is not narrowed at the claim and authorizes only after it", async () => {
  for (const [scope, overrides] of [
    [{ performanceScorecard: true, fundId: "fund-1" }, {}],
    [{ performanceScorecard: true }, { trigger_kind: "monthly", publish_watermark: null, next_run_at: "2026-10-01 00:00:00+00" }],
    [{ snapshotId: SNAPSHOT }, {}],
  ] as const) {
    const order: string[] = [];
    const db = new FakeDb((sql) => {
      if (sql.includes("list_due_export_schedules")) return [{ tenant_id: TENANT, schedule_id: SCHEDULE }];
      if (sql.includes("from corvis_control.export_schedule where")) return [scorecardPublishSchedule(scope, overrides)];
      if (sql.includes("claim_export_schedule_trigger")) { order.push("claim"); return [publishClaim]; }
      return [];
    });
    await processDueExportSchedules(25, { authorize: async () => { order.push("authorize"); return authorization; }, formatGate: allow, requestExport: async () => exportedManifest }, db);
    assert.deepEqual(order, ["claim", "authorize"], JSON.stringify(scope));
    assert.equal(db.calls.find((call) => call.sql.includes("claim_export_schedule_trigger"))!.parameters[2], null, JSON.stringify(scope));
  }
});

test("a schedule that is gone by the time it is run is skipped without a claim or an authorization", async () => {
  const db = new FakeDb((sql) => sql.includes("list_due_export_schedules") ? [{ tenant_id: TENANT, schedule_id: SCHEDULE }] : []);
  let authorized = false;
  const summary = await processDueExportSchedules(25, { authorize: async () => { authorized = true; return authorization; }, formatGate: allow }, db);
  assert.deepEqual(summary, { stopped: 0, requested: 0, failed: 0, errors: 0 });
  assert.equal(authorized, false);
  assert.equal(db.calls.some((call) => call.sql.includes("claim_export_schedule_trigger")), false);
});

test("schedules whose owner was deactivated are stopped and audited by the system, once", async () => {
  const stopped = [scheduleRow({ status: "stopped", stop_reason: "owner_inactive" }), scheduleRow({ schedule_id: SECOND_SCHEDULE, status: "stopped", stop_reason: "owner_inactive", label: "Quarterly" })];
  const { db, audits } = runner({ stopInactive: stopped, due: [] });
  assert.equal(await stopSchedulesOfInactiveOwners(db), 2);
  assert.deepEqual(audits().map((entry) => [entry.action, entry.target, entry.actor, entry.outcome]), [
    ["export_schedule.stop", SCHEDULE, "system:export-scheduler", "success"],
    ["export_schedule.stop", SECOND_SCHEDULE, "system:export-scheduler", "success"],
  ]);
  assert.equal(await stopSchedulesOfInactiveOwners(new FakeDb(() => [])), 0);

  const tick = runner({ stopInactive: stopped, due: [] });
  assert.deepEqual(await processDueExportSchedules(25, {}, tick.db), { stopped: 2, requested: 0, failed: 0, errors: 0 });
});
