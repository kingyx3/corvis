import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_SCHEDULE_FAILURE_REASONS,
  EXPORT_SCHEDULE_FAILURE_REASON_LABEL,
  ExportScheduleValidationError,
  MAX_SCHEDULE_LABEL_LENGTH,
  calendarPeriodKey,
  calendarTriggerKey,
  defaultScheduleLabel,
  describeTriggerKey,
  exportScopeSummary,
  failureReasonForDenial,
  isExportScheduleFailureReason,
  nextScheduledRunAt,
  parseCreateScheduleCommand,
  parseExportScheduleScope,
  parseScheduleAction,
  parseSchedulePatch,
  publishTriggerKey,
  scheduleSummary,
  scopeFundId,
} from "./export-schedule.ts";

const position = { positionFinancials: { fundId: "fund-1", holdingId: "holding-1", companyId: "company-1", periodicity: "quarterly" as const } };
const body = { label: "Monthly sparrow", scope: position, format: "csv", trigger: "monthly", idempotencyKey: "key-1" };
const refusal = (code: string) => (error: unknown) => error instanceof ExportScheduleValidationError && error.code === code && error.status === 400;

test("a denial while re-authorizing maps to one stable reason, never a free-form message", () => {
  assert.equal(failureReasonForDenial("exports:create"), "export_permission_revoked");
  assert.equal(failureReasonForDenial("data_rights:redistribution"), "redistribution_not_permitted");
  assert.equal(failureReasonForDenial("exports:scope"), "scope_unavailable");
  assert.equal(failureReasonForDenial("documents:read"), "scope_not_entitled");
  for (const reason of EXPORT_SCHEDULE_FAILURE_REASONS) {
    assert.equal(isExportScheduleFailureReason(reason), true);
    assert.ok(EXPORT_SCHEDULE_FAILURE_REASON_LABEL[reason].endsWith("."), `${reason} has a plain-language label`);
  }
  assert.equal(isExportScheduleFailureReason("because"), false);
  assert.equal(isExportScheduleFailureReason(undefined), false);
});

test("the saved scope is exactly what an Export this view request carries", () => {
  assert.deepEqual(parseExportScheduleScope({ snapshotId: " snap-1 " }), { snapshotId: "snap-1" });
  assert.deepEqual(parseExportScheduleScope(position), position);
  assert.deepEqual(
    parseExportScheduleScope({ positionFinancials: { ...position.positionFinancials, portfolioId: " pf-1 ", ignored: "x" }, extra: 1 }),
    { positionFinancials: { ...position.positionFinancials, portfolioId: "pf-1" } },
    "unknown keys are dropped and ids trimmed",
  );
  assert.deepEqual(parseExportScheduleScope({ positionFinancials: { ...position.positionFinancials, portfolioId: null } }), position, "a null portfolio is none");
  for (const periodicity of ["reported", "quarterly", "annual"]) {
    assert.doesNotThrow(() => parseExportScheduleScope({ positionFinancials: { ...position.positionFinancials, periodicity } }));
  }
  for (const bad of [
    undefined, null, "snap", [], {}, { snapshotId: "" }, { snapshotId: "   " }, { snapshotId: 7 }, { snapshotId: "a\nb" }, { snapshotId: "x".repeat(513) },
    { positionFinancials: "fund-1" }, { positionFinancials: [] }, { positionFinancials: { ...position.positionFinancials, periodicity: "monthly" } },
    { positionFinancials: { ...position.positionFinancials, fundId: "" } }, { positionFinancials: { ...position.positionFinancials, holdingId: 4 } },
    { positionFinancials: { ...position.positionFinancials, companyId: undefined } }, { positionFinancials: { ...position.positionFinancials, portfolioId: "" } },
    { positionFinancials: { ...position.positionFinancials, portfolioId: 3 } },
  ]) {
    assert.throws(() => parseExportScheduleScope(bad), refusal("invalid_scope"), JSON.stringify(bad));
  }
});

