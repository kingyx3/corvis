import assert from "node:assert/strict";
import test from "node:test";
import type { FundSnapshot } from "./contracts.ts";
import { buildFundTrends, buildTrendContributors, buildWorkspaceDigest } from "./workspace-dashboard.ts";
import type { PortfolioValueFact } from "./workspace-summary.ts";

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
