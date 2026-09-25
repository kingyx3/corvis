import type { DocumentRecord, FundSnapshot, ObservationRecord } from "./contracts.ts";

/**
 * Customer Overview rollup (issue #175 A3/A4/A5/A7/A9). The server composes it
 * from the same entitlement-scoped lists every other screen reads, plus one
 * published-fact value rollup, so a count shown here always matches the count
 * the destination screen shows.
 */

/**
 * A published fund period is flagged stale once its reporting period ended
 * more than this many days ago: one quarter (~91 days) plus the 45-day GP
 * reporting window LPAs typically allow for quarterly reports. Past that, a
 * newer quarter should have been published.
 */
export const STALE_AFTER_DAYS = 136;

/**
 * A document still queued or processing with no stage progress for this long
 * is surfaced as stuck. Stage workers retry within minutes, so a day without
 * progress means the pipeline needs an operator, not more waiting.
 */
export const STUCK_DOCUMENT_AFTER_HOURS = 24;

/** Portfolio-value metrics, in preference order: a fund-level NAV wins over summed holding fair values. */
export const PORTFOLIO_VALUE_METRICS = ["nav", "fair_value"] as const;
export type PortfolioValueMetric = (typeof PORTFOLIO_VALUE_METRICS)[number];

/**
 * Subject levels a portfolio value can be reported at, most aggregate first.
 * Within one snapshot only the most aggregate level present counts, so a
 * fund-level fair value is never added to the holding fair values it sums.
 */
export const VALUE_SUBJECT_LEVELS = ["fund", "company", "holding", "instrument"] as const;

/**
 * One published snapshot's summed value for one metric, subject level and
 * currency. Breakdown and look-through facts are never included: they re-slice
 * value already counted at their subject, so adding them would double-count.
 */
export type PortfolioValueFact = {
  snapshotId: string;
  fundId: string;
  fund: string;
  period: string;
  publishedAt: string | null;
  metricCode: PortfolioValueMetric;
  /** Absent for legacy facts without semantic dimensions; ranked after every known level. */
  subjectLevel?: string | null;
  currency: string | null;
  value: number;
  factCount: number;
};

/**
 * Exposure dimensions with a real classification behind them. Asset type is
 * the governed instrument_type of the holding (or instrument) a fair value is
 * reported for. Sector is the GP's own fund-level fair-value breakdown whose
 * breakdown category is "sector" or "industry"; Corvis has no governed sector
 * taxonomy, so a fund that does not report one is shown as not attributed
 * rather than classified by guesswork.
 */
export type ExposureDimension = "asset_type" | "sector";

/** Sentinel category for a holding whose instruments span several governed types. */
export const MIXED_INSTRUMENT_TYPES = "__mixed__";

export type ExposureDimensionFact = {
  snapshotId: string;
  fundId: string;
  dimension: ExposureDimension;
  subjectLevel: string | null;
  /** Governed instrument type or reported sector label; null when unclassified. */
  category: string | null;
  currency: string | null;
  value: number;
  factCount: number;
};

export type ExposureBreakdownRow = {
  key: string;
  label: string;
  value: number;
  /** category: a real classification; unclassified: a value with no classification; not_attributed: exposure no reported fact attributes to this dimension. */
  kind: "category" | "unclassified" | "not_attributed";
  fundCount: number;
};

export type SourceHealthInput = {
  sourceConnectionId: string;
  connectionLabel: string;
  status: string;
  consecutiveFailures: number;
  lastErrorClass?: string;
  lastSuccessAt?: string;
};

export type AttentionKind = "blocking_exception" | "needs_review" | "stuck_document" | "unhealthy_source";
export type AttentionSeverity = "blocking" | "high" | "normal";
export type AttentionTarget =
  | { view: "review"; snapshotId?: string; observationId?: string }
  | { view: "documents"; documentId: string }
  | { view: "admin" };

export type AttentionItem = {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  count: number;
  target: AttentionTarget;
};

export type ValueTrendPoint = {
  period: string;
  value: number;
  /** Funds contributing to this point, reported or carried forward. */
  fundCount: number;
  /** Funds whose value is their latest earlier published period (not yet reported for this one). */
  carriedForwardFunds: number;
  /** Snapshots published for exactly this period, largest value first. */
  snapshotIds: string[];
};

export type ExposureItem = {
  fundId: string;
  fund: string;
  period: string;
  snapshotId: string;
  value: number;
  metricCode: PortfolioValueMetric;
};

