import assert from "node:assert/strict";
import test from "node:test";
import {
  DELETION_MAX_DATA_CLASSES,
  DELETION_REQUEST_STATUSES,
  DELETION_REQUEST_STATUS_LABEL,
  DeletionRequestValidationError,
  dataClassLabel,
  deletionLegalHoldBlocks,
  deletionRequestActions,
  deletionRequestStatus,
  deletionScopeDataClasses,
  deletionScopeLabel,
  deletionStatusSummary,
  legalHoldScopeLabel,
  parseDeletionDecision,
  parseDeletionRequest,
  retentionPeriodLabel,
  type DeletionRequestStatus,
  type DeletionRequestView,
} from "./data-retention.ts";

test("known data classes get plain names and others are made readable", () => {
  assert.equal(dataClassLabel("financials"), "Financial data");
  assert.equal(dataClassLabel("source_documents"), "Source documents");
  assert.equal(dataClassLabel("audit"), "Audit records");
  assert.equal(dataClassLabel("fund_reports"), "Fund reports");
  assert.equal(dataClassLabel("kyc-records"), "Kyc records");
  assert.equal(dataClassLabel("  _  "), "  _  ", "an identifier with no words is shown as written");
  assert.equal(dataClassLabel(""), "");
});

test("retention periods read as years, months or days, and no period says so", () => {
  assert.equal(retentionPeriodLabel(null), "No fixed retention period");
  assert.equal(retentionPeriodLabel(365), "1 year");
  assert.equal(retentionPeriodLabel(2555), "7 years");
  assert.equal(retentionPeriodLabel(30), "1 month");
  assert.equal(retentionPeriodLabel(90), "3 months");
  assert.equal(retentionPeriodLabel(45), "45 days");
  assert.equal(retentionPeriodLabel(1), "1 day");
  assert.equal(retentionPeriodLabel(0), "0 days");
});

test("a legal hold says what it covers: the whole data class, or the named documents, funds or people within it", () => {
  assert.equal(legalHoldScopeLabel(null, {}), "all data");
  assert.equal(legalHoldScopeLabel("financials", {}), "Financial data");
  assert.equal(legalHoldScopeLabel("source_documents", { documentIds: ["a", "b", "c"] }), "3 documents within source documents");
  assert.equal(legalHoldScopeLabel("source_documents", { documentIds: ["a"], fundIds: ["f1", "f2"], subjectIds: ["p"] }), "1 document, 2 funds, 1 person within source documents");
  assert.equal(legalHoldScopeLabel("financials", { subjectIds: ["p", "q"] }), "2 people within financial data");
  assert.equal(legalHoldScopeLabel(null, { fundIds: ["f1"] }), "1 fund within all data");
  // A scope arriving as JSON text, and one that is malformed, are read safely.
  assert.equal(legalHoldScopeLabel("financials", JSON.stringify({ fundIds: ["f1"] })), "1 fund within financial data");
  assert.equal(legalHoldScopeLabel("financials", "not json"), "Financial data");
  assert.equal(legalHoldScopeLabel("financials", "[1,2]"), "Financial data");
  assert.equal(legalHoldScopeLabel("financials", null), "Financial data");
  assert.equal(legalHoldScopeLabel("financials", { documentIds: "not a list", fundIds: [] }), "Financial data");
});

// ------------------------------------------------------------------ deletion requests (F10e)
test("a deletion scope reads as plain language, narrowed by any named documents, funds or people", () => {
  assert.deepEqual(deletionScopeDataClasses({ dataClasses: ["financials", "audit", " audit ", "", 7, "documents"] }), ["audit", "documents", "financials"]);
  assert.deepEqual(deletionScopeDataClasses(JSON.stringify({ dataClasses: ["b", "a"] })), ["a", "b"], "a scope arriving as JSON text is read");
  assert.deepEqual(deletionScopeDataClasses({ dataClasses: "financials" }), [], "a class list that is not a list names nothing");
  assert.deepEqual(deletionScopeDataClasses("not json"), []);
  assert.deepEqual(deletionScopeDataClasses(null), []);
  assert.equal(deletionScopeLabel({ dataClasses: ["financials"] }), "Financial data");
  assert.equal(deletionScopeLabel({ dataClasses: ["source_documents", "financials"] }), "Financial data, source documents");
  assert.equal(deletionScopeLabel({ dataClasses: ["source_documents"], documentIds: ["a", "b"], fundIds: ["f"] }), "2 documents, 1 fund within source documents");
  assert.equal(deletionScopeLabel({ dataClasses: [] }), "Unspecified data");
  assert.equal(deletionScopeLabel("[1]"), "Unspecified data");
});

