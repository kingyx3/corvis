import assert from "node:assert/strict";
import test from "node:test";
import type { ObservationRecord } from "../../../shared/domain/contracts.ts";
import type { ReconciliationException } from "../../../shared/domain/enterprise.ts";
import {
  record,
  priorPublished,
  publishedHistory,
  competingValues,
  numericReconciliationValue,
  displayReconciliationValue,
  reconciliationDelta,
  deadlinePriority,
  exceptionMatchesObservation,
  reviewPriority,
  materialityWeight,
  deadlineLabel,
  ruleLabel,
  actionLabel,
  dualControlLabel,
  contextString,
} from "./review-exception-presentation.ts";

function row(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return { id: "o1", company: "Co", metric: "revenue", value: "1", period: "Q2 2026", source: "p. 1", confidence: 90, state: "Needs review", delta: "—", ...overrides };
}

function exception(overrides: Partial<ReconciliationException> = {}): ReconciliationException {
  return {
    exceptionId: "e1", snapshotId: "s1", snapshotVersion: 1, fundId: "f1", reportPeriod: "Q2 2026",
    type: "reconciliation_conflict", summary: "summary", materiality: "unknown", context: {},
    status: "open", version: 1, allowedActions: ["accept_reconciliation"], sourceReferences: [], createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("record only accepts a non-array object", () => {
  assert.deepEqual(record({ a: 1 }), { a: 1 });
  assert.equal(record(undefined), undefined);
  assert.equal(record("string"), undefined);
  assert.equal(record([1, 2]), undefined);
});

test("priorPublished reads a well-formed context.priorPublished object and is undefined otherwise", () => {
  assert.equal(priorPublished(exception({ context: {} })), undefined);
  assert.equal(priorPublished(exception({ context: { priorPublished: "not an object" } })), undefined);
  assert.deepEqual(priorPublished(exception({ context: { priorPublished: { reportPeriod: "Q1 2026" } } })), { reportPeriod: "Q1 2026" });
});

test("publishedHistory drops malformed points, derives their status, sorts by period, and keeps only the last 4", () => {
  assert.deepEqual(publishedHistory(exception({ context: {} })), []);
  assert.deepEqual(publishedHistory(exception({ context: { publishedHistory: "not an array" } })), []);
  assert.deepEqual(
    publishedHistory(exception({ context: { publishedHistory: [
      "not an object",
      { reportPeriod: "Q1 2026" }, // dropped: no numeric value
      { value: { number: 1 } }, // dropped: no reportPeriod
      { reportPeriod: "Q3 2026", value: { number: 3 } },
      { reportPeriod: "Q1 2026", value: { number: 1 }, preliminary: true },
      { reportPeriod: "Q2 2026", value: { number: 2 }, restated: true },
    ] } })),
    [
      { period: "Q1 2026", label: "Q1 2026", value: 1, status: "preliminary" },
      { period: "Q2 2026", label: "Q2 2026", value: 2, status: "restated" },
      { period: "Q3 2026", label: "Q3 2026", value: 3, status: "final" },
    ],
  );
});

test("competingValues filters out non-object entries and passes an empty/non-array context through as empty", () => {
  assert.deepEqual(competingValues(exception({ context: {} })), []);
  assert.deepEqual(competingValues(exception({ context: { competingValues: "nope" } })), []);
  assert.deepEqual(
    competingValues(exception({ context: { competingValues: ["bad", { observationId: "o1", value: { number: 1 } }] } })),
    [{ observationId: "o1", value: { number: 1 } }],
  );
});

test("numericReconciliationValue returns undefined for a missing or non-finite number", () => {
  assert.equal(numericReconciliationValue(undefined), undefined);
  assert.equal(numericReconciliationValue({}), undefined);
  assert.equal(numericReconciliationValue({ number: "not a number" }), undefined);
  assert.equal(numericReconciliationValue({ number: 42 }), 42);
});

test("displayReconciliationValue prefers string, then formats a number with currency/unit, then falls back to raw or an em dash", () => {
  assert.equal(displayReconciliationValue(undefined), "—");
  assert.equal(displayReconciliationValue({ string: "N/A" }), "N/A");
  assert.equal(displayReconciliationValue({ number: 1234.5, currency: "USD", unit: "m" }), "USD 1,234.5 m");
  assert.equal(displayReconciliationValue({ raw: "unparsed" }), "unparsed");
  assert.equal(displayReconciliationValue({}), "—");
});

test("reconciliationDelta is undefined when either side is non-numeric, and avoids dividing by a zero prior value", () => {
  assert.equal(reconciliationDelta(undefined, { number: 1 }), undefined);
  assert.equal(reconciliationDelta({ number: 1 }, undefined), undefined);
  assert.equal(reconciliationDelta({ number: 5 }, { number: 0 }), "+5");
  assert.equal(reconciliationDelta({ number: 90 }, { number: 100 }), "−10 · −10%");
});

test("deadlinePriority ignores a missing or unparseable deadline instead of producing NaN", () => {
  assert.deepEqual(deadlinePriority(undefined), {});
  assert.deepEqual(deadlinePriority("not a date"), {});
  const result = deadlinePriority(new Date(Date.now() + 86_400_000).toISOString());
  assert.equal(result.daysToDeadline, 1);
});

test("exceptionMatchesObservation requires a matching subject id, and a metric code (when present) to also match", () => {
  const obs = row({ companyId: "c1", holdingId: "h1", fundId: "fund1", metric: "revenue" });
  assert.equal(exceptionMatchesObservation(exception({ subjectId: "c1" }), obs), true);
  assert.equal(exceptionMatchesObservation(exception({ subjectId: "unrelated" }), obs), false);
  assert.equal(exceptionMatchesObservation(exception({ subjectId: undefined }), obs), false);
  assert.equal(exceptionMatchesObservation(exception({ subjectId: "c1", metricCode: "ebitda" }), obs), false);
  assert.equal(exceptionMatchesObservation(exception({ subjectId: "c1", metricCode: "revenue" }), obs), true);
});

test("reviewPriority picks the most severe materiality among matching open exceptions and ignores resolved ones", () => {
  const obs = row({ companyId: "c1" });
  const material = exception({ subjectId: "c1", materiality: "material" });
  const immaterial = exception({ subjectId: "c1", materiality: "immaterial", exceptionId: "e2" });
  const resolvedMaterial = exception({ subjectId: "c1", materiality: "material", status: "resolved", exceptionId: "e3" });
  assert.equal(reviewPriority(obs, [immaterial, material]).materiality, "material");
  assert.equal(reviewPriority(obs, [immaterial]).materiality, "immaterial");
  assert.equal(reviewPriority(obs, [resolvedMaterial]).materiality, "unknown");
  assert.equal(reviewPriority(obs, []).materiality, "unknown");
});

test("materialityWeight orders material before unknown before immaterial", () => {
  assert.ok(materialityWeight("material") < materialityWeight("unknown"));
  assert.ok(materialityWeight("unknown") < materialityWeight("immaterial"));
});

test("deadlineLabel formats no-deadline, overdue, due-today and future cases distinctly", () => {
  assert.equal(deadlineLabel({ materiality: "unknown" }), "No deadline set");
  assert.equal(deadlineLabel({ materiality: "unknown", daysToDeadline: -2 }), "2d overdue");
  assert.equal(deadlineLabel({ materiality: "unknown", daysToDeadline: 0 }), "Due today");
  assert.equal(deadlineLabel({ materiality: "unknown", daysToDeadline: 3 }), "3d remaining");
});

test("ruleLabel prefers the context's triggerRule over the exception's bare type, with underscores humanized", () => {
  assert.equal(ruleLabel(exception({ type: "source_authority", context: {} })), "source authority");
  assert.equal(ruleLabel(exception({ type: "source_authority", context: { triggerRule: "stale_price_feed" } })), "stale price feed");
});

test("contextString ignores a blank or non-string context value", () => {
  assert.equal(contextString(exception({ context: { note: "  " } }), "note"), undefined);
  assert.equal(contextString(exception({ context: { note: 5 } }), "note"), undefined);
  assert.equal(contextString(exception({ context: { note: "ok" } }), "note"), "ok");
});

test("actionLabel maps every resolution action to its display label", () => {
  assert.equal(actionLabel("select_source"), "Select authoritative source");
  assert.equal(actionLabel("mark_immaterial"), "Mark immaterial");
  assert.equal(actionLabel("accept_reconciliation"), "Accept reconciliation");
});

test("dualControlLabel only applies to critical rows awaiting review, and distinguishes first vs. second approval", () => {
  assert.equal(dualControlLabel(row({ riskTier: "standard", state: "Needs review" })), undefined);
  assert.equal(dualControlLabel(row({ riskTier: "critical", state: "Approved" })), undefined);
  assert.equal(dualControlLabel(row({ riskTier: "critical", state: "Needs review", approvedReviewerCount: 0 })), "Dual control required");
  assert.equal(dualControlLabel(row({ riskTier: "critical", state: "Needs review", approvedReviewerCount: 1 })), "1st approval recorded, 2nd required");
});
