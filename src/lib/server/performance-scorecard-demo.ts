import { AuthorizationError } from "../../core/enterprise.ts";
import { filterScorecardPayload, type ScorecardFact, type ScorecardFilters, type ScorecardFund, type ScorecardPayload } from "../../core/performance-scorecard.ts";

/**
 * Synthetic scorecard dataset for demo mode. Fund, company, holding, snapshot and document ids match
 * src/adapters/demo/catalog.ts (so drilling through lands on a real demo document), and the NAV/fair values match
 * its published portfolio values. The data is deliberately varied so the demo exercises every state of the
 * scorecard: Final, Preliminary and Restated figures, a Derived figure, a non-numeric figure the GP reported
 * ("NM"), a fund reporting NAV in two currencies, a fund with nothing published, a metric history (the older
 * value is never shown) and metrics the GP did not report.
 */
export const DEMO_SCORECARD_FUNDS: ScorecardFund[] = [
  { fundId: "fund-advent-viii", fund: "Advent International GPE VIII" },
  { fundId: "fund-nordic-v", fund: "Nordic Capital Fund V" },
  { fundId: "fund-eqt-ix", fund: "EQT IX" },
  { fundId: "fund-hg-genesis-9", fund: "Hg Genesis 9" },
];

type Report = { snapshotId: string; documentId: string; asOf: string; period: string; publishedAt: string };

const ADVENT_Q2: Report = { snapshotId: "seed-snapshot-1", documentId: "doc-adv-viii-q2", asOf: "2026-06-30", period: "Q2 2026", publishedAt: "2026-09-18T08:31:00.000Z" };
const ADVENT_Q1: Report = { snapshotId: "history-adv-viii-q1-26", documentId: "doc-adv-viii-q2", asOf: "2026-03-31", period: "Q1 2026", publishedAt: "2026-06-15T08:00:00.000Z" };
const EQT_Q1: Report = { snapshotId: "seed-snapshot-3", documentId: "doc-eqt-ix-soi", asOf: "2026-03-31", period: "Q1 2026", publishedAt: "2026-06-12T09:00:00.000Z" };
const HG_Q1: Report = { snapshotId: "seed-snapshot-4", documentId: "doc-hg-genesis-q2", asOf: "2026-03-31", period: "Q1 2026", publishedAt: "2026-06-07T09:00:00.000Z" };

type Figure = {
  report: Report;
  fundId: string;
  metricCode: string;
  value: string | null;
  page: number;
  currency?: string | null;
  unit?: string | null;
  valueString?: string | null;
  actuality?: string;
  isRestated?: boolean;
  isDerived?: boolean;
  derivationFormula?: string;
  investment?: { key: string; name: string; companyId: string; holdingId: string };
};

function fact(figure: Figure): ScorecardFact {
  const { report, investment } = figure;
  const subject = investment ? `${investment.key}-` : "";
  return {
    factId: `demo-fact-${figure.fundId}-${subject}${figure.metricCode}-${report.asOf}-${figure.currency ?? "none"}`,
    snapshotId: report.snapshotId,
    publishedAt: report.publishedAt,
    fundId: figure.fundId,
    level: investment ? "investment" : "fund",
    investmentKey: investment?.key ?? null,
    investment: investment?.name ?? null,
    holdingId: investment?.holdingId ?? null,
    companyId: investment?.companyId ?? null,
    metricCode: figure.metricCode,
    valueNumber: figure.value,
    valueString: figure.valueString ?? null,
    valueRaw: figure.value ?? figure.valueString ?? null,
    currency: figure.currency ?? null,
    unit: figure.unit ?? null,
    asOf: report.asOf,
    period: report.period,
    actuality: figure.actuality ?? "actual",
    scenarioType: "reported",
    isRestated: figure.isRestated ?? false,
    isDerived: figure.isDerived ?? false,
    derivationFormula: figure.derivationFormula ?? null,
    source: { documentId: report.documentId, sourceReferenceId: `demo-source-${figure.fundId}-${subject}${figure.metricCode}-${report.asOf}`, page: figure.page, sheetName: null, cellRange: null },
  };
}

