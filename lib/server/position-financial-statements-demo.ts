import { rowsForPeriodicity, type PositionFinancialStatementQuery, type PositionFinancialStatementRow, type StatementPeriodicity } from "./position-financial-statements.ts";

/**
 * Companion to adapters/demo/catalog.ts's fund/company names and ids — the
 * ObservationRecord.companyId/fundId values demo data carries (see
 * adapters/demo/catalog.ts) match these exactly, so a drill-through from a
 * demo Review observation lands on the same position here.
 */
export const DEMO_POSITIONS = [
  { fundId: "fund-advent-viii", holdingId: "holding-abc-corp", companyId: "company-abc-corp", documentId: "doc-adv-viii-q2" },
  { fundId: "fund-nordic-v", holdingId: "holding-northstar-health", companyId: "company-northstar-health", documentId: "doc-nordic-v-q2" },
  { fundId: "fund-eqt-ix", holdingId: "holding-project-sparrow", companyId: "company-project-sparrow", documentId: "doc-eqt-ix-soi" },
] as const;

type Quarter = { fiscalQuarter: 1 | 2 | 3; periodEnd: string; revenue: number; ebitda: number; preliminary?: boolean; isRestatement?: boolean };

const QUARTERS: Quarter[] = [
  { fiscalQuarter: 1, periodEnd: "2026-03-31", revenue: 780, ebitda: 108 },
  { fiscalQuarter: 2, periodEnd: "2026-06-30", revenue: 842, ebitda: 125, isRestatement: true },
  { fiscalQuarter: 3, periodEnd: "2026-09-30", revenue: 905, ebitda: 131, preliminary: true },
];

function line(
  position: (typeof DEMO_POSITIONS)[number],
  quarter: Quarter,
  metric: "revenue" | "ebitda",
  label: string,
  value: number,
  displayOrder: number,
): PositionFinancialStatementRow {
  const fiscalYear = 2026;
  const periodStart = `${quarter.periodEnd.slice(0, 4)}-${String((quarter.fiscalQuarter - 1) * 3 + 1).padStart(2, "0")}-01`;
  return {
    statementId: `demo-${position.companyId}-${metric}-q${quarter.fiscalQuarter}`,
    documentId: position.documentId,
    fundId: position.fundId,
    holdingId: position.holdingId,
    companyId: position.companyId,
    statementType: "income_statement",
    statementKey: "demo-income-statement",
    sourceTitle: "Portfolio Company Summary",
    reportPeriod: `Q${quarter.fiscalQuarter} 2026`,
    lineId: `${metric}-line`,
    lineKey: metric,
    semanticLineKey: metric,
    sourceLabel: label,
    metricCode: metric,
    lineRole: "detail",
    parentLineKey: null,
    displayOrder,
    depth: 0,
    valueId: `demo-${position.companyId}-${metric}-q${quarter.fiscalQuarter}-value`,
    valueRaw: String(value),
    valueNumber: String(value),
    valueString: null,
    valueQualifier: "exact",
    currency: "USD",
    unit: "millions",
    reportedMultiplier: null,
    sourcePrecision: null,
    valueNature: "flow",
    periodType: "quarter",
    periodStart,
    periodEnd: quarter.periodEnd,
    asOfDate: quarter.periodEnd,
    fiscalYear,
    fiscalQuarter: quarter.fiscalQuarter,
    sourceDocumentPeriodEnd: quarter.periodEnd,
    sourceColumnLabel: `Q${quarter.fiscalQuarter} 2026`,
    actuality: "actual",
    scenarioType: null,
    sourceVersionStatus: quarter.preliminary ? "preliminary" : "final",
    preliminary: quarter.preliminary ?? false,
    isRestatement: quarter.isRestatement ?? false,
    isReReportedPriorPeriod: false,
    isDerived: false,
    derivationFormula: null,
    sourceReferenceIds: [`demo-source-${position.companyId}-q${quarter.fiscalQuarter}`],
    sourcePage: 18,
    sourceSheet: null,
  };
}

function allDemoRows(): PositionFinancialStatementRow[] {
  return DEMO_POSITIONS.flatMap((position) =>
    QUARTERS.flatMap((quarter) => [
      line(position, quarter, "revenue", "Revenue", quarter.revenue, 1),
      line(position, quarter, "ebitda", "Adjusted EBITDA", quarter.ebitda, 2),
    ]),
  );
}

export function demoPositionFinancialStatements(query: PositionFinancialStatementQuery = {}): PositionFinancialStatementRow[] {
  let rows = allDemoRows();
  if (query.fundId) rows = rows.filter((row) => row.fundId === query.fundId);
  if (query.holdingId) rows = rows.filter((row) => row.holdingId === query.holdingId);
  if (query.companyId) rows = rows.filter((row) => row.companyId === query.companyId);
  const periodicity: StatementPeriodicity = query.periodicity ?? "reported";
  rows = rowsForPeriodicity(rows, periodicity);
  const limit = Math.max(1, Math.min(query.limit ?? 5000, 5000));
  return rows.slice(0, limit);
}
