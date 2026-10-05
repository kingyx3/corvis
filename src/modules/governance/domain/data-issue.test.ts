import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_ISSUE_ACTIONS,
  DATA_ISSUE_EXPORT_COLUMNS,
  DATA_ISSUE_STATUSES,
  DataIssueValidationError,
  availableDataIssueActions,
  dataIssueExportRow,
  dataIssueScopeSummary,
  dataIssueStatusSummary,
  dataIssueTransition,
  isClosedDataIssue,
  parseReportCommand,
  parseTransitionCommand,
  previousDataIssueStatus,
  unseenDataIssueCount,
  type DataIssueCase,
} from "./data-issue.ts";

const UUID = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const valid = {
  idempotencyKey: "report-1",
  figure: "review",
  scope: { fundId: "fund-1", reportPeriod: "Q2 2026" },
  comment: "The revenue looks too high.",
};

function codeOf(run: () => unknown): string {
  try { run(); return "ok"; } catch (error) {
    assert.ok(error instanceof DataIssueValidationError, "validation failures are typed");
    assert.equal(error.status, 400);
    return error.code;
  }
}

test("a case moves received -> investigating -> corrected or no change, and nowhere else", () => {
  assert.deepEqual(DATA_ISSUE_ACTIONS.map((action) => dataIssueTransition("received", action)), ["investigating", null, null]);
  assert.deepEqual(DATA_ISSUE_ACTIONS.map((action) => dataIssueTransition("investigating", action)), [null, "corrected", "no_change"]);
  for (const closed of ["corrected", "no_change"] as const) {
    for (const action of DATA_ISSUE_ACTIONS) assert.equal(dataIssueTransition(closed, action), null, `${closed} cannot ${action}`);
    assert.deepEqual(availableDataIssueActions(closed), []);
    assert.equal(isClosedDataIssue(closed), true);
  }
  assert.deepEqual(availableDataIssueActions("received"), ["investigate"]);
  assert.deepEqual(availableDataIssueActions("investigating"), ["correct", "no_change"]);
  assert.equal(isClosedDataIssue("received"), false);
  assert.equal(isClosedDataIssue("investigating"), false);
  assert.deepEqual(DATA_ISSUE_ACTIONS.map(previousDataIssueStatus), ["received", "investigating", "investigating"]);
  assert.deepEqual([...DATA_ISSUE_STATUSES], ["received", "investigating", "corrected", "no_change"]);
});

test("a report is validated into a trimmed command with only the scope that was given", () => {
  const minimal = parseReportCommand({ ...valid, comment: "  Wrong value.\n\nPlease check.  ", scope: { fundId: " fund-1 ", reportPeriod: "Q2 2026", companyId: "", metricLabel: "  " } });
  assert.deepEqual(minimal, {
    idempotencyKey: "report-1", figure: "review", scope: { fundId: "fund-1", reportPeriod: "Q2 2026" }, comment: "Wrong value.\n\nPlease check.",
  });
  const full = parseReportCommand({
    ...valid,
    figure: "position_financials",
    scope: {
      fundId: "fund-1", fundLabel: "Advent VIII", companyId: "company-1", companyLabel: "ABC Corp", metricCode: "revenue", metricLabel: "Revenue",
      reportPeriod: "Q2 2026", snapshotId: UUID, snapshotVersion: 3,
    },
  });
  assert.deepEqual(full.scope, {
    fundId: "fund-1", reportPeriod: "Q2 2026", fundLabel: "Advent VIII", companyId: "company-1", companyLabel: "ABC Corp", metricCode: "revenue",
    metricLabel: "Revenue", snapshotId: UUID, snapshotVersion: 3,
  });
  assert.equal(parseReportCommand({ ...valid, scope: { ...valid.scope, snapshotId: null, snapshotVersion: null } }).scope.snapshotId, undefined);
});

