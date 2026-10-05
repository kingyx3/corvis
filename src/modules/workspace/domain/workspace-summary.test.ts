import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentRecord, FundSnapshot, ObservationRecord } from "../../../shared/domain/contracts.ts";
import { buildWorkspaceSummary, comparePeriods, compareSnapshotValues, MIXED_INSTRUMENT_TYPES, periodEndDate, STALE_AFTER_DAYS, type ExposureDimensionFact, type PortfolioValueFact } from "./workspace-summary.ts";

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

test("period comparison is chronological where a lexicographic comparison is not", () => {
  // "Q4 2025" > "Q2 2026" as strings; the views must order and pick "latest" by period end date.
  assert.ok("Q4 2025" > "Q2 2026");
  assert.ok(comparePeriods("Q2 2026", "Q4 2025") > 0);
  assert.deepEqual(["Q4 2025", "Q2 2026", "Q1 2026"].sort((a, b) => comparePeriods(b, a)), ["Q2 2026", "Q1 2026", "Q4 2025"]);
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
  assert.deepEqual(summary.exposure, { total: 0, items: [], excludedFundPeriods: 0, byAssetType: [], bySector: [] });
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

test("only the most aggregate subject level counts, so fund fair value is not added to its holdings", () => {
  const summary = buildWorkspaceSummary({ ...empty, valueFacts: [
    fact({ metricCode: "fair_value", subjectLevel: "fund", value: 300 }),
    fact({ metricCode: "fair_value", subjectLevel: "holding", value: 290, factCount: 5 }),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", metricCode: "fair_value", subjectLevel: "instrument", value: 40 }),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", metricCode: "fair_value", subjectLevel: "holding", value: 45 }),
  ] });
  assert.deepEqual(summary.exposure.items.map((item) => [item.fund, item.value]), [["Fund A", 300], ["Fund B", 45]]);
});

function dimension(overrides: Partial<ExposureDimensionFact>): ExposureDimensionFact {
  return { snapshotId: "s1", fundId: "fund-a", dimension: "asset_type", subjectLevel: "holding", category: "common_equity", currency: "USD", value: 10, factCount: 1, ...overrides };
}

test("asset-type and sector breakdowns reconcile exactly to the exposure total", () => {
  const summary = buildWorkspaceSummary({ ...empty,
    valueFacts: [
      fact({ value: 100 }),
      fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", value: 50 }),
      fact({ snapshotId: "c1", fundId: "fund-c", fund: "Fund C", value: 20 }),
    ],
    dimensionFacts: [
      dimension({ category: "common_equity", value: 60 }),
      dimension({ category: "senior_debt", value: 25 }),
      dimension({ snapshotId: "b1", fundId: "fund-b", category: "common_equity", value: 30 }),
      dimension({ snapshotId: "b1", fundId: "fund-b", category: MIXED_INSTRUMENT_TYPES, value: 12 }),
      dimension({ snapshotId: "b1", fundId: "fund-b", category: null, value: 8 }),
      // Instrument-level rows for a snapshot that also reports holding level are ignored.
      dimension({ snapshotId: "b1", fundId: "fund-b", subjectLevel: "instrument", category: "warrant", value: 999 }),
      // A different currency never enters the USD breakdown.
      dimension({ category: "common_equity", currency: "EUR", value: 7 }),
      dimension({ dimension: "sector", subjectLevel: "fund", category: "Healthcare", value: 70 }),
      dimension({ dimension: "sector", subjectLevel: "fund", category: "healthcare", snapshotId: "b1", fundId: "fund-b", value: 10 }),
    ],
  });
  const total = summary.exposure.total;
  assert.equal(total, 170);
  const sum = (rows: Array<{ value: number }>) => rows.reduce((acc, row) => acc + row.value, 0);

  assert.deepEqual(summary.exposure.byAssetType.map((row) => [row.label, row.value, row.kind, row.fundCount]), [
    ["Common equity", 90, "category", 2],
    ["Senior debt", 25, "category", 1],
    ["Mixed instruments", 12, "category", 1],
    ["Unclassified", 8, "unclassified", 1],
    // Fund A's NAV beyond classified holdings (15) plus all of Fund C (20).
    ["Not attributed", 35, "not_attributed", 2],
  ]);
  assert.equal(sum(summary.exposure.byAssetType), total);

  // Sector labels group case-insensitively; everything else is not attributed.
  assert.deepEqual(summary.exposure.bySector.map((row) => [row.label, row.value]), [["Healthcare", 80], ["Not attributed", 90]]);
  assert.equal(sum(summary.exposure.bySector), total);
});

