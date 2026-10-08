/**
 * GP-reported performance scorecard (issue #257, F1).
 *
 * The scorecard shows, for each entitled fund, the latest published value the GP reported for each
 * fund-level performance metric, and for each underlying investment the latest published value of
 * each investment-level metric. Nothing here computes a figure: every number is a published
 * consolidated fact exactly as extracted and dual-reviewed. The only decisions made in this module are
 * which already-published fact is the latest one, which trust flag it carries, and how it is written
 * down for the reader.
 *
 * Governed definitions: Confluence Canonical Metric Dictionary (262391), Controlled Taxonomies
 * (327724) and Canonical Data Model (425985). Metric-definition rows remain tenant data:
 * - fund-level metrics are reported with subject level `fund`: nav, tvpi, dpi, rvpi, net_irr, net_moic;
 * - investment-level metrics are reported with subject level `holding` or `company`: cost, fair_value,
 *   gross_moic, gross_irr, ownership_pct. A look-through row, a breakdown row (e.g. fair value by
 *   sector) and an `instrument`-level fact are not an investment's headline figure and never appear.
 */

export type ScorecardLevel = "fund" | "investment";
export type ScorecardMetricKind = "money" | "multiple" | "percent";
export type ReportedFigureStatus = "Final" | "Preliminary" | "Restated";

export type ScorecardMetric = {
  code: string;
  label: string;
  kind: ScorecardMetricKind;
  /** One-line definition shown with the column heading; the GP's own definition always governs. */
  definition: string;
};

export const NOT_REPORTED = "Not reported";

export const FUND_SCORECARD_METRICS: readonly ScorecardMetric[] = [
  { code: "nav", label: "NAV", kind: "money", definition: "Net asset value of the fund, as reported by the GP." },
  { code: "tvpi", label: "TVPI", kind: "multiple", definition: "Total value divided by paid-in or invested capital under the source definition, as reported by the GP." },
  { code: "dpi", label: "DPI", kind: "multiple", definition: "Distributions to paid-in capital, as reported by the GP." },
  { code: "rvpi", label: "RVPI", kind: "multiple", definition: "Residual value to paid-in capital, as reported by the GP." },
  { code: "net_irr", label: "Net IRR", kind: "percent", definition: "Internal rate of return to investors, net of fees and carry, as reported by the GP." },
  { code: "net_moic", label: "Net MOIC", kind: "multiple", definition: "Multiple of invested capital to investors, net of fees and carry, as reported by the GP." },
];

export const INVESTMENT_SCORECARD_METRICS: readonly ScorecardMetric[] = [
  { code: "cost", label: "Cost", kind: "money", definition: "Cost of the fund's investment, as reported by the GP." },
  { code: "fair_value", label: "Fair value", kind: "money", definition: "Fair value of the fund's investment, as reported by the GP." },
  { code: "gross_moic", label: "Gross MOIC", kind: "multiple", definition: "Gross multiple of invested capital on the investment, before fees and carry, as reported by the GP." },
  { code: "gross_irr", label: "Gross IRR", kind: "percent", definition: "Gross internal rate of return on the investment, before fees and carry, as reported by the GP." },
  { code: "ownership_pct", label: "Ownership", kind: "percent", definition: "Ownership percentage for a company- or underlying-fund-targeted holding, on the stated basis, as reported by the GP." },
];

/** Every metric code the scorecard reads; the serving query selects exactly these. */
export const SCORECARD_METRIC_CODES: readonly string[] = [...FUND_SCORECARD_METRICS, ...INVESTMENT_SCORECARD_METRICS].map((metric) => metric.code);

export type ScorecardSource = {
  documentId: string;
  sourceReferenceId: string;
  page: number | null;
  sheetName: string | null;
  cellRange: string | null;
};

