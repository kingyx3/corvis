import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentRecord, FundSnapshot, ObservationRecord } from "./contracts.ts";
import { buildWorkspaceSummary, comparePeriods, periodEndDate, STALE_AFTER_DAYS, type PortfolioValueFact } from "./workspace-summary.ts";

const now = new Date("2026-09-25T12:00:00Z");

function fact(overrides: Partial<PortfolioValueFact>): PortfolioValueFact {
  return { snapshotId: "s1", fundId: "fund-a", fund: "Fund A", period: "Q2 2026", publishedAt: null, metricCode: "nav", currency: "USD", value: 100, factCount: 1, ...overrides };
}
function snapshot(overrides: Partial<FundSnapshot>): FundSnapshot {
  return { id: "s1", fund: "Fund A", period: "Q2 2026", status: "Published", holdings: 3, facts: 10, changed: "now", ...overrides };
}
function observation(overrides: Partial<ObservationRecord>): ObservationRecord {
  return { id: "o1", fund: "Fund A", company: "Co", metric: "Revenue", value: "1", period: "Q2 2026", source: "p. 1", confidence: 90, state: "Needs review", delta: "—", ...overrides };
}
function document(overrides: Partial<DocumentRecord>): DocumentRecord {
  return { id: "d1", name: "Report.pdf", fund: "Fund A", period: "Q2 2026", type: "Quarterly report", pages: 1, size: "1 KB", status: "Queued", uploaded: "now", quality: "Pending", observations: 0, ...overrides };
}
const empty = { snapshots: [], observations: [], documents: [], valueFacts: [], now };

test("period labels resolve to period-end dates and order chronologically", () => {
  assert.equal(periodEndDate("Q2 2026"), "2026-06-30");
  assert.equal(periodEndDate("2026 Q1"), "2026-03-31");
  assert.equal(periodEndDate("30 Jun 2026"), "2026-06-30");
  assert.equal(periodEndDate("Jun-26"), "2026-06-30");
  assert.equal(periodEndDate("LTM Jun-26"), "2026-06-30");
  assert.equal(periodEndDate("2025-12-31"), "2025-12-31");
  assert.equal(periodEndDate("FY2025"), "2025-12-31");
  assert.equal(periodEndDate("Detecting…"), null);
  assert.deepEqual(["Q1 2026", "Detecting…", "Q3 2025", "Q4 2025"].sort(comparePeriods), ["Q3 2025", "Q4 2025", "Q1 2026", "Detecting…"]);
});

test("value trend holds each fund at its latest published value, in chronological order", () => {
  const summary = buildWorkspaceSummary({ ...empty, valueFacts: [
    fact({ snapshotId: "a2", period: "Q2 2026", value: 120 }),
    fact({ snapshotId: "a1", period: "Q1 2026", value: 100 }),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", period: "Q1 2026", value: 50 }),
    fact({ snapshotId: "c0", fundId: "fund-c", fund: "Fund C", period: "Q4 2025", value: 10 }),
  ] });
  assert.equal(summary.currency, "USD");
  // Fund B has not reported Q2 yet: it is carried forward, not dropped, so the
  // trend never shows a false decline, and Fund C joins only from Q4 2025 on.
  assert.deepEqual(summary.valueTrend.map((point) => [point.period, point.value, point.fundCount, point.carriedForwardFunds, point.snapshotIds]), [
    ["Q4 2025", 10, 1, 0, ["c0"]],
    ["Q1 2026", 160, 3, 1, ["a1", "b1"]],
    ["Q2 2026", 180, 3, 2, ["a2"]],
  ]);
  // The latest point reconciles exactly with the exposure total.
  assert.equal(summary.valueTrend.at(-1)!.value, summary.exposure.total);
});

test("NAV wins over summed fair value inside one snapshot, never both", () => {
  const summary = buildWorkspaceSummary({ ...empty, valueFacts: [
    fact({ metricCode: "fair_value", value: 70, factCount: 4 }),
    fact({ metricCode: "nav", value: 95 }),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", metricCode: "fair_value", value: 40 }),
  ] });
  assert.deepEqual(summary.exposure.items.map((item) => [item.fund, item.value, item.metricCode]), [["Fund A", 95, "nav"], ["Fund B", 40, "fair_value"]]);
});