test("a breakdown is omitted when no fund reports any classification, and may carry negative residual", () => {
  const none = buildWorkspaceSummary({ ...empty, valueFacts: [fact({ value: 100 })], dimensionFacts: [dimension({ category: null, value: 40 })] });
  assert.deepEqual(none.exposure.byAssetType, []);
  assert.deepEqual(none.exposure.bySector, []);

  // Classified holdings above NAV (fund-level leverage) leave a negative residual that still reconciles.
  const levered = buildWorkspaceSummary({ ...empty, valueFacts: [fact({ value: 100 })], dimensionFacts: [dimension({ value: 130 })] });
  assert.deepEqual(levered.exposure.byAssetType.map((row) => [row.label, row.value]), [["Common equity", 130], ["Not attributed", -30]]);
});

test("sector uses governed holding classifications over a GP fund-level breakdown, with taxonomy labels", () => {
  const summary = buildWorkspaceSummary({ ...empty,
    valueFacts: [fact({ value: 1000 }), fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", value: 400 })],
    dimensionFacts: [
      dimension({ dimension: "sector", subjectLevel: "holding", category: "technology", label: "Technology", value: 600 }),
      dimension({ dimension: "sector", subjectLevel: "holding", category: null, value: 300 }),
      // Fund A's GP breakdown re-slices the same value; the governed holding level wins.
      dimension({ dimension: "sector", subjectLevel: "fund", category: "healthcare", label: "Healthcare", value: 900 }),
      // Fund B reports only a GP breakdown, mapped onto the taxonomy.
      dimension({ snapshotId: "b1", fundId: "fund-b", dimension: "sector", subjectLevel: "fund", category: "healthcare", label: "Healthcare", value: 250 }),
      dimension({ snapshotId: "b1", fundId: "fund-b", dimension: "sector", subjectLevel: "fund", category: null, value: 150 }),
    ],
  });
  assert.deepEqual(summary.exposure.bySector.map((row) => [row.label, row.value, row.kind]), [
    ["Technology", 600, "category"],
    ["Healthcare", 250, "category"],
    ["Unclassified", 450, "unclassified"],
    ["Not attributed", 100, "not_attributed"],
  ]);
  assert.equal(summary.exposure.bySector.reduce((sum, row) => sum + row.value, 0), summary.exposure.total);
});

test("two published snapshots for one fund and period resolve identically in the trend and the exposure headline", () => {
  const facts = [
    fact({ snapshotId: "early", period: "Q2 2026", value: 100, publishedAt: "2026-07-01T00:00:00Z" }),
    fact({ snapshotId: "late", period: "Q2 2026", value: 130, publishedAt: "2026-08-01T00:00:00Z" }),
  ];
  for (const valueFacts of [facts, [...facts].reverse()]) {
    const summary = buildWorkspaceSummary({ ...empty, valueFacts });
    assert.equal(summary.exposure.items.length, 1);
    assert.equal(summary.exposure.items[0]!.snapshotId, "late", "the restatement published last wins regardless of input order");
    assert.equal(summary.exposure.total, 130);
    assert.equal(summary.valueTrend.at(-1)!.value, summary.exposure.total, "headline and trend agree");
    assert.deepEqual(summary.valueTrend.at(-1)!.snapshotIds, ["late"]);
  }
});

test("attention counts come from SQL aggregates, not from the capped lists", () => {
  const summary = buildWorkspaceSummary({
    ...empty,
    // The capped lists contain none of the old, stuck work.
    observations: [], documents: [],
    attentionAggregates: {
      needsReview: [{ fund: "Fund A", count: 1234, observationId: "obs-old", company: "Old Co", metric: "Revenue" }],
      stuckDocuments: [document({ id: "stuck-1", processingState: "failed" }), document({ id: "stuck-2", processingState: "running" })],
      stuckDocumentTotal: 60,
    },
  });
  assert.equal(summary.attention.counts.needs_review, 1234);
  assert.equal(summary.attention.counts.stuck_document, 60, "the exact total, not the listed 2");
  assert.equal(summary.attention.omittedStuckDocuments, 58);
  assert.equal(summary.attention.counts.total, 1234 + 60);
  assert.equal(summary.attention.items.filter((item) => item.kind === "stuck_document").length, 2);
  const review = summary.attention.items.find((item) => item.kind === "needs_review")!;
  assert.equal(review.target.view, "review");
  assert.equal((review.target as { observationId?: string }).observationId, "obs-old");
});

test("without aggregates the list-derived attention behaves as before", () => {
  const summary = buildWorkspaceSummary({ ...empty, observations: [observation({ id: "o1" }), observation({ id: "o2" })] });
  assert.equal(summary.attention.counts.needs_review, 2);
  assert.equal(summary.attention.omittedStuckDocuments, undefined);
});

test("needs-review attention is one item per fund-period snapshot so counts and deep links match the destination", () => {
  const snapshots = [snapshot({ id: "s1", period: "Q1 2026", status: "Review" }), snapshot({ id: "s2", period: "Q2 2026", status: "Review" })];
  const summary = buildWorkspaceSummary({
    ...empty,
    snapshots,
    observations: [
      observation({ id: "o1", period: "Q1 2026" }),
      observation({ id: "o2", period: "Q2 2026" }),
      observation({ id: "o3", period: "Q2 2026" }),
    ],
  });
  const items = summary.attention.items.filter((item) => item.kind === "needs_review");
  assert.deepEqual(items.map((item) => [item.count, (item.target as { snapshotId?: string }).snapshotId]).sort(), [[1, "s1"], [2, "s2"]]);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
  assert.equal(summary.attention.counts.needs_review, 3);
});

test("SQL aggregates keyed per fund-period resolve each item to its own snapshot", () => {
  const summary = buildWorkspaceSummary({
    ...empty,
    snapshots: [snapshot({ id: "s1", period: "Q1 2026", status: "Review" }), snapshot({ id: "s2", period: "Q2 2026", status: "Review" })],
    attentionAggregates: {
      needsReview: [
        { fund: "Fund A", period: "Q1 2026", count: 1, observationId: "o-q1", company: "Co", metric: "Revenue" },
        { fund: "Fund A", period: "Q2 2026", count: 2, observationId: "o-q2", company: "Co", metric: "Revenue" },
      ],
      stuckDocuments: [], stuckDocumentTotal: 0,
    },
  });
  const targets = summary.attention.items.filter((item) => item.kind === "needs_review").map((item) => ({ count: item.count, ...item.target })).sort((a, b) => a.count - b.count);
  assert.deepEqual(targets, [
    { count: 1, view: "review", snapshotId: "s1", observationId: "o-q1" },
    { count: 2, view: "review", snapshotId: "s2", observationId: "o-q2" },
  ]);
});

test("a bare year-month period ends on the last day of that month, and undated labels sort after dated ones", () => {
  assert.equal(periodEndDate("2026-06"), "2026-06-30");
  assert.equal(periodEndDate("2024-02"), "2024-02-29");
  assert.ok(comparePeriods("Detecting…", "Q1 2026") > 0);
  assert.ok(comparePeriods("Q1 2026", "Detecting…") < 0);
  assert.ok(comparePeriods("Alpha", "Beta") < 0);
  assert.deepEqual(["Beta", "Q3 2025", "Alpha"].sort(comparePeriods), ["Q3 2025", "Alpha", "Beta"]);
});

test("snapshot values of one period order by publication time, then by id; unusable timestamps fall back to the id", () => {
  const at = (snapshotId: string, publishedAt: string | null) => ({ period: "Q2 2026", snapshotId, publishedAt });
  assert.equal(compareSnapshotValues(at("a", null), at("b", "2026-08-01T00:00:00Z")), -1, "unpublished-time sorts before any timestamp");
  assert.equal(compareSnapshotValues(at("a", "2026-09-01T00:00:00Z"), at("b", "2026-08-01T00:00:00Z")), 1);
  assert.equal(compareSnapshotValues(at("a", "2026-08-01T00:00:00Z"), at("b", "2026-09-01T00:00:00Z")), -1);
  assert.ok(compareSnapshotValues(at("a", null), at("b", null)) < 0);
  assert.ok(compareSnapshotValues(at("b", "2026-08-01T00:00:00Z"), at("a", "2026-08-01T00:00:00Z")) > 0);
  assert.ok(compareSnapshotValues(at("a", "not a date"), at("b", "2026-08-01T00:00:00Z")) < 0, "an unparseable timestamp cannot order rows");
  assert.ok(compareSnapshotValues(at("a", "2026-08-01T00:00:00Z"), at("b", "also bad")) < 0);
  assert.ok(compareSnapshotValues({ ...at("a", null), period: "Q1 2026" }, at("a", null)) < 0, "the period always wins");
});

test("reporting-currency-less facts roll up, and exposure ties break by fund name, breakdown ties by label", () => {
  const summary = buildWorkspaceSummary({ ...empty,
    valueFacts: [
      fact({ currency: null, value: 100 }),
      fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", currency: null, value: 100 }),
    ],
    dimensionFacts: [
      dimension({ currency: null, subjectLevel: null, category: "senior_debt", value: 40 }),
      dimension({ currency: null, subjectLevel: null, category: "common_equity", value: 40 }),
    ],
  });
  assert.equal(summary.currency, null);
  assert.deepEqual(summary.exposure.items.map((item) => [item.fund, item.value]), [["Fund A", 100], ["Fund B", 100]]);
  assert.deepEqual(summary.exposure.byAssetType.map((row) => [row.label, row.value]), [["Common equity", 40], ["Senior debt", 40], ["Not attributed", 120]]);
});

// A publish appends v2 as published and keeps the draft v1 as immutable history; a withdrawal appends v3.
function publishedHistory(id = "a", overrides: Partial<FundSnapshot> = {}): FundSnapshot[] {
  return [
    snapshot({ id, version: 2, status: "Published", publishedAt: "2026-09-01T00:00:00Z", ...overrides }),
    snapshot({ id, version: 1, status: "Review", ...overrides, publishedAt: undefined }),
  ];
}
function withdrawnHistory(id = "a", overrides: Partial<FundSnapshot> = {}): FundSnapshot[] {
  return [snapshot({ id, version: 3, status: "Withdrawn", ...overrides, publishedAt: undefined }), ...publishedHistory(id, overrides)];
}

test("a freshly published period is final, not also preliminary: freshness reads the current version only", () => {
  const summary = buildWorkspaceSummary({ ...empty, snapshots: publishedHistory("a") });
  const [row] = summary.freshness.funds;
  assert.equal(row?.preliminaryPeriods, 0, "the superseded draft v1 is history, not a preliminary period");
  assert.equal(row?.latestPublishedPeriod, "Q2 2026");
  assert.equal(row?.snapshotId, "a");
  assert.equal(row?.publishedAt, "2026-09-01T00:00:00Z");
  assert.equal(row?.stale, false);
  assert.equal(summary.freshness.staleFunds, 0);
});

test("an unpublished draft still counts as one preliminary period however many drafts of it exist", () => {
  const summary = buildWorkspaceSummary({ ...empty, snapshots: [snapshot({ id: "a", version: 2, status: "Review" }), snapshot({ id: "a", version: 1, status: "Review" })] });
  assert.equal(summary.freshness.funds[0]?.preliminaryPeriods, 1);
  assert.equal(summary.freshness.funds[0]?.latestPublishedPeriod, null);
  assert.equal(summary.freshness.funds[0]?.stale, true);
});

test("a withdrawn snapshot is neither the latest published period nor preliminary, and the fund goes stale", () => {
  // Q2 is current (v3 withdrawn) but older Q1 was published and is still the latest published period.
  const summary = buildWorkspaceSummary({ ...empty, snapshots: [
    ...withdrawnHistory("a2", { period: "Q2 2026" }),
    snapshot({ id: "a1", version: 1, period: "Q1 2026", status: "Published", publishedAt: "2026-05-01T00:00:00Z" }),
  ] });
  const [row] = summary.freshness.funds;
  assert.equal(row?.latestPublishedPeriod, "Q1 2026", "the withdrawn Q2 no longer counts as published");
  assert.equal(row?.snapshotId, "a1");
  assert.equal(row?.preliminaryPeriods, 0, "a withdrawal is not a period waiting on review");
  assert.equal(row?.stale, true, "Q1 ended 2026-03-31, past the staleness threshold");

  // Withdrawing the only published period leaves the fund with nothing published at all.
  const alone = buildWorkspaceSummary({ ...empty, snapshots: withdrawnHistory("a") });
  assert.deepEqual(alone.freshness.funds.map((item) => [item.latestPublishedPeriod, item.snapshotId, item.publishedAt, item.asOf, item.stale, item.preliminaryPeriods]), [[null, null, null, null, true, 0]]);
  assert.equal(alone.freshness.asOf, null);
  assert.equal(alone.freshness.staleFunds, 1);
});

test("a superseded snapshot is retired from freshness the same way", () => {
  const summary = buildWorkspaceSummary({ ...empty, snapshots: [snapshot({ id: "a", version: 3, status: "Superseded" }), ...publishedHistory("a")] });
  assert.deepEqual(summary.freshness.funds.map((row) => [row.latestPublishedPeriod, row.preliminaryPeriods, row.stale]), [[null, 0, true]]);
});

test("freshness is unchanged for single-version data and mixes histories across funds", () => {
  const summary = buildWorkspaceSummary({ ...empty, snapshots: [
    ...publishedHistory("a", { period: "Q2 2026" }),
    snapshot({ id: "a3", version: 1, period: "Q3 2026", status: "Review" }),
    snapshot({ id: "b1", version: 1, fund: "Fund B", period: "Q1 2026" }),
  ] });
  assert.deepEqual(summary.freshness.funds.map((row) => [row.fund, row.latestPublishedPeriod, row.preliminaryPeriods, row.stale]), [
    ["Fund A", "Q2 2026", 1, false],
    ["Fund B", "Q1 2026", 0, true],
  ]);
});

test("blocking-exception attention follows the current version: a published v2 no longer carries v1's blockers", () => {
  const summary = buildWorkspaceSummary({ ...empty, snapshots: [
    snapshot({ id: "a", version: 2, status: "Published", blockingExceptions: 0 }),
    snapshot({ id: "a", version: 1, status: "Review", blockingExceptions: 3 }),
    snapshot({ id: "b", version: 1, fund: "Fund B", status: "Review", blockingExceptions: 2 }),
  ] });
  assert.deepEqual(summary.attention.items.map((item) => [item.kind, item.id, item.count]), [["blocking_exception", "blocking_exception:b", 2]]);
  assert.equal(summary.attention.counts.blocking_exception, 2);
});

test("needs-review attention resolves a fund period to its current snapshot, not a historical draft", () => {
  const summary = buildWorkspaceSummary({
    ...empty,
    snapshots: [
      snapshot({ id: "a", version: 2, status: "Published" }),
      snapshot({ id: "a", version: 1, status: "Review" }),
      snapshot({ id: "a-next", version: 1, period: "Q3 2026", status: "Review" }),
    ],
    observations: [observation({ id: "o-q3", period: "Q3 2026" })],
  });
  assert.equal(summary.attention.items[0]?.target.view === "review" ? summary.attention.items[0].target.snapshotId : undefined, "a-next");
  assert.match(summary.attention.items[0]!.detail, /Q3 2026/);
});

test("current-version freshness agrees with the published value rollup after a withdrawal", () => {
  // The value rollup only ever sees the latest version (PUBLISHED_VALUE_FACTS); freshness must not disagree.
  const summary = buildWorkspaceSummary({ ...empty, snapshots: withdrawnHistory("a"), valueFacts: [] });
  assert.equal(summary.exposure.items.length, 0);
  assert.equal(summary.freshness.funds[0]?.latestPublishedPeriod, null);
  assert.equal(summary.freshness.funds[0]?.stale, true);
});

test("freshness takes the latest published period of a fund by date, whatever order the list arrives in", () => {
  const summary = buildWorkspaceSummary({ ...empty, snapshots: [
    snapshot({ id: "q2", period: "Q2 2026", publishedAt: "2026-08-01T00:00:00Z" }),
    snapshot({ id: "q4", period: "Q4 2025", publishedAt: "2026-02-01T00:00:00Z" }),
    snapshot({ id: "q1", period: "Q1 2026", publishedAt: "2026-05-01T00:00:00Z" }),
  ] });
  assert.deepEqual(summary.freshness.funds.map((row) => [row.latestPublishedPeriod, row.snapshotId, row.publishedAt]), [["Q2 2026", "q2", "2026-08-01T00:00:00Z"]]);
});

test("a document stuck without a processing state is surfaced without a state suffix", () => {
  const summary = buildWorkspaceSummary({ ...empty, documents: [document({ id: "d-old", status: "Queued", processingUpdatedAt: "2026-09-01T00:00:00Z" })] });
  const [item] = summary.attention.items;
  assert.equal(item?.kind, "stuck_document");
  assert.equal(item?.title, "Document stuck in queued");
  assert.equal(item?.detail, "Report.pdf · Fund A.");
  assert.equal(item?.severity, "high");
});
