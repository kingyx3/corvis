import assert from "node:assert/strict";
import test from "node:test";
import type { FundSnapshot } from "../../../shared/domain/contracts.ts";
import { buildFundTrends, buildTrendContributors, buildWorkspaceDigest, dashboardSnapshotValues, type FundTrendSeries } from "./workspace-dashboard.ts";
import { buildWorkspaceSummary, type PortfolioValueFact } from "./workspace-summary.ts";

function fact(overrides: Partial<PortfolioValueFact> = {}): PortfolioValueFact {
  return { snapshotId: "a2", fundId: "fund-a", fund: "Fund A", period: "Q2 2026", publishedAt: "2026-08-01T00:00:00Z", metricCode: "nav", subjectLevel: "fund", currency: "USD", value: 120, factCount: 1, ...overrides };
}
function snapshot(overrides: Partial<FundSnapshot> = {}): FundSnapshot {
  return { id: "a2", fund: "Fund A", period: "Q2 2026", status: "Published", holdings: 2, facts: 10, changed: "now", publishedAt: "2026-08-01T00:00:00Z", ...overrides };
}

test("fund trends mirror NAV-first, most-aggregate rollup without double counting", () => {
  const series = buildFundTrends([
    fact({ snapshotId: "a1", period: "Q1 2026", publishedAt: "2026-05-01T00:00:00Z", metricCode: "fair_value", subjectLevel: "holding", value: 70 }),
    fact({ snapshotId: "a1", period: "Q1 2026", publishedAt: "2026-05-01T00:00:00Z", metricCode: "nav", subjectLevel: "fund", value: 95 }),
    fact(),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", period: "Q1 2026", publishedAt: "2026-05-02T00:00:00Z", metricCode: "fair_value", subjectLevel: "holding", value: 40 }),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", period: "Q1 2026", publishedAt: "2026-05-02T00:00:00Z", metricCode: "fair_value", subjectLevel: "holding", value: 10 }),
  ], "USD");
  assert.deepEqual(series.map((item) => [item.fund, item.points.map((point) => [point.period, point.value, point.metricCode])]), [
    ["Fund A", [["Q1 2026", 95, "nav"], ["Q2 2026", 120, "nav"]]],
    ["Fund B", [["Q1 2026", 50, "fair_value"]]],
  ]);
});

test("aggregate trend contributor map explicitly marks carried-forward funds", () => {
  const series = buildFundTrends([
    fact({ snapshotId: "a1", period: "Q1 2026", publishedAt: "2026-05-01T00:00:00Z", value: 100 }),
    fact(),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", period: "Q1 2026", publishedAt: "2026-05-02T00:00:00Z", value: 50 }),
  ], "USD");
  const contributors = buildTrendContributors(series, ["Q1 2026", "Q2 2026"]);
  assert.deepEqual(contributors["Q2 2026"]?.map((item) => [item.fundId, item.value, item.carriedForward]), [
    ["fund-a", 120, false],
    ["fund-b", 50, true],
  ]);
});

test("returning-user digest merges publishes, exception changes and value deltas", () => {
  const trends = buildFundTrends([
    fact({ snapshotId: "a1", period: "Q1 2026", publishedAt: "2026-05-01T00:00:00Z", value: 100 }),
    fact({ snapshotId: "a2", period: "Q2 2026", publishedAt: "2026-08-01T00:00:00Z", value: 120 }),
  ], "USD");
  const digest = buildWorkspaceDigest({
    lastSeenAt: "2026-07-01T00:00:00Z",
    snapshots: [snapshot()],
    fundTrends: trends,
    currency: "USD",
    exceptionEvents: [{ id: "e1", kind: "exception_resolved", fundId: "fund-a", fund: "Fund A", period: "Q2 2026", summary: "NAV source conflict resolved" }],
  });
  assert.equal(digest.newPublishes, 1);
  assert.equal(digest.exceptionChanges, 1);
  assert.equal(digest.valueDeltas, 1);
  assert.deepEqual(digest.items.map((item) => item.kind).sort(), ["exception_resolved", "publish", "value_delta"]);
  assert.match(digest.items.find((item) => item.kind === "value_delta")!.detail, /\+\$20/);
});

test("first visit establishes a baseline instead of replaying all history", () => {
  const digest = buildWorkspaceDigest({ lastSeenAt: null, snapshots: [snapshot()], fundTrends: [], exceptionEvents: [], currency: "USD" });
  assert.deepEqual(digest, { since: null, items: [], newPublishes: 0, exceptionChanges: 0, valueDeltas: 0 });
});

