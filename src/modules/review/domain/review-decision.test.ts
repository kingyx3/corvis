import assert from "node:assert/strict";
import test from "node:test";
import type { ObservationRecord } from "../../../shared/domain/contracts.ts";
import { applyReviewOutcome, awaitingSecondApproval } from "./review-decision.ts";

function row(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return { id: "o1", company: "Co", metric: "revenue", value: "1", period: "Q2 2026", source: "p. 1", confidence: 90, state: "Needs review", delta: "—", version: 3, riskTier: "critical", approvedReviewerCount: 0, ...overrides };
}

test("a first critical approval records one approval so the row is awaiting its second approver", () => {
  const before = row();
  assert.equal(awaitingSecondApproval(before), false);
  const after = applyReviewOutcome(before, "approve", { nextState: "review_required", newVersion: 4 });
  assert.equal(after.state, "Needs review");
  assert.equal(after.version, 4);
  assert.equal(after.approvedReviewerCount, 1);
  assert.equal(awaitingSecondApproval(after), true);
});

test("a first approval is counted even when the serving view returned no reviewer count", () => {
  const after = applyReviewOutcome(row({ approvedReviewerCount: undefined }), "approve", { nextState: "review_required", newVersion: 4 });
  assert.equal(after.approvedReviewerCount, 1);
});

test("final approval, rejection and correction do not invent approvals", () => {
  assert.deepEqual(applyReviewOutcome(row({ approvedReviewerCount: 1 }), "approve", { nextState: "approved", newVersion: 5 }), row({ approvedReviewerCount: 1, state: "Approved", version: 5 }));
  assert.equal(applyReviewOutcome(row(), "reject", { nextState: "rejected", newVersion: 4 }).approvedReviewerCount, 0);
  const corrected = applyReviewOutcome(row(), "correct", { nextState: "review_required", newVersion: 4 }, "2");
  assert.equal(corrected.value, "2");
  assert.equal(corrected.approvedReviewerCount, 0);
});
