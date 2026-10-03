import assert from "node:assert/strict";
import test from "node:test";
import {
  FUND_SCORECARD_METRICS,
  INVESTMENT_SCORECARD_METRICS,
  NOT_REPORTED,
  SCORECARD_EXPORT_COLUMNS,
  SCORECARD_METRIC_CODES,
  buildScorecard,
  cellSortValue,
  compareLatestFirst,
  figureAsOf,
  figureSortValue,
  formatFigure,
  latestFigures,
  reportedFigureStatus,
  scorecardExportRows,
  type FormatNumber,
  type ScorecardFact,
  type ScorecardFigure,
} from "./performance-scorecard.ts";

const SOURCE = { documentId: "doc-1", sourceReferenceId: "ref-1", page: 12, sheetName: null, cellRange: null };
let sequence = 0;

function fact(overrides: Partial<ScorecardFact> = {}): ScorecardFact {
  sequence += 1;
  return {
    factId: `fact-${String(sequence).padStart(3, "0")}`,
    snapshotId: "snap-1",
    publishedAt: "2026-07-01T00:00:00.000Z",
    fundId: "fund-a",
    level: "fund",
    investmentKey: null,
    investment: null,
    holdingId: null,
    companyId: null,
    metricCode: "nav",
    valueNumber: "100",
    valueString: null,
    valueRaw: null,
    currency: "USD",
    unit: null,
    asOf: "2026-06-30",
    period: "Q2 2026",
    actuality: "actual",
    scenarioType: null,
    isRestated: false,
    isDerived: false,
    derivationFormula: null,
    source: SOURCE,
    ...overrides,
  };
}

const format: FormatNumber = (value, options) => value.toLocaleString("en-US", options);

function figure(overrides: Partial<ScorecardFigure> = {}): ScorecardFigure {
  return {
    factId: "f", snapshotId: "s", metricCode: "nav", valueNumber: "100", valueString: null, valueRaw: null, currency: null, unit: null,
    asOf: "2026-06-30", period: "Q2 2026", status: "Final", derived: false, derivationFormula: null, source: SOURCE, ...overrides,
  };
}

test("the dictionary covers exactly the six fund-level and five investment-level metrics the issue names", () => {
  assert.deepEqual(FUND_SCORECARD_METRICS.map((metric) => metric.code), ["nav", "tvpi", "dpi", "rvpi", "net_irr", "net_moic"]);
  assert.deepEqual(INVESTMENT_SCORECARD_METRICS.map((metric) => metric.code), ["cost", "fair_value", "gross_moic", "gross_irr", "ownership_pct"]);
  assert.deepEqual([...SCORECARD_METRIC_CODES], ["nav", "tvpi", "dpi", "rvpi", "net_irr", "net_moic", "cost", "fair_value", "gross_moic", "gross_irr", "ownership_pct"]);
  for (const metric of [...FUND_SCORECARD_METRICS, ...INVESTMENT_SCORECARD_METRICS]) assert.ok(metric.definition.endsWith("as reported by the GP."), metric.code);
});

test("a published figure is Final unless the GP flagged it preliminary or restated, and preliminary outranks restated", () => {
  assert.equal(reportedFigureStatus({ actuality: "actual", scenarioType: null, isRestated: false }), "Final");
  assert.equal(reportedFigureStatus({ actuality: null, scenarioType: "reported", isRestated: false }), "Final");
  assert.equal(reportedFigureStatus({ actuality: "actual", scenarioType: null, isRestated: true }), "Restated");
  for (const actuality of ["preliminary", "Provisional", " ESTIMATE ", "estimated", "flash"]) {
    assert.equal(reportedFigureStatus({ actuality, scenarioType: null, isRestated: false }), "Preliminary", actuality);
  }
  assert.equal(reportedFigureStatus({ actuality: "preliminary", scenarioType: null, isRestated: true }), "Preliminary");
});

test("a forecast, budget or target is not a reported result and has no status", () => {
  for (const value of ["forecast", "Budget", "plan", "projected", "projection", "target"]) {
    assert.equal(reportedFigureStatus({ actuality: value, scenarioType: null, isRestated: false }), null, value);
    assert.equal(reportedFigureStatus({ actuality: "actual", scenarioType: value, isRestated: false }), null, value);
  }
});