test("restated same-period snapshots resolve like the headline: one trend point, matching contributors and digest", () => {
  // Snapshot id order ("s-a" < "s-z") disagrees with publish order (s-z first).
  const facts = [
    fact({ snapshotId: "s-q1", period: "Q1 2026", publishedAt: "2026-05-01T00:00:00Z", value: 100 }),
    fact({ snapshotId: "s-a", period: "Q2 2026", publishedAt: "2026-09-01T00:00:00Z", value: 130 }),
    fact({ snapshotId: "s-z", period: "Q2 2026", publishedAt: "2026-08-01T00:00:00Z", value: 110 }),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", period: "Q1 2026", publishedAt: "2026-05-02T00:00:00Z", value: 50 }),
  ];
  const summary = buildWorkspaceSummary({ snapshots: [], observations: [], documents: [], valueFacts: facts, now: new Date("2026-09-25T12:00:00Z") });
  const series = buildFundTrends(facts, summary.currency);
  const fundA = series.find((item) => item.fundId === "fund-a")!;
  assert.deepEqual(fundA.points.map((point) => [point.period, point.snapshotId, point.value]), [["Q1 2026", "s-q1", 100], ["Q2 2026", "s-a", 130]]);

  const contributors = buildTrendContributors(series, summary.valueTrend.map((point) => point.period));
  for (const point of summary.valueTrend) {
    assert.equal(contributors[point.period]!.reduce((sum, item) => sum + item.value, 0), point.value);
  }
  assert.equal(contributors["Q2 2026"]!.find((item) => item.fundId === "fund-a")!.snapshotId, "s-a");

  const digest = buildWorkspaceDigest({ lastSeenAt: "2026-07-01T00:00:00Z", snapshots: [], fundTrends: series, exceptionEvents: [], currency: "USD" });
  const delta = digest.items.find((item) => item.kind === "value_delta")!;
  assert.equal(delta.snapshotId, "s-a");
  assert.match(delta.detail, /\+\$30 since Q1 2026/);
});

test("snapshot values skip unusable facts, rank unknown and missing subject levels last and keep currencies apart", () => {
  const values = dashboardSnapshotValues([
    fact({ snapshotId: "s1", subjectLevel: "holding", value: Number.NaN }),
    fact({ snapshotId: "s1", subjectLevel: "holding", value: 5 }),
    fact({ snapshotId: "s1", subjectLevel: "mystery", value: 90 }),
    fact({ snapshotId: "s1", subjectLevel: null, value: 80 }),
    // Only an unclassified level: it still reports, in its own currency, and EUR stays separate.
    fact({ snapshotId: "s2", fundId: "fund-b", fund: "Fund B", subjectLevel: undefined, metricCode: "fair_value", currency: null, value: 7 }),
    fact({ snapshotId: "s2", fundId: "fund-b", fund: "Fund B", subjectLevel: undefined, metricCode: "fair_value", currency: "EUR", value: 3 }),
    // A snapshot reporting only a non-value metric has no portfolio value.
    fact({ snapshotId: "s3", metricCode: "revenue" as unknown as PortfolioValueFact["metricCode"], value: 1 }),
    // A snapshot whose only fact is non-finite has none either.
    fact({ snapshotId: "s4", value: Number.POSITIVE_INFINITY }),
  ]);
  assert.deepEqual(values.map((row) => [row.snapshotId, row.metricCode, row.currency, row.value]), [
    ["s1", "nav", "USD", 5],
    ["s2", "fair_value", null, 7],
    ["s2", "fair_value", "EUR", 3],
  ]);
});

test("trends in a currency-less workspace and ties between contributors resolve deterministically", () => {
  const series = buildFundTrends([
    fact({ snapshotId: "a1", currency: null, value: 40 }),
    fact({ snapshotId: "b1", fundId: "fund-b", fund: "Fund B", currency: null, value: 40 }),
    fact({ snapshotId: "c1", fundId: "fund-c", fund: "Fund C", currency: "USD", value: 99 }),
  ], null);
  assert.deepEqual(series.map((item) => item.fund), ["Fund A", "Fund B"]);
  const contributors = buildTrendContributors(series, ["Q2 2026"]);
  assert.deepEqual(contributors["Q2 2026"]!.map((item) => item.fund), ["Fund A", "Fund B"], "equal values order by fund name");
});

test("digest ignores an unparseable last-seen time and treats it as a first visit", () => {
  assert.deepEqual(buildWorkspaceDigest({ lastSeenAt: "yesterday-ish", snapshots: [snapshot()], fundTrends: [], exceptionEvents: [], currency: "USD" }), { since: null, items: [], newPublishes: 0, exceptionChanges: 0, valueDeltas: 0 });
});

test("digest publishes are the current published versions after the last visit, newest first", () => {
  const digest = buildWorkspaceDigest({
    lastSeenAt: "2026-07-01T00:00:00Z",
    snapshots: [
      snapshot({ id: "old", fund: "Old", publishedAt: "2026-06-01T00:00:00Z" }),
      snapshot({ id: "undated", fund: "Undated", publishedAt: undefined }),
      snapshot({ id: "garbled", fund: "Garbled", publishedAt: "not a time" }),
      snapshot({ id: "draft", fund: "Draft", status: "Review", publishedAt: "2026-08-15T00:00:00Z" }),
      snapshot({ id: "new-a", fund: "New A", publishedAt: "2026-08-01T00:00:00Z" }),
      snapshot({ id: "new-b", fund: "New B", publishedAt: "2026-09-01T00:00:00Z" }),
      snapshot({ id: undefined, fund: "Anonymous", period: "Q1 2026", publishedAt: "2026-08-20T00:00:00Z" }),
    ],
    fundTrends: [],
    exceptionEvents: [],
    currency: "USD",
  });
  assert.deepEqual(digest.items.map((item) => item.id), ["publish:new-b", "publish:Anonymous:Q1 2026", "publish:new-a"]);
  assert.equal(digest.newPublishes, 3);
});