test("the idempotency key may come from the body or the header but never conflict", () => {
  const { idempotencyKey, ...withoutKey } = valid;
  assert.equal(idempotencyKey, "report-1");
  assert.equal(parseReportCommand(withoutKey, "header-key").idempotencyKey, "header-key");
  assert.equal(parseReportCommand(valid, "report-1").idempotencyKey, "report-1");
  assert.equal(parseReportCommand(valid, null).idempotencyKey, "report-1");
  assert.equal(parseReportCommand(valid, "   ").idempotencyKey, "report-1", "a blank header is no header");
  assert.equal(codeOf(() => parseReportCommand(valid, "other-key")), "invalid_idempotency_key");
  assert.equal(codeOf(() => parseReportCommand(withoutKey)), "idempotency_key_required");
  assert.equal(codeOf(() => parseReportCommand({ ...valid, idempotencyKey: "   " })), "idempotency_key_required");
  assert.equal(codeOf(() => parseReportCommand({ ...valid, idempotencyKey: 7 })), "invalid_idempotency_key");
  assert.equal(codeOf(() => parseReportCommand({ ...valid, idempotencyKey: "k".repeat(257) })), "invalid_idempotency_key");
  assert.equal(codeOf(() => parseReportCommand({ ...valid, idempotencyKey: "a\nb" })), "invalid_idempotency_key");
  assert.equal(codeOf(() => parseReportCommand(withoutKey, "x".repeat(257))), "invalid_idempotency_key");
});

test("malformed reports are typed 400s, never a crash", () => {
  for (const body of [null, undefined, "report", 7, [], [valid]]) assert.equal(codeOf(() => parseReportCommand(body)), "invalid_request");
  assert.equal(codeOf(() => parseReportCommand({ ...valid, figure: "fund_scorecard" })), "invalid_figure");
  assert.equal(codeOf(() => parseReportCommand({ ...valid, figure: undefined })), "invalid_figure");
  for (const comment of [undefined, null, "", "   ", 5, "x".repeat(2001), "bad\u0000nul", "bell\u0007", "line\u2028separator"]) {
    assert.equal(codeOf(() => parseReportCommand({ ...valid, comment })), "invalid_comment", String(comment));
  }
  assert.equal(parseReportCommand({ ...valid, comment: "x".repeat(2000) }).comment.length, 2000);
  assert.equal(parseReportCommand({ ...valid, comment: "tab\tand\r\nnewline" }).comment, "tab\tand\r\nnewline");
  for (const scope of [undefined, null, "fund", [], {}, { fundId: "f" }, { reportPeriod: "p" }, { fundId: "", reportPeriod: "p" }, { fundId: "f", reportPeriod: " " }]) {
    assert.equal(codeOf(() => parseReportCommand({ ...valid, scope })), "invalid_scope", JSON.stringify(scope));
  }
  const base = valid.scope;
  for (const extra of [
    { fundId: 7 }, { fundId: "f".repeat(513) }, { fundId: "a\nb" }, { fundLabel: 3 }, { fundLabel: "l".repeat(201) },
    { companyId: "c".repeat(513) }, { metricCode: "m".repeat(257) }, { snapshotId: "s".repeat(129) },
    { snapshotVersion: 3 }, { snapshotId: UUID, snapshotVersion: 0 }, { snapshotId: UUID, snapshotVersion: 1.5 },
    { snapshotId: UUID, snapshotVersion: "3" }, { snapshotId: UUID, snapshotVersion: 1_000_001 },
  ]) {
    assert.equal(codeOf(() => parseReportCommand({ ...valid, scope: { ...base, ...extra } })), "invalid_scope", JSON.stringify(extra));
  }
});

test("a transition command is validated, and closing without a note or with a malformed link is refused", () => {
  assert.deepEqual(parseTransitionCommand({ action: "investigate" }), { action: "investigate" });
  assert.deepEqual(parseTransitionCommand({ action: "investigate", expectedStatus: "received", correctionIncidentId: UUID.toUpperCase(), note: "  Looking.  " }), {
    action: "investigate", expectedStatus: "received", correctionIncidentId: UUID, note: "Looking.",
  });
  assert.deepEqual(parseTransitionCommand({ action: "correct", correctionIncidentId: null, note: null }), { action: "correct" });
  assert.deepEqual(parseTransitionCommand({ action: "investigate", note: "   " }), { action: "investigate" }, "a blank optional note is no note");
  assert.deepEqual(parseTransitionCommand({ action: "no_change", note: "Matches the source." }), { action: "no_change", note: "Matches the source." });
  for (const body of [null, "x", [], 1]) assert.equal(codeOf(() => parseTransitionCommand(body)), "invalid_request");
  for (const action of [undefined, "close", "CORRECT", 3]) assert.equal(codeOf(() => parseTransitionCommand({ action })), "invalid_action");
  assert.equal(codeOf(() => parseTransitionCommand({ action: "correct", expectedStatus: "open" })), "invalid_status");
  for (const correctionIncidentId of ["incident-1", 7, "", UUID + "0"]) {
    assert.equal(codeOf(() => parseTransitionCommand({ action: "correct", correctionIncidentId })), "invalid_correction", String(correctionIncidentId));
  }
  assert.equal(codeOf(() => parseTransitionCommand({ action: "no_change", note: "n", correctionIncidentId: UUID })), "invalid_correction", "no change has no correction");
  assert.equal(codeOf(() => parseTransitionCommand({ action: "no_change" })), "invalid_note", "no change needs a reason");
  assert.equal(codeOf(() => parseTransitionCommand({ action: "no_change", note: "   " })), "invalid_note");
  assert.equal(codeOf(() => parseTransitionCommand({ action: "correct", note: "n".repeat(2001) })), "invalid_note");
  assert.equal(codeOf(() => parseTransitionCommand({ action: "correct", note: 4 })), "invalid_note");
});

