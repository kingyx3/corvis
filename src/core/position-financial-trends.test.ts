import assert from "node:assert/strict";
import test from "node:test";
import type { PositionFinancialStatementRow } from "./contracts.ts";
import { financialAsOf, financialDelta, financialTrustLabel, numericFinancialValue } from "./position-financial-trends.ts";

function row(valueNumber: string | null, overrides: Partial<PositionFinancialStatementRow> = {}): PositionFinancialStatementRow {
  return {
    statementId: "statement-1",
    documentId: "document-1",
    fundId: "fund-1",
    holdingId: "holding-1",
    companyId: "company-1",
    statementType: "income_statement",
    statementKey: "statement-key",
    sourceTitle: "Income Statement",
    reportPeriod: "2026-Q2",
    lineId: "line-1",
    lineKey: "revenue",
    semanticLineKey: "revenue",
    sourceLabel: "Revenue",
    metricCode: "revenue",
    lineRole: "detail",
    parentLineKey: null,
    displayOrder: 1,
    depth: 0,
    valueId: valueNumber == null ? null : "value-1",
    valueRaw: valueNumber,
    valueNumber,
    valueString: null,
    valueQualifier: null,
    currency: "USD",
    unit: null,
    reportedMultiplier: null,
    sourcePrecision: null,
    valueNature: "flow",
    periodType: "quarter",
    periodStart: "2026-04-01",
    periodEnd: "2026-06-30",
    asOfDate: "2026-06-30",
    fiscalYear: 2026,
    fiscalQuarter: 2,
    sourceDocumentPeriodEnd: "2026-06-30",
    sourceColumnLabel: "Q2 2026",
    actuality: "actual",
    scenarioType: "reported",
    sourceVersionStatus: "final",
    preliminary: false,
    isRestatement: false,
    isReReportedPriorPeriod: false,
    isDerived: false,
    derivationFormula: null,
    sourceReferenceIds: ["source-1"],
    sourcePage: 2,
    sourceSheet: null,
    ...overrides,
  };
}

test("financialDelta returns absolute and percent movement", () => {
  assert.deepEqual(financialDelta(row("125"), row("100")), { absolute: 25, percent: 25, direction: "up" });
  assert.deepEqual(financialDelta(row("80"), row("100")), { absolute: -20, percent: -20, direction: "down" });
  assert.deepEqual(financialDelta(row("100"), row("100")), { absolute: 0, percent: 0, direction: "flat" });
});

test("financialDelta does not invent a percent change from a zero baseline", () => {
  assert.deepEqual(financialDelta(row("10"), row("0")), { absolute: 10, percent: null, direction: "up" });
  assert.equal(financialDelta(row(null), row("10")), null);
  assert.equal(numericFinancialValue(row("not-a-number")), null);
});

test("trust and as-of labels preserve governed statement metadata", () => {
  assert.equal(financialTrustLabel(row("10")), "Final");
  assert.equal(financialTrustLabel(row("10", { preliminary: true })), "Preliminary");
  assert.equal(financialTrustLabel(row("10", { isRestatement: true })), "Restated");
  assert.equal(financialTrustLabel(row("10", { isDerived: true })), "Derived");
  assert.equal(financialAsOf(row("10")), "2026-06-30");
});