test("a withdrawn publish is retracted from the digest and a superseded draft is never announced twice", () => {
  const digest = buildWorkspaceDigest({
    lastSeenAt: "2026-07-01T00:00:00Z",
    snapshots: [
      // Published in August, withdrawn since: the earlier publish must not be announced as a new final period.
      snapshot({ id: "w", fund: "Withdrawn", version: 3, status: "Withdrawn", publishedAt: undefined }),
      snapshot({ id: "w", fund: "Withdrawn", version: 2, status: "Published", publishedAt: "2026-08-01T00:00:00Z" }),
      snapshot({ id: "w", fund: "Withdrawn", version: 1, status: "Review" }),
      snapshot({ id: "p", fund: "Published", version: 2, status: "Published", publishedAt: "2026-08-02T00:00:00Z" }),
      snapshot({ id: "p", fund: "Published", version: 1, status: "Review" }),
    ],
    fundTrends: [],
    exceptionEvents: [],
    currency: "USD",
  });
  assert.deepEqual(digest.items.map((item) => item.id), ["publish:p"]);
  assert.equal(digest.newPublishes, 1);
});

test("value deltas need a published point on each side of the last visit and report direction, sign and currency", () => {
  const point = (period: string, snapshotId: string, value: number, publishedAt: string | null) => ({ period, snapshotId, value, metricCode: "nav" as const, publishedAt });
  const series = (fundId: string, points: FundTrendSeries["points"]): FundTrendSeries => ({ fundId, fund: `Fund ${fundId}`, points });
  const fundTrends = [
    series("empty", []),
    series("unchanged", [point("Q1 2026", "u1", 10, "2026-05-01T00:00:00Z"), point("Q2 2026", "u2", 10, "2026-08-01T00:00:00Z")]),
    series("first-ever", [point("Q2 2026", "f1", 10, "2026-08-01T00:00:00Z")]),
    series("not-new", [point("Q1 2026", "n1", 10, "2026-05-01T00:00:00Z"), point("Q2 2026", "n2", 20, "2026-06-01T00:00:00Z")]),
    series("undated", [point("Q1 2026", "d1", 10, "2026-05-01T00:00:00Z"), point("Q2 2026", "d2", 20, null)]),
    series("down", [point("Q1 2026", "w1", 100, "2026-05-01T00:00:00Z"), point("Q2 2026", "w2", 60, "2026-08-01T00:00:00Z")]),
    series("no-baseline-date", [point("Q1 2026", "b1", 100, null), point("Q2 2026", "b2", 130, "2026-08-01T00:00:00Z")]),
  ];
  const digest = buildWorkspaceDigest({ lastSeenAt: "2026-07-01T00:00:00Z", snapshots: [], fundTrends, exceptionEvents: [], currency: "USD" });
  assert.deepEqual(digest.items.map((item) => [item.id, item.title]), [["value_delta:down:w2", "Fund down value decreased"]]);
  assert.match(digest.items[0]!.detail, /^−\$40 since Q1 2026; latest published period is Q2 2026\.$/);
  assert.equal(digest.valueDeltas, 1);

  // Without a reporting currency the delta is a plain number; an unknown currency code degrades the same way.
  const plain = buildWorkspaceDigest({ lastSeenAt: "2026-07-01T00:00:00Z", snapshots: [], fundTrends: [fundTrends[5]!], exceptionEvents: [], currency: null });
  assert.match(plain.items[0]!.detail, /^−40 since/);
  const bogus = buildWorkspaceDigest({ lastSeenAt: "2026-07-01T00:00:00Z", snapshots: [], fundTrends: [fundTrends[5]!], exceptionEvents: [], currency: "NOT-A-CURRENCY" });
  assert.match(bogus.items[0]!.detail, /^−40 since/);
});

test("digest exception events name the fund, falling back to its id", () => {
  const digest = buildWorkspaceDigest({
    lastSeenAt: "2026-07-01T00:00:00Z", snapshots: [], fundTrends: [], currency: null,
    exceptionEvents: [
      { id: "e1", kind: "exception_opened", fundId: "fund-a", fund: "Fund A", period: "Q2 2026", summary: "NAV conflict" },
      { id: "e2", kind: "exception_opened", fundId: "fund-b", period: "Q2 2026", summary: "Currency conflict" },
      { id: "e3", kind: "exception_resolved", fundId: "fund-c", period: "Q2 2026", summary: "Resolved" },
    ],
  });
  assert.deepEqual(digest.items.map((item) => item.title), ["Fund A exception opened", "fund-b exception opened", "fund-c exception resolved"]);
  assert.equal(digest.exceptionChanges, 3);
});