test("compareLatestFirst orders by as-of, then publication, then snapshot, then fact id", () => {
  const base = { asOf: "2026-06-30", publishedAt: "2026-07-01T00:00:00.000Z", snapshotId: "b" };
  const facts = [
    fact({ ...base, factId: "a-fact" }),
    fact({ ...base, factId: "z-fact" }),
    fact({ ...base, factId: "snapshot-later", snapshotId: "c" }),
    fact({ ...base, factId: "published-later", publishedAt: "2026-08-01T00:00:00.000Z" }),
    fact({ ...base, factId: "newest-asof", asOf: "2026-09-30" }),
  ];
  assert.deepEqual([...facts].sort(compareLatestFirst).map((item) => item.factId), ["newest-asof", "published-later", "snapshot-later", "z-fact", "a-fact"]);
  assert.equal(compareLatestFirst(facts[0]!, facts[0]!), 0);
  const early = fact({ ...base, snapshotId: "a", factId: "x" });
  const late = fact({ ...base, snapshotId: "c", factId: "x" });
  assert.ok(compareLatestFirst(late, early) < 0 && compareLatestFirst(early, late) > 0);
});

test("compareLatestFirst ranks an undated fact below any dated one and an unpublished or unparseable publication below any published one", () => {
  const dated = fact({ asOf: "2026-06-30" });
  const undated = fact({ asOf: null });
  assert.ok(compareLatestFirst(dated, undated) < 0);
  assert.ok(compareLatestFirst(undated, dated) > 0);
  const published = fact({ publishedAt: "2026-01-01T00:00:00Z" });
  for (const publishedAt of [null, "garbage"]) {
    const unpublished = fact({ publishedAt });
    assert.ok(compareLatestFirst(published, unpublished) < 0, String(publishedAt));
    assert.ok(compareLatestFirst(unpublished, published) > 0, String(publishedAt));
  }
  // Two facts that are equally unpublished fall through to the id tie-break instead of comparing as NaN.
  assert.ok(compareLatestFirst(fact({ factId: "b", publishedAt: null }), fact({ factId: "a", publishedAt: "garbage" })) < 0);
});

test("latestFigures keeps the latest as-of figure and drops history, never 0 for a missing one", () => {
  const figures = latestFigures([
    fact({ factId: "old", asOf: "2026-03-31", valueNumber: "90", period: "Q1 2026" }),
    fact({ factId: "new", asOf: "2026-06-30", valueNumber: "100" }),
  ]);
  assert.deepEqual(figures.map((item) => [item.factId, item.valueNumber, item.status]), [["new", "100", "Final"]]);
  assert.deepEqual(latestFigures([]), []);
});

test("latestFigures skips projections and facts with nothing to show, so the metric is Not reported rather than blank or zero", () => {
  assert.deepEqual(latestFigures([fact({ actuality: "forecast" })]), []);
  assert.deepEqual(latestFigures([fact({ valueNumber: null, valueString: null, valueRaw: null })]), []);
  assert.deepEqual(latestFigures([fact({ valueNumber: "not-a-number", valueString: " ", valueRaw: "" })]), []);
  assert.deepEqual(latestFigures([fact({ valueNumber: " ", valueString: null, valueRaw: null })]), []);
  assert.equal(latestFigures([fact({ valueNumber: null, valueString: "NM" })]).length, 1);
  assert.equal(latestFigures([fact({ valueNumber: null, valueRaw: "n/a" })]).length, 1);
  // A forecast later than the actual does not displace it.
  const figures = latestFigures([fact({ factId: "actual", asOf: "2026-03-31" }), fact({ factId: "budget", asOf: "2026-12-31", actuality: "budget" })]);
  assert.deepEqual(figures.map((item) => item.factId), ["actual"]);
});

test("a restated figure published after the original at the same as-of date is the latest, and is flagged Restated", () => {
  const [latest] = latestFigures([
    fact({ factId: "original", publishedAt: "2026-07-01T00:00:00Z", valueNumber: "100" }),
    fact({ factId: "restated", publishedAt: "2026-09-01T00:00:00Z", valueNumber: "98", isRestated: true }),
  ]);
  assert.equal(latest?.factId, "restated");
  assert.equal(latest?.status, "Restated");
});