const ABC = { key: "company-abc-corp", name: "ABC Corp", companyId: "company-abc-corp", holdingId: "holding-abc-corp" };
const MERIDIAN = { key: "company-meridian-software", name: "Meridian Software", companyId: "company-meridian-software", holdingId: "holding-meridian-software" };
const ATLAS = { key: "company-atlas-industrial", name: "Atlas Industrial", companyId: "company-atlas-industrial", holdingId: "holding-atlas-industrial" };
const HARBOR = { key: "company-harbor-logistics", name: "Harbor Logistics", companyId: "company-harbor-logistics", holdingId: "holding-harbor-logistics" };
const SPARROW = { key: "company-project-sparrow", name: "Project Sparrow", companyId: "company-project-sparrow", holdingId: "holding-project-sparrow" };
const COBALT = { key: "company-cobalt-networks", name: "Cobalt Networks", companyId: "company-cobalt-networks", holdingId: "holding-cobalt-networks" };
const NORTHWIND = { key: "company-northwind-foods", name: "Northwind Foods", companyId: "company-northwind-foods", holdingId: "holding-northwind-foods" };

const ADV = "fund-advent-viii";
const EQT = "fund-eqt-ix";
const HG = "fund-hg-genesis-9";

const DEMO_FIGURES: Figure[] = [
  // Advent VIII: a full, final Q2 2026 report; the Q1 NAV and TVPI are history and never shown. Net MOIC was last reported for Q1, so its as-of date is older than its neighbours'.
  { report: ADVENT_Q2, fundId: ADV, metricCode: "nav", value: "1958000000.0000000000", currency: "USD", page: 4 },
  { report: ADVENT_Q2, fundId: ADV, metricCode: "tvpi", value: "1.6200000000", page: 4 },
  { report: ADVENT_Q2, fundId: ADV, metricCode: "dpi", value: "0.4800000000", page: 4 },
  { report: ADVENT_Q2, fundId: ADV, metricCode: "rvpi", value: "1.1400000000", page: 4 },
  { report: ADVENT_Q2, fundId: ADV, metricCode: "net_irr", value: "14.2000000000", unit: "percent", page: 5 },
  { report: ADVENT_Q1, fundId: ADV, metricCode: "nav", value: "1903000000.0000000000", currency: "USD", page: 4 },
  { report: ADVENT_Q1, fundId: ADV, metricCode: "tvpi", value: "1.5800000000", page: 4 },
  { report: ADVENT_Q1, fundId: ADV, metricCode: "net_moic", value: "1.5100000000", page: 4 },
  { report: ADVENT_Q2, fundId: ADV, investment: ABC, metricCode: "cost", value: "450000000", currency: "USD", page: 52 },
  { report: ADVENT_Q2, fundId: ADV, investment: ABC, metricCode: "fair_value", value: "702000000", currency: "USD", page: 52 },
  { report: ADVENT_Q1, fundId: ADV, investment: ABC, metricCode: "fair_value", value: "676000000", currency: "USD", page: 52 },
  { report: ADVENT_Q2, fundId: ADV, investment: ABC, metricCode: "gross_moic", value: "1.5600000000", page: 53 },
  { report: ADVENT_Q2, fundId: ADV, investment: ABC, metricCode: "gross_irr", value: "18.4000000000", unit: "percent", page: 53 },
  { report: ADVENT_Q2, fundId: ADV, investment: ABC, metricCode: "ownership_pct", value: "12.5000000000", unit: "percent", page: 53 },
  { report: ADVENT_Q2, fundId: ADV, investment: MERIDIAN, metricCode: "cost", value: "380000000", currency: "USD", page: 54 },
  { report: ADVENT_Q2, fundId: ADV, investment: MERIDIAN, metricCode: "fair_value", value: "620000000", currency: "USD", page: 54 },
  { report: ADVENT_Q2, fundId: ADV, investment: MERIDIAN, metricCode: "gross_moic", value: "1.6300000000", page: 55 },
  { report: ADVENT_Q2, fundId: ADV, investment: MERIDIAN, metricCode: "gross_irr", value: "21.0000000000", unit: "percent", page: 55 },
  { report: ADVENT_Q2, fundId: ADV, investment: MERIDIAN, metricCode: "ownership_pct", value: "8.2000000000", unit: "percent", page: 55 },
  { report: ADVENT_Q2, fundId: ADV, investment: ATLAS, metricCode: "cost", value: "290000000", currency: "USD", page: 56 },
  { report: ADVENT_Q2, fundId: ADV, investment: ATLAS, metricCode: "fair_value", value: "318000000", currency: "USD", page: 56 },
  { report: ADVENT_Q2, fundId: ADV, investment: ATLAS, metricCode: "gross_moic", value: "1.1000000000", page: 57 },
  { report: ADVENT_Q2, fundId: ADV, investment: ATLAS, metricCode: "gross_irr", value: "6.3000000000", unit: "percent", actuality: "preliminary", page: 57 },
  { report: ADVENT_Q2, fundId: ADV, investment: HARBOR, metricCode: "cost", value: "150000000", currency: "USD", page: 58 },
  { report: ADVENT_Q2, fundId: ADV, investment: HARBOR, metricCode: "fair_value", value: "154000000", currency: "USD", isRestated: true, page: 58 },

  // EQT IX: a restated NAV, a preliminary TVPI and an IRR the GP states as a fraction of one. RVPI is not reported; net MOIC is a blank line.
  { report: EQT_Q1, fundId: EQT, metricCode: "nav", value: "1271000000.0000000000", currency: "USD", isRestated: true, page: 3 },
  { report: EQT_Q1, fundId: EQT, metricCode: "tvpi", value: "1.3500000000", actuality: "preliminary", page: 3 },
  { report: EQT_Q1, fundId: EQT, metricCode: "dpi", value: "0.2100000000", page: 3 },
  { report: EQT_Q1, fundId: EQT, metricCode: "net_irr", value: "0.1180000000", unit: "fraction", page: 3 },
  // The report has a net MOIC line with nothing in it: a blank is not a figure, so it stays Not reported (never 0).
  { report: EQT_Q1, fundId: EQT, metricCode: "net_moic", value: null, page: 3 },
  { report: EQT_Q1, fundId: EQT, investment: SPARROW, metricCode: "cost", value: "780000000", currency: "USD", page: 67 },
  { report: EQT_Q1, fundId: EQT, investment: SPARROW, metricCode: "fair_value", value: "1046000000", currency: "USD", page: 67 },
  { report: EQT_Q1, fundId: EQT, investment: SPARROW, metricCode: "gross_moic", value: "1.3400000000", page: 68 },
  { report: EQT_Q1, fundId: EQT, investment: SPARROW, metricCode: "gross_irr", value: "12.9000000000", unit: "percent", page: 68 },
  { report: EQT_Q1, fundId: EQT, investment: SPARROW, metricCode: "ownership_pct", value: "61.4000000000", unit: "percent", page: 68 },
  { report: EQT_Q1, fundId: EQT, investment: COBALT, metricCode: "cost", value: "120000000", currency: "USD", page: 69 },
  { report: EQT_Q1, fundId: EQT, investment: COBALT, metricCode: "fair_value", value: "139000000", currency: "USD", page: 69 },
  { report: EQT_Q1, fundId: EQT, investment: NORTHWIND, metricCode: "fair_value", value: "41000000", currency: "USD", page: 70 },

  // Hg Genesis 9: NAV reported in two currencies (never summed or converted), a derived RVPI and a TVPI the GP printed as "NM".
  { report: HG_Q1, fundId: HG, metricCode: "nav", value: "719", currency: "USD", unit: "millions", page: 2 },
  { report: HG_Q1, fundId: HG, metricCode: "nav", value: "664", currency: "EUR", unit: "millions", page: 2 },
  { report: HG_Q1, fundId: HG, metricCode: "tvpi", value: null, valueString: "NM", page: 2 },
  { report: HG_Q1, fundId: HG, metricCode: "rvpi", value: "0.9300000000", isDerived: true, derivationFormula: "NAV / paid-in capital", page: 2 },
];

/**
 * The demo scorecard payload, narrowed by the filters like the Postgres read is (a fund filter names an entitled demo fund,
 * a period filter keeps the figures stated for that period): Nordic Capital Fund V is entitled but has nothing published yet.
 */
export function demoPerformanceScorecard(filters: ScorecardFilters = {}): ScorecardPayload {
  if (filters.fundId !== undefined && !DEMO_SCORECARD_FUNDS.some((fund) => fund.fundId === filters.fundId)) throw new AuthorizationError("performance_scorecard:fund");
  return filterScorecardPayload({ funds: DEMO_SCORECARD_FUNDS.map((fund) => ({ ...fund })), facts: DEMO_FIGURES.map(fact) }, filters);
}