test("a new schedule is validated: scope, format, trigger, a bounded single-line label and one idempotency key", () => {
  assert.deepEqual(parseCreateScheduleCommand(body), { idempotencyKey: "key-1", label: "Monthly sparrow", scope: position, format: "csv", trigger: "monthly", notifyOnCompletion: true });
  for (const format of ["csv", "xlsx", "parquet"]) assert.equal(parseCreateScheduleCommand({ ...body, format }).format, format);
  for (const trigger of ["on_publish", "monthly", "quarterly"]) assert.equal(parseCreateScheduleCommand({ ...body, trigger }).trigger, trigger);
  assert.equal(parseCreateScheduleCommand({ ...body, label: `  ${"x".repeat(MAX_SCHEDULE_LABEL_LENGTH)}  ` }).label, "x".repeat(MAX_SCHEDULE_LABEL_LENGTH));

  // The idempotency key comes from the body, or from the header when the body has none; naming both requires they agree.
  const withoutKey = { ...body, idempotencyKey: undefined };
  assert.equal(parseCreateScheduleCommand(withoutKey, "header-key").idempotencyKey, "header-key");
  assert.equal(parseCreateScheduleCommand(body, "key-1").idempotencyKey, "key-1");
  assert.equal(parseCreateScheduleCommand(body, null).idempotencyKey, "key-1");
  assert.throws(() => parseCreateScheduleCommand(body, "another-key"), refusal("invalid_idempotency_key"));
  assert.throws(() => parseCreateScheduleCommand(withoutKey), refusal("idempotency_key_required"));
  assert.throws(() => parseCreateScheduleCommand(withoutKey, null), refusal("idempotency_key_required"));
  assert.throws(() => parseCreateScheduleCommand({ ...body, idempotencyKey: "" }), refusal("invalid_idempotency_key"));
  assert.throws(() => parseCreateScheduleCommand({ ...body, idempotencyKey: "k".repeat(257) }), refusal("invalid_idempotency_key"));
  assert.throws(() => parseCreateScheduleCommand(withoutKey, "bad\nkey"), refusal("invalid_idempotency_key"));

  for (const bad of [undefined, null, "schedule", [], 7]) assert.throws(() => parseCreateScheduleCommand(bad), refusal("invalid_request"));
  for (const format of [undefined, "json", "CSV", 3]) assert.throws(() => parseCreateScheduleCommand({ ...body, format }), refusal("invalid_export_format"));
  for (const trigger of [undefined, "weekly", "ON_PUBLISH", 1]) assert.throws(() => parseCreateScheduleCommand({ ...body, trigger }), refusal("invalid_trigger"));
  for (const label of [undefined, null, "", "   ", "a\nb", 5, "x".repeat(MAX_SCHEDULE_LABEL_LENGTH + 1)]) {
    assert.throws(() => parseCreateScheduleCommand({ ...body, label }), refusal("invalid_label"), String(label));
  }
  assert.throws(() => parseCreateScheduleCommand({ ...body, scope: undefined }), refusal("invalid_scope"));
});

test("the owner's only actions are pause and resume", () => {
  assert.equal(parseScheduleAction({ action: "pause" }), "pause");
  assert.equal(parseScheduleAction({ action: "resume" }), "resume");
  for (const bad of [{ action: "delete" }, { action: "PAUSE" }, {}, { action: 1 }]) assert.throws(() => parseScheduleAction(bad), refusal("invalid_action"));
  for (const bad of [undefined, null, "pause", []]) assert.throws(() => parseScheduleAction(bad), refusal("invalid_request"));
});

test("emails about a schedule are opt-out at creation: on unless the request says false, and only a boolean says anything", () => {
  assert.equal(parseCreateScheduleCommand(body).notifyOnCompletion, true);
  assert.equal(parseCreateScheduleCommand({ ...body, notifyOnCompletion: true }).notifyOnCompletion, true);
  assert.equal(parseCreateScheduleCommand({ ...body, notifyOnCompletion: false }).notifyOnCompletion, false);
  for (const bad of [null, "false", 0, 1, "yes", {}]) assert.throws(() => parseCreateScheduleCommand({ ...body, notifyOnCompletion: bad }), refusal("invalid_notify_on_completion"), String(bad));
});

test("one owner change per request: pause or resume, or the notification switch, never both", () => {
  assert.deepEqual(parseSchedulePatch({ action: "pause" }), { kind: "action", action: "pause" });
  assert.deepEqual(parseSchedulePatch({ action: "resume" }), { kind: "action", action: "resume" });
  assert.deepEqual(parseSchedulePatch({ notifyOnCompletion: false }), { kind: "notification", notifyOnCompletion: false });
  assert.deepEqual(parseSchedulePatch({ notifyOnCompletion: true }), { kind: "notification", notifyOnCompletion: true });
  assert.throws(() => parseSchedulePatch({ action: "pause", notifyOnCompletion: false }), refusal("invalid_request"));
  assert.throws(() => parseSchedulePatch({ notifyOnCompletion: "no" }), refusal("invalid_notify_on_completion"));
  assert.throws(() => parseSchedulePatch({ notifyOnCompletion: null }), refusal("invalid_notify_on_completion"));
  assert.throws(() => parseSchedulePatch({}), refusal("invalid_action"));
  assert.throws(() => parseSchedulePatch({ action: "delete" }), refusal("invalid_action"));
  for (const bad of [undefined, null, "pause", []]) assert.throws(() => parseSchedulePatch(bad), refusal("invalid_request"));
});

test("calendar triggers are the first of the next month or quarter in UTC", () => {
  const iso = (trigger: "monthly" | "quarterly", at: string) => nextScheduledRunAt(trigger, new Date(at)).toISOString();
  assert.equal(iso("monthly", "2026-01-31T23:59:59Z"), "2026-02-01T00:00:00.000Z");
  assert.equal(iso("monthly", "2026-12-15T12:00:00Z"), "2027-01-01T00:00:00.000Z");
  assert.equal(iso("monthly", "2026-03-01T00:00:00Z"), "2026-04-01T00:00:00.000Z", "strictly after: the instant itself is not the next run");
  assert.equal(iso("quarterly", "2026-02-01T00:00:00Z"), "2026-04-01T00:00:00.000Z");
  assert.equal(iso("quarterly", "2026-03-31T23:59:59Z"), "2026-04-01T00:00:00.000Z");
  assert.equal(iso("quarterly", "2026-10-01T00:00:00Z"), "2027-01-01T00:00:00.000Z");
  assert.equal(iso("quarterly", "2026-11-30T08:00:00Z"), "2027-01-01T00:00:00.000Z");
  // The UTC calendar decides, not the machine's zone: 23:30 on 31 January in New York is already February in UTC.
  assert.equal(iso("monthly", "2026-01-31T23:30:00-05:00"), "2026-03-01T00:00:00.000Z");
});