test("figures reported at the latest as-of date in different currencies are each kept and never merged or converted", () => {
  const figures = latestFigures([
    fact({ factId: "usd-old", currency: "USD", publishedAt: "2026-07-01T00:00:00Z", valueNumber: "100" }),
    fact({ factId: "usd-new", currency: "usd", publishedAt: "2026-08-01T00:00:00Z", valueNumber: "101" }),
    fact({ factId: "eur", currency: "EUR", valueNumber: "90" }),
    fact({ factId: "eur-stale", currency: "EUR", asOf: "2026-03-31", valueNumber: "80" }),
    fact({ factId: "gbp-stale", currency: "GBP", asOf: "2026-03-31", valueNumber: "70" }),
  ]);
  assert.deepEqual(figures.map((item) => item.factId).sort(), ["eur", "usd-new"]);
  assert.deepEqual(figures.map((item) => item.valueNumber).sort(), ["101", "90"], "values are the reported ones, not a sum");
});

test("when no fact carries an as-of date the newest publication wins and the reporting period stands in", () => {
  const figures = latestFigures([
    fact({ factId: "a", asOf: null, publishedAt: "2026-07-01T00:00:00Z", currency: null }),
    fact({ factId: "b", asOf: null, publishedAt: "2026-08-01T00:00:00Z", currency: null }),
  ]);
  assert.deepEqual(figures.map((item) => item.factId), ["b"]);
});

test("a derived figure keeps its Derived flag and formula", () => {
  const [derived] = latestFigures([fact({ isDerived: true, derivationFormula: "NAV / paid-in" })]);
  assert.equal(derived?.derived, true);
  assert.equal(derived?.derivationFormula, "NAV / paid-in");
  assert.equal(latestFigures([fact()])[0]?.derived, false);
});

test("buildScorecard lists every entitled fund, with Not reported cells for metrics the GP never reported", () => {
  const scorecard = buildScorecard({
    funds: [{ fundId: "fund-b", fund: "Bravo Fund" }, { fundId: "fund-a", fund: "Alpha Fund" }, { fundId: "fund-a", fund: "Duplicate name ignored" }, { fundId: "fund-empty", fund: "Empty Fund" }],
    facts: [
      fact({ fundId: "fund-a", metricCode: "nav", valueNumber: "100" }),
      fact({ fundId: "fund-a", metricCode: "tvpi", valueNumber: "1.5" }),
      fact({ fundId: "fund-b", metricCode: "net_irr", valueNumber: "12" }),
    ],
  });
  assert.deepEqual(scorecard.funds.map((row) => row.fund), ["Alpha Fund", "Bravo Fund", "Empty Fund"]);
  const alpha = scorecard.funds[0]!;
  assert.deepEqual(alpha.cells.map((cell) => [cell.metric.code, cell.figures.length]), [["nav", 1], ["tvpi", 1], ["dpi", 0], ["rvpi", 0], ["net_irr", 0], ["net_moic", 0]]);
  const empty = scorecard.funds[2]!;
  assert.ok(empty.cells.every((cell) => cell.figures.length === 0));
  assert.deepEqual(empty.investments, []);
});

test("a fact for a fund the payload does not list still gets a row, named by its id", () => {
  const scorecard = buildScorecard({ funds: [], facts: [fact({ fundId: "fund-x" })] });
  assert.deepEqual(scorecard.funds.map((row) => [row.fundId, row.fund]), [["fund-x", "fund-x"]]);
});

test("a metric at the wrong subject level is ignored: fair value is not a fund metric and NAV is not an investment metric", () => {
  const scorecard = buildScorecard({
    funds: [{ fundId: "fund-a", fund: "Alpha" }],
    facts: [
      fact({ metricCode: "fair_value", level: "fund" }),
      fact({ metricCode: "nav", level: "investment", investmentKey: "co-1", investment: "Co" }),
      fact({ metricCode: "cost", level: "investment", investmentKey: null }),
      fact({ metricCode: "bogus", level: "fund" }),
    ],
  });
  assert.ok(scorecard.funds[0]!.cells.every((cell) => cell.figures.length === 0));
  assert.deepEqual(scorecard.funds[0]!.investments, []);
});