const base: DataIssueCase = {
  caseId: UUID, figure: "overview", scope: { fundId: "fund-1", reportPeriod: "Q2 2026" }, comment: "Looks off", status: "received", routedTo: "data_operations",
  reportedBy: "idp|reporter", reportedByMe: true, createdAt: "2026-10-01T00:00:00.000Z", statusChangedAt: "2026-10-01T00:00:00.000Z",
  resolutionNote: null, replacement: null, hasUnseenUpdate: false,
};

test("scope summaries prefer display labels, skip what was not given, and say which snapshot version", () => {
  assert.equal(dataIssueScopeSummary(base.scope), "fund-1 · Q2 2026");
  assert.equal(dataIssueScopeSummary({
    fundId: "fund-1", fundLabel: "Advent VIII", companyId: "company-1", companyLabel: "ABC Corp", metricCode: "revenue", metricLabel: "Revenue",
    reportPeriod: "Q2 2026", snapshotId: UUID, snapshotVersion: 3,
  }), "Advent VIII · ABC Corp · Revenue · Q2 2026 · Snapshot v3");
  assert.equal(dataIssueScopeSummary({ fundId: "f", companyId: "c", metricCode: "m", reportPeriod: "p" }), "f · c · m · p", "ids stand in for missing labels");
});

test("every status has a plain sentence, and a correction names the replacement version", () => {
  assert.match(dataIssueStatusSummary(base), /^Received\./);
  assert.match(dataIssueStatusSummary({ ...base, status: "investigating" }), /Nothing has changed in the published figure/);
  assert.match(dataIssueStatusSummary({ ...base, status: "corrected", replacement: { snapshotId: UUID, snapshotVersion: 4 } }), /snapshot v4/);
  assert.equal(dataIssueStatusSummary({ ...base, status: "corrected" }), "Corrected. A replacement publication now supersedes the figure you reported.");
  assert.equal(dataIssueStatusSummary({ ...base, status: "no_change", resolutionNote: "Matches the source." }), "Reviewed, no change needed: Matches the source.");
  assert.equal(dataIssueStatusSummary({ ...base, status: "no_change" }), "Reviewed, no change needed.");
});

test("the unseen-update count and export rows follow the case, with one cell per column", () => {
  assert.equal(unseenDataIssueCount([]), 0);
  assert.equal(unseenDataIssueCount([{ hasUnseenUpdate: true }, { hasUnseenUpdate: false }, { hasUnseenUpdate: true }]), 2);
  const sparse = dataIssueExportRow(base);
  assert.equal(sparse.length, DATA_ISSUE_EXPORT_COLUMNS.length);
  assert.deepEqual(sparse, [UUID, "Received", "Overview", "", "fund-1", "", "", "", "", "Q2 2026", "", "", "Looks off", "idp|reporter", base.createdAt, base.statusChangedAt, "", "", "", ""]);
  const closed = dataIssueExportRow({
    ...base, status: "corrected", figure: "position_financials", resolutionNote: "Republished.", correctionIncidentId: "incident-1",
    replacement: { snapshotId: "snap-2", snapshotVersion: 4 },
    scope: { fundId: "fund-1", fundLabel: "Advent", companyId: "c1", companyLabel: "ABC", metricCode: "rev", metricLabel: "Revenue", reportPeriod: "Q2", snapshotId: "snap-1", snapshotVersion: 3 },
  });
  assert.equal(closed.length, DATA_ISSUE_EXPORT_COLUMNS.length);
  assert.deepEqual(closed, [UUID, "Corrected", "Position financials", "Advent", "fund-1", "ABC", "c1", "Revenue", "rev", "Q2", "snap-1", "3", "Looks off", "idp|reporter", base.createdAt, base.statusChangedAt, "Republished.", "snap-2", "4", "incident-1"]);
});
