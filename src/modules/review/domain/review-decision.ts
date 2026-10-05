import type { ObservationRecord } from "../../../shared/domain/contracts.ts";
import type { ReviewOutcome } from "../../../shared/domain/enterprise.ts";

// Critical observations require two independent approvals before they leave
// "Needs review" (see corvis_facts.apply_review_decision); this makes that
// dual-control state visible on the row instead of only enforcing it silently
// on the next approve attempt (#182 D6).
export function awaitingSecondApproval(row: ObservationRecord): boolean {
  return row.riskTier === "critical" && row.state === "Needs review" && (row.approvedReviewerCount ?? 0) >= 1;
}

/**
 * The row as it should read once the server accepted a review decision. A first critical approval
 * answers `review_required`: the row stays in "Needs review" but now has one recorded approval, so
 * it moves from "Dual control required" to awaiting its second approver.
 */
export function applyReviewOutcome(row: ObservationRecord, decision: "approve" | "reject" | "correct", outcome: Pick<ReviewOutcome, "nextState" | "newVersion">, correctedValue?: string): ObservationRecord {
  return {
    ...row,
    value: decision === "correct" && correctedValue ? correctedValue : row.value,
    state: outcome.nextState === "approved" ? "Approved" : outcome.nextState === "rejected" ? "Rejected" : "Needs review",
    version: outcome.newVersion,
    ...(decision === "approve" && outcome.nextState === "review_required" ? { approvedReviewerCount: (row.approvedReviewerCount ?? 0) + 1 } : {}),
  };
}
