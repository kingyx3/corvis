import assert from "node:assert/strict";
import test from "node:test";
import {
  TENANT_EXPORT_STATES,
  TENANT_EXPORT_STATUS_LABEL,
  TenantExportValidationError,
  parseTenantExportCommand,
  parseTenantExportRequest,
  tenantExportActions,
  tenantExportStatus,
  tenantExportStatusSummary,
  type TenantExportStatus,
} from "./tenant-export.ts";

function codeOf(run: () => unknown): string {
  try { run(); return "ok"; } catch (error) {
    assert.ok(error instanceof TenantExportValidationError, "validation failures are typed");
    assert.equal(error.status, 400);
    return error.code;
  }
}

test("a stored state is shown as itself, except a lapsed approval and a complete export whose download has lapsed", () => {
  for (const state of TENANT_EXPORT_STATES) assert.equal(tenantExportStatus(state, false, true), state);
  assert.equal(tenantExportStatus("pending_approval", true, false), "expired");
  // Only a pending request can lapse its approval, and only a complete one can lose its download.
  assert.equal(tenantExportStatus("approved", true, false), "approved");
  assert.equal(tenantExportStatus("complete", false, false), "download_expired");
  assert.equal(tenantExportStatus("complete", false, true), "complete");
  assert.equal(tenantExportStatus("failed", false, false), "failed");
  // An unknown stored state is never shown as progress.
  assert.equal(tenantExportStatus("mystery", false, true), "failed");
});

test("every status has a short design-system label", () => {
  const statuses: TenantExportStatus[] = [...TENANT_EXPORT_STATES, "download_expired"];
  assert.deepEqual(Object.keys(TENANT_EXPORT_STATUS_LABEL).sort(), [...statuses].sort());
  for (const status of statuses) assert.ok(TENANT_EXPORT_STATUS_LABEL[status].length > 0);
});

test("the requester can never approve or reject: those actions need a pending request and someone else", () => {
  assert.deepEqual(tenantExportActions("pending_approval", false, false), { canApprove: true, canReject: true, canCancel: false, canDownload: false });
  assert.deepEqual(tenantExportActions("pending_approval", true, false), { canApprove: false, canReject: false, canCancel: true, canDownload: false });
  // The requester may also withdraw once approved, but only before the build starts.
  assert.equal(tenantExportActions("approved", true, false).canCancel, true);
  assert.equal(tenantExportActions("approved", false, false).canCancel, false);
  assert.equal(tenantExportActions("building", true, false).canCancel, false);
  assert.equal(tenantExportActions("approved", false, false).canApprove, false);
  // Download only while the export is complete and its link life has not passed, whoever asks.
  assert.equal(tenantExportActions("complete", false, true).canDownload, true);
  assert.equal(tenantExportActions("complete", true, true).canDownload, true);
  assert.equal(tenantExportActions("complete", false, false).canDownload, false);
  assert.equal(tenantExportActions("download_expired", false, true).canDownload, false);
  for (const status of ["rejected", "cancelled", "expired", "failed", "download_expired"] as const) {
    assert.deepEqual(tenantExportActions(status, true, false), { canApprove: false, canReject: false, canCancel: false, canDownload: false });
  }
});

