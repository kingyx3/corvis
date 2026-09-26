import type { FundSnapshot } from "./contracts.ts";
import {
  PORTFOLIO_VALUE_METRICS,
  VALUE_SUBJECT_LEVELS,
  comparePeriods,
  type PortfolioValueFact,
  type PortfolioValueMetric,
  type WorkspaceSummary,
} from "./workspace-summary.ts";

export type DashboardSourceHealth = {
  sourceConnectionId: string;
  connectionLabel: string;
  status: string;
  health: "healthy" | "degraded" | "action_required" | "paused";
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  /** Entitled funds observed from documents acquired through this source. */
  fundIds: string[];
};

export type FundTrendPoint = {
  period: string;
  snapshotId: string;
  value: number;
  metricCode: PortfolioValueMetric;
  publishedAt: string | null;
};

export type FundTrendSeries = {
  fundId: string;
  fund: string;
  points: FundTrendPoint[];
};

export type TrendContributor = FundTrendPoint & {
  fundId: string;
  fund: string;
  carriedForward: boolean;
};

export type WorkspaceDigestItem = {
  id: string;
  kind: "publish" | "exception_opened" | "exception_resolved" | "value_delta";
  title: string;
  detail: string;
  fundId?: string;
  period?: string;
  snapshotId?: string;
};

export type WorkspaceChangeDigest = {
  /** Null means this is the user's first acknowledged visit and establishes a baseline. */
  since: string | null;
  items: WorkspaceDigestItem[];
  newPublishes: number;
  exceptionChanges: number;
  valueDeltas: number;
};

export type WorkspaceDashboardSummary = WorkspaceSummary & {
  sourceHealth: DashboardSourceHealth[];
  personalization: { pinnedFundIds: string[] };
  digest: WorkspaceChangeDigest;
  fundTrends: FundTrendSeries[];
  /** Exact fund values that compose each aggregate valueTrend point. */
  trendContributors: Record<string, TrendContributor[]>;
};

export type ExceptionDigestEvent = {
  id: string;
  kind: "exception_opened" | "exception_resolved";
  fundId: string;
  fund?: string;
  period: string;
  summary: string;
};

type SnapshotValue = {
  snapshotId: string;
  fundId: string;
  fund: string;
  period: string;
  publishedAt: string | null;
  metricCode: PortfolioValueMetric;
  currency: string | null;
  value: number;
};

function levelRank(level: string | null | undefined): number {
  const index = (VALUE_SUBJECT_LEVELS as readonly string[]).indexOf(level ?? "");
  return index === -1 ? VALUE_SUBJECT_LEVELS.length : index;
}

function mostAggregateLevel(rows: PortfolioValueFact[]): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const row of rows) {
    const rank = levelRank(row.subjectLevel);
    if (rank < bestRank) { best = row.subjectLevel ?? null; bestRank = rank; }
  }
  return best;
}

/** Mirrors the Overview rollup's no-double-count value selection. */
export function dashboardSnapshotValues(facts: PortfolioValueFact[]): SnapshotValue[] {
  const grouped = new Map<string, PortfolioValueFact[]>();
  for (const fact of facts) {
    if (!Number.isFinite(fact.value)) continue;
    grouped.set(fact.snapshotId, [...(grouped.get(fact.snapshotId) ?? []), fact]);
  }
  const values: SnapshotValue[] = [];
  for (const rows of grouped.values()) {
    const metric = PORTFOLIO_VALUE_METRICS.find((code) => rows.some((row) => row.metricCode === code));
    if (!metric) continue;
    const metricRows = rows.filter((row) => row.metricCode === metric);
    const level = mostAggregateLevel(metricRows);
    const chosen = metricRows.filter((row) => (row.subjectLevel ?? null) === level);
    const byCurrency = new Map<string, number>();
    for (const row of chosen) byCurrency.set(row.currency ?? "", (byCurrency.get(row.currency ?? "") ?? 0) + row.value);
    const first = chosen[0];
    if (!first) continue;
    for (const [rawCurrency, value] of byCurrency) values.push({
      snapshotId: first.snapshotId,
      fundId: first.fundId,
      fund: first.fund,
      period: first.period,
      publishedAt: first.publishedAt,
      metricCode: metric,
      currency: rawCurrency || null,
      value,
    });
  }
  return values;
}