/** One published, GP-reported consolidated fact, as served by `GET /api/v1/performance-scorecard`. */
export type ScorecardFact = {
  factId: string;
  snapshotId: string;
  publishedAt: string | null;
  fundId: string;
  level: ScorecardLevel;
  /** Subject-level qualified identity within the fund; separate holdings never collapse into one company row. */
  investmentKey: string | null;
  investment: string | null;
  holdingId: string | null;
  companyId: string | null;
  metricCode: string;
  /** Exact decimal text as stored (never a rounded double). */
  valueNumber: string | null;
  valueString: string | null;
  valueRaw: string | null;
  currency: string | null;
  unit: string | null;
  /** ISO date the figure is stated as of; null when the GP's report does not carry one. */
  asOf: string | null;
  /** The economic/report period label (e.g. "Q2 2026"), the fallback when no as-of date was extracted. */
  period: string;
  actuality: string | null;
  scenarioType: string | null;
  isRestated: boolean;
  isDerived: boolean;
  derivationFormula: string | null;
  source: ScorecardSource;
};

export type ScorecardFund = { fundId: string; fund: string };
export type ScorecardPayload = { funds: ScorecardFund[]; facts: ScorecardFact[] };

// ---------------------------------------------------------------------------------------------
// Filters (F1c, #332)
// ---------------------------------------------------------------------------------------------

/**
 * What narrows the scorecard. `fundId` shows one entitled fund; `period` shows, per metric, the latest figure the GP stated
 * for that reporting period (a figure's `period` label, e.g. "Q1 2026"), so an older period reads as what was reported for it
 * rather than turning into "Not reported". Both narrow the tables and the governed export alike, and the export records them.
 * Neither is ever a way to widen access: an entitled fund is a precondition, not something a filter grants.
 */
export type ScorecardFilters = { fundId?: string; period?: string };

export const MAX_SCORECARD_FUND_ID_LENGTH = 512;
export const MAX_SCORECARD_PERIOD_LENGTH = 64;

/** A filter a caller can fix (400). The code is stable and never carries the offending value. */
export class ScorecardFilterError extends Error {
  readonly code = "invalid_scorecard_filter";
  readonly status = 400 as const;
  constructor() { super("invalid_scorecard_filter"); this.name = "ScorecardFilterError"; }
}

// Identifiers and period labels are single-line: C0, DEL and the line/paragraph separators are rejected.
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/;

function filterText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ScorecardFilterError();
  const clean = value.trim();
  if (clean.length === 0 || clean.length > max || SINGLE_LINE_FORBIDDEN.test(clean)) throw new ScorecardFilterError();
  return clean;
}

/**
 * The canonical filters of a request: absent means no filter, anything present must be a non-empty single-line string within
 * its bound (an empty string is an error, never "no filter", so a scope can never widen by accident). Unknown keys are ignored.
 */
export function parseScorecardFilters(input: { fundId?: unknown; period?: unknown }): ScorecardFilters {
  const fundId = filterText(input.fundId, MAX_SCORECARD_FUND_ID_LENGTH);
  const period = filterText(input.period, MAX_SCORECARD_PERIOD_LENGTH);
  return { ...(fundId !== undefined ? { fundId } : {}), ...(period !== undefined ? { period } : {}) };
}

/** Scope label shown for a scorecard export (delivery history, manifest, schedule): the one place its wording is decided. */
export function scorecardScopeLabel(filters: ScorecardFilters): string {
  return `Performance scorecard · ${filters.fundId ?? "all entitled funds"}${filters.period ? ` · ${filters.period}` : ""}`;
}

/** The scorecard narrowed to the filters, by fund and by figure period. Used where the whole fact set is in memory (demo mode). */
export function filterScorecardPayload(payload: ScorecardPayload, filters: ScorecardFilters): ScorecardPayload {
  return {
    funds: payload.funds.filter((fund) => filters.fundId === undefined || fund.fundId === filters.fundId),
    facts: payload.facts.filter((fact) => (filters.fundId === undefined || fact.fundId === filters.fundId) && (filters.period === undefined || fact.period === filters.period)),
  };
}

/**
 * The reporting periods a person can filter by: each distinct period label once, the one with the latest as-of date first
 * (a period without any dated figure last), then by label.
 */