test("investments are grouped per fund by key, named, sorted and carry only their own latest figures", () => {
  const scorecard = buildScorecard({
    funds: [{ fundId: "fund-a", fund: "Alpha" }, { fundId: "fund-b", fund: "Bravo" }],
    facts: [
      fact({ level: "investment", investmentKey: "co-z", investment: "Zeta", companyId: "co-z", holdingId: "h-z", metricCode: "fair_value", valueNumber: "5" }),
      fact({ level: "investment", investmentKey: "co-a", investment: null, companyId: null, holdingId: null, metricCode: "cost", valueNumber: "2" }),
      fact({ level: "investment", investmentKey: "co-a", investment: " ", companyId: "co-a", holdingId: "h-a", metricCode: "fair_value", valueNumber: "4" }),
      fact({ level: "investment", investmentKey: "co-a", investment: "Acme", metricCode: "fair_value", asOf: "2026-03-31", valueNumber: "3" }),
      fact({ level: "investment", investmentKey: "co-same", investment: "Same", metricCode: "cost" }),
      fact({ level: "investment", investmentKey: "co-same2", investment: "Same", metricCode: "cost" }),
      fact({ fundId: "fund-b", level: "investment", investmentKey: "co-a", investment: "Other fund's Acme", metricCode: "gross_irr", valueNumber: "21" }),
    ],
  });
  const alpha = scorecard.funds[0]!;
  assert.deepEqual(alpha.investments.map((row) => [row.key, row.investment, row.holdingId, row.companyId]), [
    ["co-a", "Acme", "h-a", "co-a"],
    ["co-same", "Same", null, null],
    ["co-same2", "Same", null, null],
    ["co-z", "Zeta", "h-z", "co-z"],
  ]);
  const acme = alpha.investments[0]!;
  assert.deepEqual(acme.cells.map((cell) => [cell.metric.code, cell.figures.map((item) => item.valueNumber)]), [["cost", ["2"]], ["fair_value", ["4"]], ["gross_moic", []], ["gross_irr", []], ["ownership_pct", []]]);
  assert.equal(scorecard.funds[1]!.investments[0]!.investment, "Other fund's Acme");
});

test("an investment with no usable name falls back to its key", () => {
  const scorecard = buildScorecard({ funds: [{ fundId: "fund-a", fund: "Alpha" }], facts: [fact({ level: "investment", investmentKey: "h-9", investment: null, metricCode: "cost" })] });
  assert.equal(scorecard.funds[0]!.investments[0]!.investment, "h-9");
});

test("formatFigure writes money with currency and the scale the GP stated, multiples with x and percentages with %", () => {
  assert.equal(formatFigure(figure({ valueNumber: "1958000000.0000000000", currency: "USD" }), "money", format), "USD 1,958,000,000");
  assert.equal(formatFigure(figure({ valueNumber: "1958.5", currency: "USD", unit: "millions" }), "money", format), "USD 1,958.5 millions");
  assert.equal(formatFigure(figure({ valueNumber: "12", currency: null, unit: "USD" }), "money", format), "12", "a non-scale unit is not appended");
  assert.equal(formatFigure(figure({ valueNumber: "1.6200000000" }), "multiple", format), "1.62x");
  assert.equal(formatFigure(figure({ valueNumber: "1.8345" }), "multiple", format), "1.8345x");
  assert.equal(formatFigure(figure({ valueNumber: "14.2" }), "percent", format), "14.2%");
  assert.equal(formatFigure(figure({ valueNumber: "12" }), "percent", format), "12%");
  assert.equal(formatFigure(figure({ valueNumber: "0.142", unit: "fraction" }), "percent", format), "14.2%");
  assert.equal(formatFigure(figure({ valueNumber: "0.07", unit: "Ratio" }), "percent", format), "7%");
});

test("a zero the GP reported is written as zero, while a non-numeric value is shown as reported", () => {
  assert.equal(formatFigure(figure({ valueNumber: "0" }), "multiple", format), "0.00x");
  assert.equal(formatFigure(figure({ valueNumber: null, valueString: "NM" }), "multiple", format), "NM");
  assert.equal(formatFigure(figure({ valueNumber: null, valueString: null, valueRaw: "n/a" }), "percent", format), "n/a");
  assert.equal(formatFigure(figure({ valueNumber: null, valueString: null, valueRaw: null }), "money", format), "");
});

