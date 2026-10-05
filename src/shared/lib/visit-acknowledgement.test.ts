import assert from "node:assert/strict";
import test from "node:test";
import { claimVisitAcknowledgement } from "./visit-acknowledgement.ts";

test("only the first summary a mount sees is acknowledged; refreshes cannot erase an unseen digest", () => {
  const state = { acknowledged: false };
  assert.equal(claimVisitAcknowledgement(state, undefined), null, "no summary yet: nothing to acknowledge");
  assert.equal(claimVisitAcknowledgement(state, "2026-09-25T10:00:00Z"), "2026-09-25T10:00:00Z");
  assert.equal(claimVisitAcknowledgement(state, "2026-09-25T10:05:00Z"), null, "a refresh must not advance the visit cursor");
  assert.equal(claimVisitAcknowledgement(state, "2026-09-25T10:10:00Z"), null);
});

test("a fresh mount acknowledges again", () => {
  assert.equal(claimVisitAcknowledgement({ acknowledged: false }, "2026-09-25T10:00:00Z"), "2026-09-25T10:00:00Z");
});