export type FundFreshness = {
  fund: string;
  latestPublishedPeriod: string | null;
  snapshotId: string | null;
  asOf: string | null;
  publishedAt: string | null;
  stale: boolean;
  preliminaryPeriods: number;
};

export type WorkspaceSummary = {
  generatedAt: string;
  currency: string | null;
  valueTrend: ValueTrendPoint[];
  exposure: {
    total: number;
    items: ExposureItem[];
    excludedFundPeriods: number;
    /** Each sums exactly to `total`; empty when no fund reports any classification for the dimension. */
    byAssetType: ExposureBreakdownRow[];
    bySector: ExposureBreakdownRow[];
  };
  attention: {
    items: AttentionItem[];
    counts: Record<AttentionKind, number> & { total: number };
  };
  freshness: {
    asOf: string | null;
    staleAfterDays: number;
    staleFunds: number;
    funds: FundFreshness[];
  };
};

export type WorkspaceSummaryInput = {
  snapshots: FundSnapshot[];
  observations: ObservationRecord[];
  documents: DocumentRecord[];
  valueFacts: PortfolioValueFact[];
  dimensionFacts?: ExposureDimensionFact[];
  /** Only supplied for callers entitled to source-connection health (admin:manage). */
  sources?: SourceHealthInput[];
  now: Date;
};

const DAY_MS = 86_400_000;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function isoDate(year: number, month: number, day?: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, month - 1, Math.min(day ?? last, last)));
  return date.toISOString().slice(0, 10);
}

function fullYear(value: string): number { const year = Number(value); return value.length === 2 ? 2000 + year : year; }

/**
 * Best-effort period-end date (YYYY-MM-DD) for the reporting-period labels the
 * pipeline and GP documents use: "Q2 2026", "2026 Q2", "2026-06-30",
 * "30 Jun 2026", "Jun-26", "June 2026", "FY2025". Unknown shapes return null
 * and are ordered after every dated period, never guessed.
 */
export function periodEndDate(period: string): string | null {
  const value = period.trim().toLowerCase();
  let match = /^q([1-4])[\s-]*(?:fy)?(\d{4}|\d{2})$/.exec(value) ?? null;
  if (match) return isoDate(fullYear(match[2]!), Number(match[1]) * 3);
  match = /^(?:fy)?(\d{4})[\s-]*q([1-4])$/.exec(value);
  if (match) return isoDate(Number(match[1]), Number(match[2]) * 3);
  match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value);
  if (match) return isoDate(Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : undefined);
  match = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(value);
  if (match && MONTHS[match[2]!]) return isoDate(Number(match[3]), MONTHS[match[2]!]!, Number(match[1]));
  match = /^(?:ltm\s+)?([a-z]{3})[a-z]*[\s-]+(\d{4}|\d{2})$/.exec(value);
  if (match && MONTHS[match[1]!]) return isoDate(fullYear(match[2]!), MONTHS[match[1]!]!);
  match = /^(?:fy\s*)(\d{4})$/.exec(value);
  if (match) return isoDate(Number(match[1]), 12);
  return null;
}

/** Chronological comparator for period labels; undated labels sort last, alphabetically. */
export function comparePeriods(left: string, right: string): number {
  const a = periodEndDate(left);
  const b = periodEndDate(right);
  if (a && b) return a < b ? -1 : a > b ? 1 : left.localeCompare(right);
  if (a) return -1;
  if (b) return 1;
  return left.localeCompare(right);
}

type SnapshotValue = { snapshotId: string; fundId: string; fund: string; period: string; publishedAt: string | null; metricCode: PortfolioValueMetric; currency: string | null; value: number };