export function buildFundTrends(facts: PortfolioValueFact[], currency: string | null): FundTrendSeries[] {
  const values = dashboardSnapshotValues(facts).filter((row) => (row.currency ?? null) === currency);
  const byFund = new Map<string, FundTrendSeries>();
  for (const value of values) {
    const series = byFund.get(value.fundId) ?? { fundId: value.fundId, fund: value.fund, points: [] };
    series.points.push({ period: value.period, snapshotId: value.snapshotId, value: value.value, metricCode: value.metricCode, publishedAt: value.publishedAt });
    byFund.set(value.fundId, series);
  }
  for (const series of byFund.values()) series.points.sort((a, b) => comparePeriods(a.period, b.period));
  return [...byFund.values()].sort((a, b) => a.fund.localeCompare(b.fund));
}

export function buildTrendContributors(series: FundTrendSeries[], periods: string[]): Record<string, TrendContributor[]> {
  const result: Record<string, TrendContributor[]> = {};
  for (const period of periods) {
    const contributors: TrendContributor[] = [];
    for (const fund of series) {
      const point = fund.points.filter((candidate) => comparePeriods(candidate.period, period) <= 0).at(-1);
      if (!point) continue;
      contributors.push({ ...point, fundId: fund.fundId, fund: fund.fund, carriedForward: point.period !== period });
    }
    result[period] = contributors.sort((a, b) => b.value - a.value || a.fund.localeCompare(b.fund));
  }
  return result;
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyDelta(value: number, currency: string | null): string {
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat("en", currency ? { style: "currency", currency, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 }).format(Math.abs(value));
  } catch {
    formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(Math.abs(value));
  }
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted}`;
}

/**
 * Builds the session-to-session customer digest from immutable publication
 * timestamps plus governed exception events. No audit/control-plane secrets
 * are exposed to the browser.
 */
export function buildWorkspaceDigest(input: {
  lastSeenAt: string | null;
  snapshots: FundSnapshot[];
  fundTrends: FundTrendSeries[];
  exceptionEvents: ExceptionDigestEvent[];
  currency: string | null;
}): WorkspaceChangeDigest {
  const since = input.lastSeenAt;
  if (!since) return { since: null, items: [], newPublishes: 0, exceptionChanges: 0, valueDeltas: 0 };
  const sinceTime = parseTime(since);
  if (sinceTime == null) return { since: null, items: [], newPublishes: 0, exceptionChanges: 0, valueDeltas: 0 };
  const items: WorkspaceDigestItem[] = [];
  let newPublishes = 0;
  let valueDeltas = 0;

  const publishedAfter = input.snapshots
    .filter((snapshot) => snapshot.status === "Published" && (parseTime(snapshot.publishedAt ?? null) ?? -Infinity) > sinceTime)
    .sort((a, b) => (parseTime(b.publishedAt ?? null) ?? 0) - (parseTime(a.publishedAt ?? null) ?? 0));
  for (const snapshot of publishedAfter) {
    newPublishes += 1;
    items.push({ id: `publish:${snapshot.id ?? `${snapshot.fund}:${snapshot.period}`}`, kind: "publish", title: `${snapshot.fund} published ${snapshot.period}`, detail: "A new final fund period is available.", period: snapshot.period, snapshotId: snapshot.id });
  }

  for (const series of input.fundTrends) {
    const current = series.points.at(-1);
    if (!current || (parseTime(current.publishedAt) ?? -Infinity) <= sinceTime) continue;
    const previous = series.points.filter((point) => (parseTime(point.publishedAt) ?? Infinity) <= sinceTime).at(-1);
    if (!previous || previous.value === current.value) continue;
    const delta = current.value - previous.value;
    valueDeltas += 1;
    items.push({
      id: `value_delta:${series.fundId}:${current.snapshotId}`,
      kind: "value_delta",
      title: `${series.fund} value ${delta >= 0 ? "increased" : "decreased"}`,
      detail: `${moneyDelta(delta, input.currency)} since ${previous.period}; latest published period is ${current.period}.`,
      fundId: series.fundId,
      period: current.period,
      snapshotId: current.snapshotId,
    });
  }

  for (const event of input.exceptionEvents) items.push({
    id: `${event.kind}:${event.id}`,
    kind: event.kind,
    title: event.kind === "exception_opened" ? `${event.fund ?? event.fundId} exception opened` : `${event.fund ?? event.fundId} exception resolved`,
    detail: `${event.period} · ${event.summary}`,
    fundId: event.fundId,
    period: event.period,
  });

  return { since, items, newPublishes, exceptionChanges: input.exceptionEvents.length, valueDeltas };
}