test("a request names only why it is needed", () => {
  assert.deepEqual(parseTenantExportRequest({ reason: "  Records review at contract end  " }), { reason: "Records review at contract end" });
  assert.deepEqual(parseTenantExportRequest({ reason: "Line one\nline two\twith a tab", scope: "ignored", fundIds: ["x"] }), { reason: "Line one\nline two\twith a tab" });
  assert.equal(codeOf(() => parseTenantExportRequest(undefined)), "invalid_request");
  assert.equal(codeOf(() => parseTenantExportRequest(null)), "invalid_request");
  assert.equal(codeOf(() => parseTenantExportRequest(["reason"])), "invalid_request");
  assert.equal(codeOf(() => parseTenantExportRequest({})), "invalid_reason");
  assert.equal(codeOf(() => parseTenantExportRequest({ reason: null })), "invalid_reason");
  assert.equal(codeOf(() => parseTenantExportRequest({ reason: 12 })), "invalid_reason");
  assert.equal(codeOf(() => parseTenantExportRequest({ reason: "  ab  " })), "invalid_reason");
  assert.equal(codeOf(() => parseTenantExportRequest({ reason: "x".repeat(1001) })), "invalid_reason");
  assert.equal(codeOf(() => parseTenantExportRequest({ reason: "bad\u0000text" })), "invalid_reason");
  assert.equal(codeOf(() => parseTenantExportRequest({ reason: "bad text" })), "invalid_reason");
  assert.deepEqual(parseTenantExportRequest({ reason: "x".repeat(1000) }), { reason: "x".repeat(1000) });
});

test("a decision names the action, an optional status guard and a note (required to reject)", () => {
  assert.deepEqual(parseTenantExportCommand({ action: "prepare_download" }), { action: "prepare_download" });
  assert.deepEqual(parseTenantExportCommand({ action: "approve" }), { action: "approve" });
  assert.deepEqual(parseTenantExportCommand({ action: "approve", note: "  Looks right.  ", expectedStatus: "pending_approval" }), { action: "approve", note: "Looks right.", expectedStatus: "pending_approval" });
  assert.deepEqual(parseTenantExportCommand({ action: "cancel", note: "   " }), { action: "cancel" });
  assert.deepEqual(parseTenantExportCommand({ action: "reject", note: "Not authorised." }), { action: "reject", note: "Not authorised." });
  assert.deepEqual(parseTenantExportCommand({ action: "reject", note: "No", expectedStatus: "pending_approval" }), { action: "reject", note: "No", expectedStatus: "pending_approval" });
  assert.equal(codeOf(() => parseTenantExportCommand("approve")), "invalid_request");
  assert.equal(codeOf(() => parseTenantExportCommand({})), "invalid_action");
  assert.equal(codeOf(() => parseTenantExportCommand({ action: "delete" })), "invalid_action");
  assert.equal(codeOf(() => parseTenantExportCommand({ action: "approve", expectedStatus: "pending" })), "invalid_status");
  assert.equal(codeOf(() => parseTenantExportCommand({ action: "reject" })), "invalid_note");
  assert.equal(codeOf(() => parseTenantExportCommand({ action: "reject", note: "  " })), "invalid_note");
  assert.equal(codeOf(() => parseTenantExportCommand({ action: "approve", note: 5 })), "invalid_note");
  assert.equal(codeOf(() => parseTenantExportCommand({ action: "approve", note: "x".repeat(1001) })), "invalid_note");
});

test("each status is summarised in one plain sentence that says what happens next", () => {
  const base: { requestedByMe: boolean; decidedBy: string | null; decisionNote: string | null } = { requestedByMe: false, decidedBy: null, decisionNote: null };
  const say = (status: TenantExportStatus, extra: Partial<typeof base> = {}) => tenantExportStatusSummary({ status, ...base, ...extra });
  assert.match(say("pending_approval"), /different Organization Admin \(not the requester\) must approve/);
  assert.match(say("pending_approval", { requestedByMe: true }), /cannot approve your own request/);
  assert.match(say("approved", { decidedBy: "morgan" }), /^Approved by morgan\. The export is queued/);
  assert.match(say("approved"), /^Approved\. The export is queued/);
  assert.match(say("building"), /being built/);
  assert.match(say("complete"), /single-use and short-lived/);
  assert.match(say("download_expired"), /Request a new export/);
  assert.match(say("failed"), /Nothing was delivered/);
  assert.equal(say("rejected", { decidedBy: "morgan", decisionNote: "Not authorised." }), "Rejected by morgan: Not authorised.");
  assert.equal(say("rejected"), "Rejected.");
  assert.match(say("cancelled"), /Withdrawn by the requester/);
  assert.match(say("expired"), /No second Organization Admin approved in time/);
});