/** One value per published snapshot: its NAV when reported, else the sum of its holdings' fair values. */
function snapshotValues(facts: PortfolioValueFact[]): SnapshotValue[] {
  const bySnapshot = new Map<string, PortfolioValueFact[]>();
  for (const fact of facts) {
    if (!Number.isFinite(fact.value)) continue;
    const rows = bySnapshot.get(fact.snapshotId) ?? [];
    rows.push(fact);
    bySnapshot.set(fact.snapshotId, rows);
  }
  const values: SnapshotValue[] = [];
  for (const rows of bySnapshot.values()) {
    const metric = PORTFOLIO_VALUE_METRICS.find((code) => rows.some((row) => row.metricCode === code));
    if (!metric) continue;
    const forMetric = rows.filter((row) => row.metricCode === metric);
    const chosen = forMetric.filter((row) => (row.subjectLevel ?? null) === mostAggregateLevel(forMetric));
    // A snapshot whose chosen metric spans several currencies has no single
    // value without FX conversion; each currency is kept separately and the
    // reporting-currency filter below decides which one counts.
    const byCurrency = new Map<string, number>();
    for (const row of chosen) byCurrency.set(row.currency ?? "", (byCurrency.get(row.currency ?? "") ?? 0) + row.value);
    for (const [currency, value] of byCurrency) {
      const first = chosen[0]!;
      values.push({ snapshotId: first.snapshotId, fundId: first.fundId, fund: first.fund, period: first.period, publishedAt: first.publishedAt, metricCode: metric, currency: currency || null, value });
    }
  }
  return values;
}

function levelRank(level: string | null | undefined): number {
  const index = (VALUE_SUBJECT_LEVELS as readonly string[]).indexOf(level ?? "");
  return index === -1 ? VALUE_SUBJECT_LEVELS.length : index;
}

function mostAggregateLevel(rows: Array<{ subjectLevel?: string | null }>): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const row of rows) {
    const rank = levelRank(row.subjectLevel);
    if (rank < bestRank) { best = row.subjectLevel ?? null; bestRank = rank; }
  }
  return best;
}

function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ").replace(/\s+/g, " ").trim();
  return spaced === spaced.toLowerCase() ? spaced[0]!.toUpperCase() + spaced.slice(1) : spaced;
}

const UNCLASSIFIED_KEY = "__unclassified__";
const NOT_ATTRIBUTED_KEY = "__not_attributed__";

/**
 * Splits every exposure item across one dimension. Classified facts for the
 * item's own snapshot and currency fill their categories; whatever of the
 * item's value they do not cover (NAV beyond classified holdings, or a fund
 * that reports no such facts) is one explicit "not attributed" row, which may
 * be negative when classified holdings exceed NAV (fund-level leverage). The
 * rows therefore always sum to the exposure total.
 */
function exposureBreakdown(items: ExposureItem[], facts: ExposureDimensionFact[], dimension: ExposureDimension, currency: string | null): ExposureBreakdownRow[] {
  const rows = new Map<string, ExposureBreakdownRow & { funds: Set<string> }>();
  const add = (key: string, label: string, kind: ExposureBreakdownRow["kind"], value: number, fundId: string) => {
    const row = rows.get(key) ?? { key, label, kind, value: 0, fundCount: 0, funds: new Set<string>() };
    row.value += value;
    row.funds.add(fundId);
    rows.set(key, row);
  };
  let classified = false;
  for (const item of items) {
    const candidates = facts.filter((fact) => fact.dimension === dimension && fact.snapshotId === item.snapshotId && (fact.currency ?? null) === currency && Number.isFinite(fact.value));
    // Asset type is reported per holding or per instrument; use one level only,
    // for the same no-double-count reason as the value rollup.
    const level = mostAggregateLevel(candidates);
    const own = candidates.filter((fact) => (fact.subjectLevel ?? null) === level);
    let attributed = 0;
    for (const fact of own) {
      attributed += fact.value;
      const category = fact.category?.trim();
      if (!category) { add(UNCLASSIFIED_KEY, "Unclassified", "unclassified", fact.value, item.fundId); continue; }
      classified = true;
      if (category === MIXED_INSTRUMENT_TYPES) { add(MIXED_INSTRUMENT_TYPES, "Mixed instruments", "category", fact.value, item.fundId); continue; }
      add(`${dimension}:${category.toLowerCase()}`, humanize(category), "category", fact.value, item.fundId);
    }
    const residual = item.value - attributed;
    // Below half a cent is float noise from summing, not unattributed value.
    if (Math.abs(residual) >= 0.005) add(NOT_ATTRIBUTED_KEY, "Not attributed", "not_attributed", residual, item.fundId);
  }
  if (!classified) return [];
  const kindRank = { category: 0, unclassified: 1, not_attributed: 2 };
  return [...rows.values()]
    .map(({ funds, ...row }) => ({ ...row, fundCount: funds.size }))
    .sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || b.value - a.value || a.label.localeCompare(b.label));
}