test("a stored state reads as one customer-facing status, and an unknown state is never shown as something it is not", () => {
  const table: Array<[string, boolean, DeletionRequestStatus]> = [
    ["pending_customer_approval", false, "pending_approval"], ["pending_customer_approval", true, "expired"],
    ["requested", false, "requested"], ["approved", false, "approved"], ["executing", false, "in_progress"], ["retryable", false, "retrying"],
    ["blocked", false, "blocked"], ["completed", false, "completed"], ["rejected", false, "rejected"], ["cancelled", false, "cancelled"],
    ["expired", false, "expired"], ["something_new", false, "in_progress"],
  ];
  for (const [state, lapsed, status] of table) assert.equal(deletionRequestStatus(state, lapsed), status, `${state}${lapsed ? " (lapsed)" : ""}`);
  assert.deepEqual(Object.keys(DELETION_REQUEST_STATUS_LABEL).sort(), [...DELETION_REQUEST_STATUSES].sort(), "every status has a label");
});

test("a legal hold only blocks a request that could still run", () => {
  for (const status of DELETION_REQUEST_STATUSES) {
    const open = !["completed", "rejected", "cancelled", "expired"].includes(status);
    assert.equal(deletionLegalHoldBlocks(status, true), open, status);
    assert.equal(deletionLegalHoldBlocks(status, false), false, `${status} without a hold`);
  }
});

test("only a different Organization Admin may decide a pending customer request, and only its requester may withdraw it", () => {
  assert.deepEqual(deletionRequestActions("pending_approval", "customer", false), { canApprove: true, canReject: true, canCancel: false });
  assert.deepEqual(deletionRequestActions("pending_approval", "customer", true), { canApprove: false, canReject: false, canCancel: true });
  for (const status of DELETION_REQUEST_STATUSES.filter((item) => item !== "pending_approval")) {
    assert.deepEqual(deletionRequestActions(status, "customer", false), { canApprove: false, canReject: false, canCancel: false }, status);
    assert.deepEqual(deletionRequestActions(status, "customer", true), { canApprove: false, canReject: false, canCancel: false }, status);
  }
  assert.deepEqual(deletionRequestActions("pending_approval", "corvis", false), { canApprove: false, canReject: false, canCancel: false }, "a request Corvis made is never decided here");
});

test("each status says where the request stands and what happens next, naming a legal hold that stops it", () => {
  const item = (status: DeletionRequestStatus, extra: Partial<DeletionRequestView> = {}) => deletionStatusSummary({ status, requestedByMe: false, decidedBy: null, decisionNote: null, legalHoldBlocks: false, ...extra });
  assert.match(item("pending_approval"), /A different Organization Admin \(not the requester\) must approve/);
  assert.match(item("pending_approval", { requestedByMe: true }), /You cannot approve your own request, and nothing is deleted/);
  assert.match(item("requested"), /have not carried it out yet/);
  assert.match(item("approved", { decidedBy: "morgan@x.test" }), /Approved by morgan@x\.test\. Corvis operations will carry out/);
  assert.match(item("approved"), /^Approved\. Corvis operations/);
  assert.match(item("in_progress"), /carrying out/);
  assert.match(item("retrying"), /try again/);
  assert.match(item("blocked", { legalHoldBlocks: true }), /Blocked by a legal hold\. Nothing was deleted/);
  assert.match(item("blocked"), /precondition was not met/);
  assert.match(item("completed"), /data was deleted/);
  assert.equal(item("rejected", { decidedBy: "morgan@x.test", decisionNote: "Not now" }), "Rejected by morgan@x.test: Not now Nothing was deleted.");
  assert.equal(item("rejected"), "Rejected. Nothing was deleted.");
  assert.match(item("cancelled"), /Withdrawn by the requester/);
  assert.match(item("expired"), /lapsed/);
  for (const status of ["requested", "approved", "in_progress", "retrying"] as const) {
    assert.match(item(status, { legalHoldBlocks: true }), /A legal hold applies to this data/, `${status} says a hold applies`);
    assert.doesNotMatch(item(status), /legal hold/, `${status} says nothing of a hold when none applies`);
  }
});