test("a run's trigger key names the event, never the attempt, and reads back in words", () => {
  assert.equal(calendarPeriodKey("monthly", new Date("2026-10-03T00:00:00Z")), "2026-10");
  assert.equal(calendarPeriodKey("monthly", new Date("2026-01-01T00:00:00Z")), "2026-01");
  assert.equal(calendarPeriodKey("quarterly", new Date("2026-10-03T00:00:00Z")), "2026-Q4");
  assert.equal(calendarPeriodKey("quarterly", new Date("2026-03-31T23:59:59Z")), "2026-Q1");
  assert.equal(calendarPeriodKey("quarterly", new Date("2026-04-01T00:00:00Z")), "2026-Q2");
  assert.equal(calendarPeriodKey("monthly", new Date("0099-05-01T00:00:00Z")), "0099-05");
  assert.equal(calendarTriggerKey("monthly", new Date("2026-10-03T00:00:00Z")), "monthly:2026-10");
  assert.equal(calendarTriggerKey("quarterly", new Date("2026-10-03T00:00:00Z")), "quarterly:2026-Q4");
  assert.equal(publishTriggerKey("snap-1", 3), "publish:snap-1:v3");

  assert.equal(describeTriggerKey("publish:11111111-1111-4111-8111-111111111111:v3"), "Snapshot v3 published");
  assert.equal(describeTriggerKey("monthly:2026-10"), "October 2026");
  assert.equal(describeTriggerKey("monthly:2026-01"), "January 2026");
  assert.equal(describeTriggerKey("quarterly:2026-Q4"), "Q4 2026");
  assert.equal(describeTriggerKey("monthly:2026-13"), "13 2026", "an impossible month is shown as written, never as undefined");
  assert.equal(describeTriggerKey("monthly:2026-00"), "00 2026");
  assert.equal(describeTriggerKey("something-else"), "something-else");
});

test("the scope reads the same in a schedule as in the delivery history of the export it produces", () => {
  assert.equal(exportScopeSummary({ snapshotId: "snap-1" }), "Snapshot snap-1");
  assert.equal(exportScopeSummary(position), "Position financials · company-1 · quarterly");
  assert.equal(
    exportScopeSummary({ positionFinancials: { ...position.positionFinancials, portfolioId: "pf-1" } }),
    "Position financials · company-1 · quarterly · portfolio pf-1",
  );
  assert.equal(scopeFundId(position), "fund-1");
  assert.equal(scopeFundId({ snapshotId: "snap-1" }), null);
});

test("a suggested label names the cadence and the scope, and always fits the label limit", () => {
  assert.equal(defaultScheduleLabel({ snapshotId: "snap-1" }, "on_publish"), "On publish · Snapshot snap-1");
  assert.equal(defaultScheduleLabel(position, "monthly"), "Monthly · Position financials · company-1 · quarterly");
  assert.equal(defaultScheduleLabel(position, "quarterly"), "Quarterly · Position financials · company-1 · quarterly");
  const long = defaultScheduleLabel({ snapshotId: "s".repeat(300) }, "monthly");
  assert.equal(long.length, MAX_SCHEDULE_LABEL_LENGTH);
  assert.doesNotThrow(() => parseCreateScheduleCommand({ ...body, label: long }));
});

test("the schedule summary says when it runs, as whom, and what holds it back", () => {
  assert.match(scheduleSummary({ status: "active", trigger: "on_publish", stopReason: null, format: "csv" }), /Requests a governed CSV export each time a matching snapshot is published, re-authorized as the owner each time\./);
  assert.match(scheduleSummary({ status: "active", trigger: "monthly", stopReason: null, format: "xlsx" }), /governed Excel export on the 1st of every month/);
  assert.match(scheduleSummary({ status: "active", trigger: "quarterly", stopReason: null, format: "parquet" }), /governed Parquet export on the 1st of every quarter/);
  assert.match(scheduleSummary({ status: "paused", trigger: "monthly", stopReason: null, format: "csv" }), /^Paused\. No CSV export runs until it is resumed, and publications while paused are not caught up\./);
  assert.match(scheduleSummary({ status: "stopped", trigger: "monthly", stopReason: "owner_inactive", format: "csv" }), /owner's access ended, so this schedule stopped and will not run again/);
  assert.equal(scheduleSummary({ status: "stopped", trigger: "monthly", stopReason: null, format: "csv" }), "Stopped. It will not run again.", "a stopped schedule is never described as running");
});