function reportingCurrency(values: SnapshotValue[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value.currency ?? "", (counts.get(value.currency ?? "") ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [currency, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > bestCount) { best = currency; bestCount = count; }
  }
  return best ? best : null;
}

function plural(count: number, one: string, many: string): string { return count === 1 ? one : many; }

function isStuck(document: DocumentRecord, now: Date): boolean {
  if (document.status === "Published" || document.status === "Review") return false;
  const state = document.processingState?.toLowerCase();
  if (state === "blocked" || state === "failed" || state === "dead_letter") return true;
  if (state === "succeeded" || !document.processingUpdatedAt) return false;
  const updated = Date.parse(document.processingUpdatedAt);
  return Number.isFinite(updated) && now.getTime() - updated > STUCK_DOCUMENT_AFTER_HOURS * 3_600_000;
}

function isUnhealthy(source: SourceHealthInput): boolean {
  return source.status === "reauthorization_required" || source.status === "suspended" || (source.status === "active" && source.consecutiveFailures > 0);
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { blocking: 0, high: 1, normal: 2 };

function attentionItems(input: WorkspaceSummaryInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const snapshot of input.snapshots) {
    const blocking = snapshot.blockingExceptions ?? 0;
    if (blocking <= 0) continue;
    items.push({
      id: `blocking_exception:${snapshot.id ?? `${snapshot.fund}:${snapshot.period}`}`,
      kind: "blocking_exception",
      severity: "blocking",
      title: `${blocking} blocking reconciliation ${plural(blocking, "exception", "exceptions")}`,
      detail: `${snapshot.fund} · ${snapshot.period} cannot publish until ${plural(blocking, "it is", "they are")} resolved.`,
      count: blocking,
      target: { view: "review", snapshotId: snapshot.id },
    });
  }

  const reviewByFund = new Map<string, ObservationRecord[]>();
  for (const observation of input.observations) {
    if (observation.state !== "Needs review") continue;
    const fund = observation.fund ?? "Unassigned fund";
    reviewByFund.set(fund, [...(reviewByFund.get(fund) ?? []), observation]);
  }
  for (const [fund, rows] of reviewByFund) {
    const snapshot = input.snapshots.find((candidate) => candidate.fund === fund && candidate.status === "Review")
      ?? input.snapshots.find((candidate) => candidate.fund === fund);
    const snapshotId = rows[0]!.snapshotId ?? snapshot?.id;
    items.push({
      id: `needs_review:${fund}`,
      kind: "needs_review",
      severity: "high",
      title: `${rows.length} ${plural(rows.length, "observation needs", "observations need")} review`,
      detail: `${fund}${snapshot ? ` · ${snapshot.period}` : ""} · starting with ${rows[0]!.company} ${rows[0]!.metric}.`,
      count: rows.length,
      target: { view: "review", snapshotId, observationId: rows[0]!.id },
    });
  }

  for (const document of input.documents) {
    if (!isStuck(document, input.now)) continue;
    const state = document.processingState?.toLowerCase();
    items.push({
      id: `stuck_document:${document.id}`,
      kind: "stuck_document",
      severity: state === "failed" || state === "dead_letter" ? "blocking" : "high",
      title: state === "failed" || state === "dead_letter" ? "Document processing failed" : `Document stuck in ${document.status.toLowerCase()}`,
      detail: `${document.name} · ${document.fund}${state ? ` · ${state.replaceAll("_", " ")}` : ""}.`,
      count: 1,
      target: { view: "documents", documentId: document.id },
    });
  }

  for (const source of input.sources ?? []) {
    if (!isUnhealthy(source)) continue;
    items.push({
      id: `unhealthy_source:${source.sourceConnectionId}`,
      kind: "unhealthy_source",
      severity: source.status === "active" ? "normal" : "high",
      title: source.status === "active" ? `Source connection failing (${source.consecutiveFailures} in a row)` : `Source connection ${source.status.replaceAll("_", " ")}`,
      detail: `${source.connectionLabel}${source.lastErrorClass ? ` · ${source.lastErrorClass.replaceAll("_", " ")}` : ""}${source.lastSuccessAt ? ` · last success ${source.lastSuccessAt}` : " · no successful sync yet"}.`,
      count: 1,
      target: { view: "admin" },
    });
  }

  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count || a.id.localeCompare(b.id));
}

