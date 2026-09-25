import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresSqlApi } from "./postgres.ts";
import { PostgresPositionFinancialStatementRepository, rowsForPeriodicity, type PositionFinancialStatementRow } from "./position-financial-statements.ts";

function quarter(quarter: number, value: string, overrides: Partial<PositionFinancialStatementRow> = {}): PositionFinancialStatementRow {
  const startMonth = String((quarter - 1) * 3 + 1).padStart(2,"0");
  const endMonth = String(quarter * 3).padStart(2,"0");
  const endDay = quarter === 1 || quarter === 4 ? "31" : "30";
  return {
    statementId: `s${quarter}`, documentId: `d${quarter}`, fundId: "fund-a", holdingId: "holding-a", companyId: "company-a",
    statementType: "income_statement", statementKey: `income-${quarter}`, sourceTitle: "Income statement", reportPeriod: `2026Q${quarter}`,
    lineId: `line-${quarter}`, lineKey: "revenue", semanticLineKey: "revenue", sourceLabel: "Revenue", metricCode: "revenue",
    lineRole: "line_item", parentLineKey: null, displayOrder: 10, depth: 0, valueId: `v${quarter}`, valueRaw: value,
    valueNumber: value, valueString: null, valueQualifier: "exact", currency: "USD", unit: "currency", reportedMultiplier: "1",
    sourcePrecision: "1", valueNature: "flow", periodType: "quarter", periodStart: `2026-${startMonth}-01`,
    periodEnd: `2026-${endMonth}-${endDay}`, asOfDate: `2026-${endMonth}-${endDay}`, fiscalYear: 2026, fiscalQuarter: quarter,
    sourceDocumentPeriodEnd: `2026-${endMonth}-${endDay}`, sourceColumnLabel: `Q${quarter} 2026`, actuality: "actual", scenarioType: "reported",
    sourceVersionStatus: "final", preliminary: false, isRestatement: false, isReReportedPriorPeriod: false, isDerived: false,
    derivationFormula: null, sourceReferenceIds: [`r${quarter}`], sourcePage: quarter, sourceSheet: null,
    ...overrides,
  };
}

test("annual mode safely derives a full year from four compatible quarterly flows", () => {
  const rows = rowsForPeriodicity([quarter(1,"10"),quarter(2,"20"),quarter(3,"30"),quarter(4,"40")],"annual");
  assert.equal(rows.length,1);
  assert.equal(rows[0]?.valueNumber,"100");
  assert.equal(rows[0]?.periodType,"annual");
  assert.equal(rows[0]?.isDerived,true);
  assert.equal(rows[0]?.sourceReferenceIds.length,4);
});

test("annual mode never sums stock values or incomplete quarters", () => {
  const stock = [1,2,3,4].map((q) => quarter(q,String(q),{ valueNature: "stock" }));
  assert.equal(rowsForPeriodicity(stock,"annual").length,0);
  assert.equal(rowsForPeriodicity([quarter(1,"1"),quarter(2,"2"),quarter(4,"4")],"annual").length,0);
});

test("reported annual disclosures take precedence over derived annual values", () => {
  const quarters = [1,2,3,4].map((q) => quarter(q,"10"));
  const reported = quarter(4,"41",{ valueId: "annual", periodType: "annual", fiscalQuarter: null, periodStart: "2026-01-01", periodEnd: "2026-12-31" });
  const rows = rowsForPeriodicity([...quarters,reported],"annual");
  assert.equal(rows.length,1);
  assert.equal(rows[0]?.valueId,"annual");
  assert.equal(rows[0]?.valueNumber,"41");
  assert.equal(rows[0]?.isDerived,false);
});

test("quarterly mode includes only explicit quarter values and statement structure", () => {
  const structural = quarter(1,"1",{ valueId: null, valueNumber: null, valueRaw: null, lineRole: "header", periodType: null });
  const annual = quarter(4,"40",{ periodType: "annual", fiscalQuarter: null });
  const rows = rowsForPeriodicity([structural,quarter(1,"10"),annual],"quarterly");
  assert.equal(rows.length,2);
  assert.equal(rows.some((row) => row.lineRole === "header"),true);
  assert.equal(rows.some((row) => row.periodType === "quarter"),true);
});

test("serving binds a reviewed statement to its exact reconciliation and current published snapshot lineage", async () => {
  let capturedSql = "";
  let capturedParameters: unknown[] = [];
  const db: PostgresSqlApi = {
    async query(sql, parameters = []) { capturedSql = sql; capturedParameters = parameters; return []; },
    async execute() {},
    async health() { return true; },
  };
  const identity: RequestIdentity = {
    subject: "analyst@example.test",
    tenantId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "workspace-a",
    roles: ["analyst"],
    entitlements: {
      workspaceIds: ["workspace-a"],
      fundIds: ["fund-a"],
      documentIds: ["22222222-2222-4222-8222-222222222222"],
      sourceDocumentAccessAllowed: false,
    },
    authMethod: "oidc",
    sessionId: "session-a",
  };

  await new PostgresPositionFinancialStatementRepository(db).list(identity,{ fundId: "fund-a", companyId: "company-a" });

  assert.match(capturedSql,/from corvis_consolidated\.reconciliation_run rr/);
  assert.match(capturedSql,/rr\.canonicalization_run_id=v\.canonicalization_run_id/);
  assert.match(capturedSql,/rr\.document_id=v\.document_id/);
  assert.match(capturedSql,/ps\.snapshot_id=rr\.snapshot_id/);
  assert.match(capturedSql,/ps\.status='published'/);
  assert.match(capturedSql,/newer\.version>ps\.version/);
  assert.deepEqual(capturedParameters.slice(0,3),[
    identity.tenantId,
    JSON.stringify(["fund-a"]),
    JSON.stringify(["22222222-2222-4222-8222-222222222222"]),
  ]);
});