test("exposure uses each fund's latest published value and its total reconciles exactly", () => {
  const summary = buildWorkspaceSummary({ ...empty, valueFacts: [
    fact({ snapshotId: "a1", period: "Q1 2026", value: 100 }),
    fact({ snapshotId: "a2", period: "Q2 2026", value: 120 }),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", period: "Q1 2026", value: 80 }),
    fact({ snapshotId: "c1", fundId: "fund-c", fund: "Fund C", currency: "EUR", value: 999 }),
  ] });
  assert.deepEqual(summary.exposure.items.map((item) => [item.fund, item.snapshotId, item.value]), [["Fund A", "a2", 120], ["Fund B", "b1", 80]]);
  assert.equal(summary.exposure.total, summary.exposure.items.reduce((sum, item) => sum + item.value, 0));
  assert.equal(summary.exposure.total, 200);
  // A fund period in a non-reporting currency is excluded (never FX-guessed) and disclosed.
  assert.equal(summary.exposure.excludedFundPeriods, 1);
});

test("no published value yields an empty trend and exposure rather than invented numbers", () => {
  const summary = buildWorkspaceSummary(empty);
  assert.equal(summary.currency, null);
  assert.deepEqual(summary.valueTrend, []);
  assert.deepEqual(summary.exposure, { total: 0, items: [], excludedFundPeriods: 0 });
  assert.equal(summary.attention.counts.total, 0);
});

test("attention aggregates all four signal sources, ranked, each deep-linking to its screen", () => {
  const summary = buildWorkspaceSummary({
    ...empty,
    snapshots: [snapshot({ id: "s-review", status: "Review", blockingExceptions: 2 }), snapshot({ id: "s-pub", period: "Q1 2026" })],
    observations: [observation({ id: "o1" }), observation({ id: "o2", company: "Other" }), observation({ id: "o3", state: "Approved" })],
    documents: [
      document({ id: "d-failed", processingState: "failed" }),
      document({ id: "d-slow", status: "Extracting", processingState: "running", processingUpdatedAt: "2026-09-23T00:00:00Z" }),
      document({ id: "d-fresh", status: "Extracting", processingState: "running", processingUpdatedAt: "2026-09-25T11:00:00Z" }),
      document({ id: "d-done", status: "Published", processingState: "failed" }),
    ],
    sources: [
      { sourceConnectionId: "src-1", connectionLabel: "Data room", status: "reauthorization_required", consecutiveFailures: 0 },
      { sourceConnectionId: "src-2", connectionLabel: "SFTP", status: "active", consecutiveFailures: 2 },
      { sourceConnectionId: "src-3", connectionLabel: "Healthy", status: "active", consecutiveFailures: 0 },
    ],
  });
  const { items, counts } = summary.attention;
  assert.deepEqual(counts, { blocking_exception: 2, needs_review: 2, stuck_document: 2, unhealthy_source: 2, total: 8 });
  assert.equal(counts.total, items.reduce((sum, item) => sum + item.count, 0));
  assert.deepEqual(items.map((item) => item.severity), ["blocking", "blocking", "high", "high", "high", "normal"]);
  assert.deepEqual(items[0]!.target, { view: "review", snapshotId: "s-review" });
  const review = items.find((item) => item.kind === "needs_review")!;
  assert.deepEqual(review.target, { view: "review", snapshotId: "s-review", observationId: "o1" });
  assert.deepEqual(items.filter((item) => item.kind === "stuck_document").map((item) => item.target), [{ view: "documents", documentId: "d-failed" }, { view: "documents", documentId: "d-slow" }]);
  assert.ok(items.filter((item) => item.kind === "unhealthy_source").every((item) => item.target.view === "admin"));
});

test("sources are omitted entirely when the caller is not entitled to them", () => {
  const summary = buildWorkspaceSummary({ ...empty, snapshots: [snapshot({})] });
  assert.equal(summary.attention.counts.unhealthy_source, 0);
  assert.deepEqual(summary.attention.items, []);
});

test("freshness reports as-of, preliminary periods and a staleness flag past the threshold", () => {
  const summary = buildWorkspaceSummary({ ...empty, snapshots: [
    snapshot({ id: "a2", period: "Q2 2026" }),
    snapshot({ id: "a3", period: "Q3 2026", status: "Review" }),
    snapshot({ id: "b1", fund: "Fund B", period: "Q1 2026" }),
    snapshot({ id: "c1", fund: "Fund C", status: "Review" }),
  ] });
  assert.equal(summary.freshness.staleAfterDays, STALE_AFTER_DAYS);
  assert.equal(summary.freshness.asOf, "2026-06-30");
  assert.deepEqual(summary.freshness.funds.map((row) => [row.fund, row.latestPublishedPeriod, row.snapshotId, row.stale, row.preliminaryPeriods]), [
    ["Fund A", "Q2 2026", "a2", false, 1],
    // Q1 2026 ended 2026-03-31, 178 days before `now`: past the threshold.
    ["Fund B", "Q1 2026", "b1", true, 0],
    // Nothing published at all is stale by definition.
    ["Fund C", null, null, true, 1],
  ]);
  assert.equal(summary.freshness.staleFunds, 2);
});