function freshness(input: WorkspaceSummaryInput) {
  const funds = new Map<string, FundSnapshot[]>();
  for (const snapshot of input.snapshots) funds.set(snapshot.fund, [...(funds.get(snapshot.fund) ?? []), snapshot]);
  const rows: FundFreshness[] = [];
  for (const [fund, snapshots] of funds) {
    const published = snapshots.filter((snapshot) => snapshot.status === "Published").sort((a, b) => comparePeriods(a.period, b.period));
    const latest = published.at(-1);
    const asOf = latest ? periodEndDate(latest.period) : null;
    const stale = !latest || (asOf !== null && input.now.getTime() - Date.parse(`${asOf}T00:00:00Z`) > STALE_AFTER_DAYS * DAY_MS);
    rows.push({
      fund,
      latestPublishedPeriod: latest?.period ?? null,
      snapshotId: latest?.id ?? null,
      asOf,
      publishedAt: latest?.publishedAt ?? null,
      stale,
      preliminaryPeriods: snapshots.filter((snapshot) => snapshot.status === "Review").length,
    });
  }
  rows.sort((a, b) => a.fund.localeCompare(b.fund));
  const dated = rows.map((row) => row.asOf).filter((value): value is string => value !== null).sort();
  return { asOf: dated.at(-1) ?? null, staleAfterDays: STALE_AFTER_DAYS, staleFunds: rows.filter((row) => row.stale).length, funds: rows };
}

export function buildWorkspaceSummary(input: WorkspaceSummaryInput): WorkspaceSummary {
  const values = snapshotValues(input.valueFacts);
  const currency = reportingCurrency(values);
  const inCurrency = values.filter((value) => (value.currency ?? null) === currency);

  // Funds report on different schedules, so summing only the funds that
  // reported a period would show a false drop whenever one fund is ahead of
  // the others. Each point instead holds every fund at its latest published
  // value as of that period (the LP "latest available NAV" convention) and
  // says how many were carried forward. The final point therefore equals the
  // exposure total below.
  const periods = [...new Set(inCurrency.map((value) => value.period))].sort(comparePeriods);
  const byFund = new Map<string, SnapshotValue[]>();
  for (const value of inCurrency) byFund.set(value.fundId, [...(byFund.get(value.fundId) ?? []), value]);
  for (const rows of byFund.values()) rows.sort((a, b) => comparePeriods(a.period, b.period));
  const valueTrend: ValueTrendPoint[] = periods.map((period) => {
    const point: ValueTrendPoint = { period, value: 0, fundCount: 0, carriedForwardFunds: 0, snapshotIds: [] };
    const reported: SnapshotValue[] = [];
    for (const rows of byFund.values()) {
      const latest = rows.filter((row) => comparePeriods(row.period, period) <= 0).at(-1);
      if (!latest) continue;
      point.value += latest.value;
      point.fundCount += 1;
      if (latest.period === period) reported.push(latest); else point.carriedForwardFunds += 1;
    }
    point.snapshotIds = reported.sort((a, b) => b.value - a.value).map((row) => row.snapshotId);
    return point;
  });

  // Each fund's most recent published value. The exposure total is exactly
  // the sum of these items, so the headline and the breakdown reconcile.
  const latestByFund = new Map<string, SnapshotValue>();
  for (const value of inCurrency) {
    const current = latestByFund.get(value.fundId);
    if (!current || comparePeriods(value.period, current.period) > 0) latestByFund.set(value.fundId, value);
  }
  const exposureItems: ExposureItem[] = [...latestByFund.values()]
    .map((value) => ({ fundId: value.fundId, fund: value.fund, period: value.period, snapshotId: value.snapshotId, value: value.value, metricCode: value.metricCode }))
    .sort((a, b) => b.value - a.value || a.fund.localeCompare(b.fund));

  const items = attentionItems(input);
  const counts = { blocking_exception: 0, needs_review: 0, stuck_document: 0, unhealthy_source: 0, total: 0 };
  for (const item of items) { counts[item.kind] += item.count; counts.total += item.count; }

  return {
    generatedAt: input.now.toISOString(),
    currency,
    valueTrend,
    exposure: {
      total: exposureItems.reduce((sum, item) => sum + item.value, 0),
      items: exposureItems,
      excludedFundPeriods: values.length - inCurrency.length,
      byAssetType: exposureBreakdown(exposureItems, input.dimensionFacts ?? [], "asset_type", currency),
      bySector: exposureBreakdown(exposureItems, input.dimensionFacts ?? [], "sector", currency),
    },
    attention: { items, counts },
    freshness: freshness(input),
  };
}
