import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePublicationGate } from "./publication-policy.ts";

test("publication is allowed only when every trust gate passes", () => {
  assert.deepEqual(evaluatePublicationGate({ blockingExceptions: 0, needsReviewCount: 0, criticalObservationCount: 3, independentlyReviewedCriticalCount: 3, lineageCoverage: 1 }), { allowed: true, reasons: [] });
});

test("publication reports every blocking reason", () => {
  const result = evaluatePublicationGate({ blockingExceptions: 2, needsReviewCount: 1, criticalObservationCount: 4, independentlyReviewedCriticalCount: 2, lineageCoverage: 0.99 });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasons, ["blocking_exceptions","observations_need_review","critical_observations_require_independent_review","incomplete_source_lineage"]);
});