test("sort keys compare money at its stated scale, percentages as written and unnumbered figures last", () => {
  assert.equal(figureSortValue(undefined, "money"), null);
  assert.equal(figureSortValue(figure({ valueNumber: "1958", unit: "millions" }), "money"), 1958e6);
  assert.equal(figureSortValue(figure({ valueNumber: "5", unit: "bn" }), "money"), 5e9);
  assert.equal(figureSortValue(figure({ valueNumber: "7", unit: null }), "money"), 7);
  assert.equal(figureSortValue(figure({ valueNumber: "1.5" }), "multiple"), 1.5);
  assert.equal(figureSortValue(figure({ valueNumber: "0.5", unit: "fraction" }), "percent"), 50);
  assert.equal(figureSortValue(figure({ valueNumber: "12" }), "percent"), 12);
  assert.equal(figureSortValue(figure({ valueNumber: null, valueString: "NM" }), "percent"), null);
  assert.equal(figureSortValue(figure({ valueNumber: null, valueString: "NM" }), "money"), null);
  const navCell = { metric: FUND_SCORECARD_METRICS[0]!, figures: [figure({ valueNumber: "3", unit: "millions" })] };
  assert.equal(cellSortValue(navCell), 3e6);
  assert.equal(cellSortValue({ metric: FUND_SCORECARD_METRICS[0]!, figures: [] }), null);
});

test("figureAsOf prefers the extracted as-of date, falls back to the reporting period, else nothing", () => {
  assert.deepEqual(figureAsOf({ asOf: "2026-06-30", period: "Q2 2026" }), { kind: "date", value: "2026-06-30" });
  assert.deepEqual(figureAsOf({ asOf: null, period: "Q2 2026" }), { kind: "period", value: "Q2 2026" });
  assert.equal(figureAsOf({ asOf: null, period: "" }), null);
});

test("export rows list reported figures with their source and an explicit Not reported row, never an empty zero", () => {
  const scorecard = buildScorecard({
    funds: [{ fundId: "fund-a", fund: "Alpha" }],
    facts: [
      fact({ metricCode: "nav", valueNumber: "100.0000000000", currency: "USD", isDerived: true, derivationFormula: "x" }),
      fact({ metricCode: "net_irr", valueNumber: "14.2", currency: null, actuality: "preliminary" }),
      fact({ level: "investment", investmentKey: "co-1", investment: "Acme", companyId: "co-1", holdingId: "h-1", metricCode: "ownership_pct", valueNumber: "12.5", currency: null, isRestated: true }),
    ],
  });
  const rows = scorecardExportRows(scorecard);
  assert.equal(rows.length, FUND_SCORECARD_METRICS.length + INVESTMENT_SCORECARD_METRICS.length);
  for (const row of rows) assert.deepEqual(Object.keys(row), [...SCORECARD_EXPORT_COLUMNS]);
  const nav = rows.find((row) => row.metric_code === "nav")!;
  assert.deepEqual([nav.level, nav.fund_id, nav.investment_id, nav.status, nav.value_number, nav.currency, nav.as_of_date, nav.is_derived, nav.derivation_formula, nav.document_id, nav.source_reference_id, nav.source_page], ["fund", "fund-a", null, "Final", "100.0000000000", "USD", "2026-06-30", true, "x", "doc-1", "ref-1", 12]);
  assert.equal(rows.find((row) => row.metric_code === "net_irr")!.status, "Preliminary");
  const missing = rows.find((row) => row.metric_code === "tvpi")!;
  assert.deepEqual([missing.status, missing.value_number, missing.value_string, missing.document_id, missing.is_derived], [NOT_REPORTED, null, null, null, null]);
  const ownership = rows.find((row) => row.metric_code === "ownership_pct")!;
  assert.deepEqual([ownership.level, ownership.investment_id, ownership.investment_name, ownership.holding_id, ownership.company_id, ownership.status], ["investment", "co-1", "Acme", "h-1", "co-1", "Restated"]);
  assert.equal(rows.filter((row) => row.status === NOT_REPORTED).length, rows.length - 3);
});

test("export rows are empty for an empty scorecard", () => {
  assert.deepEqual(scorecardExportRows({ funds: [] }), []);
});