export function scorecardPeriodOptions(entries: readonly { period: string; asOf: string | null }[]): string[] {
  const latest = new Map<string, string | null>();
  for (const { period, asOf } of entries) {
    if (period.trim() === "") continue;
    const known = latest.get(period);
    if (known === undefined || (asOf !== null && (known === null || asOf > known))) latest.set(period, asOf);
  }
  return [...latest.entries()].sort(([leftPeriod, left], [rightPeriod, right]) => {
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return left < right ? 1 : -1;
    }
    return leftPeriod.localeCompare(rightPeriod);
  }).map(([period]) => period);
}

export type ScorecardFigure = {
  factId: string;
  snapshotId: string;
  metricCode: string;
  valueNumber: string | null;
  valueString: string | null;
  valueRaw: string | null;
  currency: string | null;
  unit: string | null;
  asOf: string | null;
  period: string;
  status: ReportedFigureStatus;
  /** Derived by Corvis or its extraction rather than printed by the GP; always labelled. */
  derived: boolean;
  derivationFormula: string | null;
  source: ScorecardSource;
};

/** One table cell: the latest reported figure(s) of a metric. Empty means the GP did not report it. */
export type ScorecardCell = { metric: ScorecardMetric; figures: ScorecardFigure[] };

export type InvestmentRow = {
  key: string;
  fundId: string;
  investment: string;
  holdingId: string | null;
  companyId: string | null;
  cells: ScorecardCell[];
};

export type FundRow = {
  fundId: string;
  fund: string;
  cells: ScorecardCell[];
  investments: InvestmentRow[];
};

export type Scorecard = { funds: FundRow[] };

/**
 * One keyset page of the scorecard, by fund (`GET /api/v1/performance-scorecard`). `funds` holds complete fund rows (a fund is
 * never split across pages). `fundOptions` is every entitled fund whatever the filters, for the fund filter; `periodOptions` is
 * every reporting period with a published figure, sent with the first page only (the client keeps it).
 */
export type ScorecardPage = Scorecard & { filters: ScorecardFilters; fundOptions: ScorecardFund[]; periodOptions: string[] };

/** Scenarios and actualities that are projections, not a result the GP reported; they never reach the scorecard. */
export const SCORECARD_NON_RESULT_VALUES: readonly string[] = [
  "forecast", "budget", "plan", "projected", "projection", "target", "guidance", "pro_forma", "underwritten",
  "management_case", "base_case", "upside_case", "downside_case", "investment_case", "consensus", "other", "unknown",
];
const NOT_A_RESULT = new Set(SCORECARD_NON_RESULT_VALUES);
/** Actualities the GP uses for a figure that is not yet final. */
const PRELIMINARY_ACTUALITY = new Set(["preliminary", "provisional", "estimate", "estimated", "flash"]);

function normalized(value: string | null): string {
  return value == null ? "" : value.trim().toLowerCase();
}

/**
 * Trust flag of one published figure, or null when the fact is not a reported result and must not be shown.
 *
 * Final: published and not flagged otherwise. Preliminary: the GP marked the figure provisional
 * (`actuality` preliminary/provisional/estimate/flash). Restated: the GP flagged the figure as a
 * restatement (`isRestated`). A data-correction supersession is deliberately not a restatement: it is
 * Corvis fixing its own extraction, not the GP restating, and the replacement is simply the current
 * published version. Preliminary outranks Restated, as in the Review trend and Position Financials.
 */
export function reportedFigureStatus(fact: Pick<ScorecardFact, "actuality" | "scenarioType" | "isRestated">): ReportedFigureStatus | null {
  const actuality = normalized(fact.actuality);
  if (NOT_A_RESULT.has(actuality) || NOT_A_RESULT.has(normalized(fact.scenarioType))) return null;
  if (PRELIMINARY_ACTUALITY.has(actuality)) return "Preliminary";
  return fact.isRestated ? "Restated" : "Final";
}

function finiteNumber(text: string | null): number | null {
  if (text == null) return null;
  const parsed = Number(text);
  return text.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
}

function hasText(value: string | null): boolean {
  return value != null && value.trim() !== "";
}

/** A fact with nothing to write down (no number, no text, no raw) is not a figure. */
function isDisplayable(fact: ScorecardFact): boolean {
  return finiteNumber(fact.valueNumber) !== null || hasText(fact.valueString) || hasText(fact.valueRaw);
}

