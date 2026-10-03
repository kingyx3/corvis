import assert from "node:assert/strict";
import test from "node:test";
import { buildScorecard, formatFigure, scorecardExportRows, type FormatNumber } from "../../core/performance-scorecard.ts";
import { documents } from "../../adapters/demo/catalog.ts";
import { demoPerformanceScorecard } from "./performance-scorecard-demo.ts";

const format: FormatNumber = (value, options) => value.toLocaleString("en-US", options);

function scorecard() { return buildScorecard(demoPerformanceScorecard()); }
function fundRow(id: string) { return scorecard().funds.find((row) => row.fundId === id)!; }
function cell(id: string, code: string) { return fundRow(id).cells.find((item) => item.metric.code === code)!; }
function investmentCell(fundId: string, key: string, code: string) { return fundRow(fundId).investments.find((row) => row.key === key)!.cells.find((item) => item.metric.code === code)!; }

test("the demo lists every entitled fund, including one with nothing published", () => {
  assert.deepEqual(scorecard().funds.map((row) => row.fund), ["Advent International GPE VIII", "EQT IX", "Hg Genesis 9", "Nordic Capital Fund V"]);
  const nordic = fundRow("fund-nordic-v");
  assert.ok(nordic.cells.every((item) => item.figures.length === 0));
  assert.deepEqual(nordic.investments, []);
});

test("the demo shows only the latest figure of each metric, as of its own date, with a published demo source document", () => {
  const nav = cell("fund-advent-viii", "nav").figures;
  assert.equal(nav.length, 1);
  assert.equal(nav[0]!.asOf, "2026-06-30", "the Q1 2026 NAV is history");
  assert.equal(formatFigure(nav[0]!, "money", format), "USD 1,958,000,000");
  assert.equal(cell("fund-advent-viii", "net_moic").figures[0]!.asOf, "2026-03-31", "a metric last reported in Q1 keeps its older as-of date");
  assert.equal(investmentCell("fund-advent-viii", "company-abc-corp", "fair_value").figures[0]!.valueNumber, "702000000");
  const documentIds = new Set(documents.map((doc) => doc.id));
  for (const fact of demoPerformanceScorecard().facts) assert.ok(documentIds.has(fact.source.documentId), `${fact.factId} drills through to a demo document`);
});

test("the demo exercises every flag: Final, Preliminary, Restated, Derived, a non-numeric figure and a fraction-stated IRR", () => {
  assert.equal(cell("fund-advent-viii", "tvpi").figures[0]!.status, "Final");
  assert.equal(cell("fund-eqt-ix", "tvpi").figures[0]!.status, "Preliminary");
  assert.equal(cell("fund-eqt-ix", "nav").figures[0]!.status, "Restated");
  assert.equal(investmentCell("fund-advent-viii", "company-atlas-industrial", "gross_irr").figures[0]!.status, "Preliminary");
  assert.equal(investmentCell("fund-advent-viii", "company-harbor-logistics", "fair_value").figures[0]!.status, "Restated");
  const derived = cell("fund-hg-genesis-9", "rvpi").figures[0]!;
  assert.deepEqual([derived.derived, derived.derivationFormula], [true, "NAV / paid-in capital"]);
  assert.equal(formatFigure(cell("fund-hg-genesis-9", "tvpi").figures[0]!, "multiple", format), "NM");
  assert.equal(formatFigure(cell("fund-eqt-ix", "net_irr").figures[0]!, "percent", format), "11.8%");
});

test("the demo never merges currencies and reports blanks and unreported metrics as Not reported rather than 0", () => {
  const hgNav = cell("fund-hg-genesis-9", "nav").figures;
  assert.deepEqual(hgNav.map((figure) => formatFigure(figure, "money", format)).sort(), ["EUR 664 millions", "USD 719 millions"]);
  assert.equal(cell("fund-eqt-ix", "net_moic").figures.length, 0, "a blank report line is not a figure");
  assert.equal(cell("fund-eqt-ix", "rvpi").figures.length, 0);
  assert.equal(cell("fund-hg-genesis-9", "dpi").figures.length, 0);
  assert.equal(fundRow("fund-hg-genesis-9").investments.length, 0);
  const rows = scorecardExportRows(scorecard());
  assert.ok(rows.some((row) => row.fund_id === "fund-eqt-ix" && row.metric_code === "net_moic" && row.status === "Not reported" && row.value_number === null));
});

test("each call returns a fresh payload so a caller cannot change the demo data", () => {
  const first = demoPerformanceScorecard();
  first.funds[0]!.fund = "changed";
  assert.equal(demoPerformanceScorecard().funds[0]!.fund, "Advent International GPE VIII");
});