const refusal = (code: string) => (error: unknown) => error instanceof DeletionRequestValidationError && error.code === code && error.status === 400;

test("a customer request names whole data classes and why, and anything else is refused rather than widened", () => {
  assert.deepEqual(parseDeletionRequest({ dataClasses: [" source_documents ", "financials", "financials"], reason: "  Closing the account  " }), { dataClasses: ["financials", "source_documents"], reason: "Closing the account" });
  assert.throws(() => parseDeletionRequest(null), refusal("invalid_request"));
  assert.throws(() => parseDeletionRequest([]), refusal("invalid_request"));
  assert.throws(() => parseDeletionRequest({ reason: "Closing the account" }), refusal("invalid_data_classes"));
  assert.throws(() => parseDeletionRequest({ dataClasses: "financials", reason: "Closing the account" }), refusal("invalid_data_classes"));
  assert.throws(() => parseDeletionRequest({ dataClasses: [], reason: "Closing the account" }), refusal("invalid_data_classes"));
  assert.throws(() => parseDeletionRequest({ dataClasses: Array.from({ length: DELETION_MAX_DATA_CLASSES + 1 }, (_, n) => `class_${n}`), reason: "Closing the account" }), refusal("invalid_data_classes"));
  assert.equal(parseDeletionRequest({ dataClasses: Array.from({ length: DELETION_MAX_DATA_CLASSES }, (_, n) => `class_${n}`), reason: "Closing the account" }).dataClasses.length, DELETION_MAX_DATA_CLASSES);
  for (const bad of [7, null, "", "  ", "has space", "semi;colon", "x".repeat(101), { dataClasses: ["financials"] }]) {
    assert.throws(() => parseDeletionRequest({ dataClasses: ["financials", bad], reason: "Closing the account" }), refusal("invalid_data_classes"), JSON.stringify(bad));
  }
  assert.throws(() => parseDeletionRequest({ dataClasses: ["financials"] }), refusal("invalid_reason"));
  assert.throws(() => parseDeletionRequest({ dataClasses: ["financials"], reason: null }), refusal("invalid_reason"));
  assert.throws(() => parseDeletionRequest({ dataClasses: ["financials"], reason: 7 }), refusal("invalid_reason"));
  assert.throws(() => parseDeletionRequest({ dataClasses: ["financials"], reason: "ab" }), refusal("invalid_reason"));
  assert.throws(() => parseDeletionRequest({ dataClasses: ["financials"], reason: "x".repeat(1001) }), refusal("invalid_reason"));
  assert.throws(() => parseDeletionRequest({ dataClasses: ["financials"], reason: "bad\u0000reason" }), refusal("invalid_reason"));
  assert.equal(parseDeletionRequest({ dataClasses: ["financials"], reason: "line one\nline two" }).reason, "line one\nline two", "line breaks are allowed");
});

test("a decision names an action, and a rejection says why", () => {
  assert.deepEqual(parseDeletionDecision({ action: "approve" }), { action: "approve" });
  assert.deepEqual(parseDeletionDecision({ action: "approve", note: "  Agreed  ", expectedStatus: "pending_approval" }), { action: "approve", note: "Agreed", expectedStatus: "pending_approval" });
  assert.deepEqual(parseDeletionDecision({ action: "cancel", note: "   " }), { action: "cancel" }, "a blank note is no note");
  assert.deepEqual(parseDeletionDecision({ action: "reject", note: " Not now " }), { action: "reject", note: "Not now" });
  assert.deepEqual(parseDeletionDecision({ action: "reject", note: "No", expectedStatus: "pending_approval" }), { action: "reject", note: "No", expectedStatus: "pending_approval" });
  assert.throws(() => parseDeletionDecision("approve"), refusal("invalid_request"));
  assert.throws(() => parseDeletionDecision({ action: "execute" }), refusal("invalid_action"));
  assert.throws(() => parseDeletionDecision({ action: "approve", expectedStatus: "approved" }), refusal("invalid_status"));
  assert.throws(() => parseDeletionDecision({ action: "reject" }), refusal("invalid_note"));
  assert.throws(() => parseDeletionDecision({ action: "reject", note: "  " }), refusal("invalid_note"));
  assert.throws(() => parseDeletionDecision({ action: "approve", note: 5 }), refusal("invalid_note"));
  assert.throws(() => parseDeletionDecision({ action: "approve", note: "x".repeat(1001) }), refusal("invalid_note"));
});
