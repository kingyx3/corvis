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

test("publication fails closed when a gate input is not a number", () => {
  const passing = { blockingExceptions: 0, needsReviewCount: 0, criticalObservationCount: 3, independentlyReviewedCriticalCount: 3, lineageCoverage: 1 };
  assert.deepEqual(evaluatePublicationGate({ ...passing, lineageCoverage: Number.NaN }).reasons, ["incomplete_source_lineage"]);
  assert.deepEqual(evaluatePublicationGate({ ...passing, lineageCoverage: undefined as unknown as number }).reasons, ["incomplete_source_lineage"]);
  assert.deepEqual(evaluatePublicationGate({ ...passing, blockingExceptions: Number.NaN }).reasons, ["blocking_exceptions"]);
  assert.deepEqual(evaluatePublicationGate({ ...passing, needsReviewCount: Number.NaN }).reasons, ["observations_need_review"]);
  assert.deepEqual(evaluatePublicationGate({ ...passing, independentlyReviewedCriticalCount: Number.NaN }).reasons, ["critical_observations_require_independent_review"]);
  assert.deepEqual(evaluatePublicationGate({ ...passing, criticalObservationCount: Number.NaN }).reasons, ["critical_observations_require_independent_review"]);
});