function time(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Total order, most recent first: later as-of date, then later publication, then snapshot id, then fact id.
 * A fact without an as-of date ranks below every dated one. The serving query orders its per-metric
 * candidates the same way, so the latest fact it returns is the latest fact here.
 */
export function compareLatestFirst(a: ScorecardFact, b: ScorecardFact): number {
  if (a.asOf !== b.asOf) {
    if (a.asOf == null) return 1;
    if (b.asOf == null) return -1;
    return a.asOf < b.asOf ? 1 : -1;
  }
  const left = time(a.publishedAt);
  const right = time(b.publishedAt);
  if (left !== right) {
    if (left == null) return 1;
    if (right == null) return -1;
    return left < right ? 1 : -1;
  }
  if (a.snapshotId !== b.snapshotId) return a.snapshotId < b.snapshotId ? 1 : -1;
  if (a.factId === b.factId) return 0;
  return a.factId < b.factId ? 1 : -1;
}

function figureOf(fact: ScorecardFact, status: ReportedFigureStatus): ScorecardFigure {
  return {
    factId: fact.factId,
    snapshotId: fact.snapshotId,
    metricCode: fact.metricCode,
    valueNumber: fact.valueNumber,
    valueString: fact.valueString,
    valueRaw: fact.valueRaw,
    currency: fact.currency,
    unit: fact.unit,
    asOf: fact.asOf,
    period: fact.period,
    status,
    derived: fact.isDerived,
    derivationFormula: fact.derivationFormula,
    source: fact.source,
  };
}

/**
 * The latest reported figure(s) of one metric for one subject. When the latest as-of date is reported
 * in more than one currency or unit, each is kept (the newest of each): they are different figures, never
 * summed, converted or merged. Older as-of dates are history and are dropped.
 */
export function latestFigures(facts: readonly ScorecardFact[]): ScorecardFigure[] {
  const candidates = facts
    .flatMap((fact) => {
      const status = reportedFigureStatus(fact);
      return status !== null && isDisplayable(fact) ? [{ fact, status }] : [];
    })
    .sort((a, b) => compareLatestFirst(a.fact, b.fact));
  if (candidates.length === 0) return [];
  const latestAsOf = candidates[0]!.fact.asOf;
  const seen = new Set<string>();
  const figures: ScorecardFigure[] = [];
  for (const { fact, status } of candidates) {
    if (fact.asOf !== latestAsOf) continue;
    const key = `${normalized(fact.currency)}|${normalized(fact.unit)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    figures.push(figureOf(fact, status));
  }
  return figures;
}

function cellsFor(metrics: readonly ScorecardMetric[], facts: readonly ScorecardFact[]): ScorecardCell[] {
  return metrics.map((metric) => ({ metric, figures: latestFigures(facts.filter((fact) => fact.metricCode === metric.code)) }));
}

/** Name, then id: the order of every fund and investment list, and the key the fund pages walk. */
export function nameOrder(a: { name: string; id: string }, b: { name: string; id: string }): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Builds the two scorecard tables from published facts. Every entitled fund gets a row even when it has
 * no published figure; an investment gets a row once any investment-level figure is published for it.
 */
export function buildScorecard(payload: ScorecardPayload): Scorecard {
  const fundMetricCodes = new Set(FUND_SCORECARD_METRICS.map((metric) => metric.code));
  const investmentMetricCodes = new Set(INVESTMENT_SCORECARD_METRICS.map((metric) => metric.code));
  const names = new Map<string, string>();
  for (const fund of payload.funds) if (!names.has(fund.fundId)) names.set(fund.fundId, fund.fund);

  const fundFacts = new Map<string, ScorecardFact[]>();
  const investmentFacts = new Map<string, Map<string, ScorecardFact[]>>();
  for (const fact of payload.facts) {
    if (!names.has(fact.fundId)) names.set(fact.fundId, fact.fundId);
    if (fact.level === "fund") {
      if (!fundMetricCodes.has(fact.metricCode)) continue;
      fundFacts.set(fact.fundId, [...(fundFacts.get(fact.fundId) ?? []), fact]);
      continue;
    }
    if (!investmentMetricCodes.has(fact.metricCode) || fact.investmentKey == null) continue;
    const byInvestment = investmentFacts.get(fact.fundId) ?? new Map<string, ScorecardFact[]>();
    byInvestment.set(fact.investmentKey, [...(byInvestment.get(fact.investmentKey) ?? []), fact]);
    investmentFacts.set(fact.fundId, byInvestment);
  }

  const funds = [...names.entries()].map(([fundId, fund]): FundRow => {
    const investments = [...(investmentFacts.get(fundId) ?? new Map<string, ScorecardFact[]>()).entries()].map(([key, facts]): InvestmentRow => {
      const named = facts.find((fact) => hasText(fact.investment));
      return {
        key,
        fundId,
        investment: named?.investment ?? key,
        holdingId: facts.find((fact) => fact.holdingId != null)?.holdingId ?? null,
        companyId: facts.find((fact) => fact.companyId != null)?.companyId ?? null,
        cells: cellsFor(INVESTMENT_SCORECARD_METRICS, facts),
      };
    }).sort((a, b) => nameOrder({ name: a.investment, id: a.key }, { name: b.investment, id: b.key }));
    return { fundId, fund, cells: cellsFor(FUND_SCORECARD_METRICS, fundFacts.get(fundId) ?? []), investments };
  }).sort((a, b) => nameOrder({ name: a.fund, id: a.fundId }, { name: b.fund, id: b.fundId }));
  return { funds };
}

// ---------------------------------------------------------------------------------------------
// Writing a figure down. These helpers are presentation only: they never change the reported value.
// ---------------------------------------------------------------------------------------------

export type FormatNumber = (value: number, options: { minimumFractionDigits: number; maximumFractionDigits: number }) => string;

const SCALE_WORDS: Readonly<Record<string, number>> = {
  k: 1e3, thousand: 1e3, thousands: 1e3,
  m: 1e6, mm: 1e6, million: 1e6, millions: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9,
};
/** Units that say a percentage was reported as a fraction of one (0.142 for 14.2%). */
const FRACTION_UNITS = new Set(["fraction", "ratio", "decimal"]);

function scaleOf(unit: string | null): number | null {
  const scale = SCALE_WORDS[normalized(unit)];
  return scale ?? null;
}

function percentNumber(figure: Pick<ScorecardFigure, "valueNumber" | "unit">): number | null {
  const parsed = finiteNumber(figure.valueNumber);
  if (parsed === null) return null;
  // A fraction of one is written as a percentage (0.142 reads 14.2%); the figure itself is unchanged and formatting rounds away binary noise.
  return FRACTION_UNITS.has(normalized(figure.unit)) ? parsed * 100 : parsed;
}

/**
 * The figure as the reader sees it. A numeric value is formatted for its kind (money with its currency and
 * any scale the GP stated, a multiple with an `x`, a percentage with a `%`); a non-numeric value the GP
 * reported (for example "NM") is shown verbatim, falling back to the text as printed in the source.
 */
export function formatFigure(figure: ScorecardFigure, kind: ScorecardMetricKind, formatNumber: FormatNumber): string {
  const numeric = kind === "percent" ? percentNumber(figure) : finiteNumber(figure.valueNumber);
  if (numeric === null) return figure.valueString ?? figure.valueRaw ?? "";
  if (kind === "multiple") return `${formatNumber(numeric, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}x`;
  if (kind === "percent") return `${formatNumber(numeric, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
  const amount = formatNumber(numeric, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const scale = scaleOf(figure.unit) === null ? "" : ` ${figure.unit!.trim()}`;
  return `${figure.currency ? `${figure.currency} ` : ""}${amount}${scale}`;
}

/**
 * Numeric key for sorting a column. Money is compared at its stated scale (1,958 millions sorts above
 * 1,271,000,000 units correctly). A figure with no number sorts last. This is never displayed.
 */
export function figureSortValue(figure: ScorecardFigure | undefined, kind: ScorecardMetricKind): number | null {
  if (!figure) return null;
  if (kind === "percent") return percentNumber(figure);
  const numeric = finiteNumber(figure.valueNumber);
  if (numeric === null) return null;
  return kind === "money" ? numeric * (scaleOf(figure.unit) ?? 1) : numeric;
}

/** Sort key of a whole cell: the first figure's key (cells with several currencies sort by the first). */
export function cellSortValue(cell: ScorecardCell): number | null {
  return figureSortValue(cell.figures[0], cell.metric.kind);
}

/** The as-of date when one was extracted, else the reporting period, else nothing. */
export function figureAsOf(figure: Pick<ScorecardFigure, "asOf" | "period">): { kind: "date" | "period"; value: string } | null {
  if (figure.asOf) return { kind: "date", value: figure.asOf };
  if (figure.period) return { kind: "period", value: figure.period };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Governed export rows
// ---------------------------------------------------------------------------------------------

/**
 * Columns of the scorecard export. `value_number` is the exact decimal text (Parquet DECIMAL(38,10)), `is_derived`
 * a Parquet BOOLEAN, everything else text. A metric the GP did not report is a row with status "Not reported" and
 * an empty value, so no consumer can read an absence as zero.
 */
export const SCORECARD_EXPORT_COLUMNS = [
  "level",
  "fund_id",
  "fund_name",
  "investment_id",
  "investment_name",
  "holding_id",
  "company_id",
  "metric_code",
  "metric_label",
  "status",
  "value_number",
  "value_string",
  "value_raw",
  "currency",
  "unit",
  "as_of_date",
  "report_period",
  "is_derived",
  "derivation_formula",
  "snapshot_id",
  "document_id",
  "source_reference_id",
  "source_page",
] as const;

export type ScorecardExportRow = Record<(typeof SCORECARD_EXPORT_COLUMNS)[number], string | number | boolean | null>;

function exportRows(
  base: Pick<ScorecardExportRow, "level" | "fund_id" | "fund_name" | "investment_id" | "investment_name" | "holding_id" | "company_id">,
  cells: readonly ScorecardCell[],
): ScorecardExportRow[] {
  return cells.flatMap((cell): ScorecardExportRow[] => {
    const common = { ...base, metric_code: cell.metric.code, metric_label: cell.metric.label };
    if (cell.figures.length === 0) {
      return [{
        ...common, status: NOT_REPORTED, value_number: null, value_string: null, value_raw: null, currency: null, unit: null,
        as_of_date: null, report_period: null, is_derived: null, derivation_formula: null, snapshot_id: null,
        document_id: null, source_reference_id: null, source_page: null,
      }];
    }
    return cell.figures.map((figure) => ({
      ...common,
      status: figure.status,
      value_number: figure.valueNumber,
      value_string: figure.valueString,
      value_raw: figure.valueRaw,
      currency: figure.currency,
      unit: figure.unit,
      as_of_date: figure.asOf,
      report_period: figure.period,
      is_derived: figure.derived,
      derivation_formula: figure.derivationFormula,
      snapshot_id: figure.snapshotId,
      document_id: figure.source.documentId,
      source_reference_id: figure.source.sourceReferenceId,
      source_page: figure.source.page,
    }));
  });
}

/** Published snapshots the shown figures come from, sorted: the snapshots a governed export of this view is pinned to. */
export function scorecardSnapshotIds(scorecard: Scorecard): string[] {
  const ids = new Set<string>();
  for (const fund of scorecard.funds) {
    for (const cell of [...fund.cells, ...fund.investments.flatMap((investment) => investment.cells)]) {
      for (const figure of cell.figures) ids.add(figure.snapshotId);
    }
  }
  return [...ids].sort();
}

/** Flat rows for the governed export: every fund's metrics, then each fund's investments' metrics, in table order. */
export function scorecardExportRows(scorecard: Scorecard): ScorecardExportRow[] {
  return scorecard.funds.flatMap((fund) => [
    ...exportRows({ level: "fund", fund_id: fund.fundId, fund_name: fund.fund, investment_id: null, investment_name: null, holding_id: null, company_id: null }, fund.cells),
    ...fund.investments.flatMap((investment) => exportRows(
      { level: "investment", fund_id: fund.fundId, fund_name: fund.fund, investment_id: investment.key, investment_name: investment.investment, holding_id: investment.holdingId, company_id: investment.companyId },
      investment.cells,
    )),
  ]);
}
