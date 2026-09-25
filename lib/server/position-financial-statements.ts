import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type StatementPeriodicity = "reported" | "quarterly" | "annual";

export type PositionFinancialStatementRow = {
  statementId: string;
  documentId: string;
  fundId: string;
  holdingId: string;
  companyId: string;
  statementType: string;
  statementKey: string;
  sourceTitle: string | null;
  reportPeriod: string;
  lineId: string;
  lineKey: string;
  semanticLineKey: string;
  sourceLabel: string;
  metricCode: string | null;
  lineRole: string;
  parentLineKey: string | null;
  displayOrder: number;
  depth: number;
  valueId: string | null;
  valueRaw: string | null;
  valueNumber: string | null;
  valueString: string | null;
  valueQualifier: string | null;
  currency: string | null;
  unit: string | null;
  reportedMultiplier: string | null;
  sourcePrecision: string | null;
  valueNature: string | null;
  periodType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  asOfDate: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  sourceDocumentPeriodEnd: string | null;
  sourceColumnLabel: string | null;
  actuality: string | null;
  scenarioType: string | null;
  sourceVersionStatus: string | null;
  preliminary: boolean;
  isRestatement: boolean;
  isReReportedPriorPeriod: boolean;
  isDerived: boolean;
  derivationFormula: string | null;
  sourceReferenceIds: string[];
  sourcePage: number | null;
  sourceSheet: string | null;
};

export type PositionFinancialStatementQuery = {
  portfolioId?: string;
  fundId?: string;
  holdingId?: string;
  companyId?: string;
  statementType?: string;
  periodicity?: StatementPeriodicity;
  limit?: number;
};

function text(row: PostgresRow, key: string): string { return row[key] == null ? "" : String(row[key]); }
function nullableText(row: PostgresRow, key: string): string | null { return row[key] == null ? null : String(row[key]); }
function nullableNumber(row: PostgresRow, key: string): number | null {
  if (row[key] == null) return null;
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}
function bool(row: PostgresRow, key: string): boolean { return row[key] === true || row[key] === "true"; }
function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    if (value.startsWith("{") && value.endsWith("}")) return value.slice(1,-1).split(",").filter(Boolean);
    try { const parsed = JSON.parse(value) as unknown; if (Array.isArray(parsed)) return parsed.map(String); } catch { /* pg arrays are not JSON */ }
  }
  return [];
}
function allowedJson(values: string[] | undefined): string { return JSON.stringify(values ?? []); }

function mapRow(row: PostgresRow): PositionFinancialStatementRow {
  return {
    statementId: text(row,"statement_id"), documentId: text(row,"document_id"), fundId: text(row,"fund_id"),
    holdingId: text(row,"holding_id"), companyId: text(row,"company_id"), statementType: text(row,"statement_type"),
    statementKey: text(row,"statement_key"), sourceTitle: nullableText(row,"source_title"), reportPeriod: text(row,"report_period"),
    lineId: text(row,"line_id"), lineKey: text(row,"line_key"), semanticLineKey: text(row,"semantic_line_key"),
    sourceLabel: text(row,"source_label"), metricCode: nullableText(row,"metric_code"), lineRole: text(row,"line_role"),
    parentLineKey: nullableText(row,"parent_line_key"), displayOrder: nullableNumber(row,"display_order") ?? 0, depth: nullableNumber(row,"depth") ?? 0,
    valueId: nullableText(row,"value_id"), valueRaw: nullableText(row,"value_raw"), valueNumber: nullableText(row,"value_number"),
    valueString: nullableText(row,"value_string"), valueQualifier: nullableText(row,"value_qualifier"), currency: nullableText(row,"currency"),
    unit: nullableText(row,"unit"), reportedMultiplier: nullableText(row,"reported_multiplier"), sourcePrecision: nullableText(row,"source_precision"),
    valueNature: nullableText(row,"value_nature"), periodType: nullableText(row,"period_type"), periodStart: nullableText(row,"period_start"),
    periodEnd: nullableText(row,"period_end"), asOfDate: nullableText(row,"as_of_date"), fiscalYear: nullableNumber(row,"fiscal_year"),
    fiscalQuarter: nullableNumber(row,"fiscal_quarter"), sourceDocumentPeriodEnd: nullableText(row,"source_document_period_end"),
    sourceColumnLabel: nullableText(row,"source_column_label"), actuality: nullableText(row,"actuality"), scenarioType: nullableText(row,"scenario_type"),
    sourceVersionStatus: nullableText(row,"source_version_status"), preliminary: bool(row,"preliminary"), isRestatement: bool(row,"is_restatement"),
    isReReportedPriorPeriod: bool(row,"is_re_reported_prior_period"), isDerived: bool(row,"is_derived"), derivationFormula: nullableText(row,"derivation_formula"),
    sourceReferenceIds: stringArray(row.source_reference_ids), sourcePage: nullableNumber(row,"page_number"), sourceSheet: nullableText(row,"sheet_name"),
  };
}

function latestDisclosure(a: PositionFinancialStatementRow, b: PositionFinancialStatementRow): PositionFinancialStatementRow {
  const aDate = a.sourceDocumentPeriodEnd ?? a.periodEnd ?? "";
  const bDate = b.sourceDocumentPeriodEnd ?? b.periodEnd ?? "";
  if (aDate !== bDate) return aDate > bDate ? a : b;
  if (a.preliminary !== b.preliminary) return a.preliminary ? b : a;
  if (a.isRestatement !== b.isRestatement) return a.isRestatement ? a : b;
  return a.reportPeriod >= b.reportPeriod ? a : b;
}

function annualGroupKey(row: PositionFinancialStatementRow): string {
  return [row.fundId,row.holdingId,row.companyId,row.semanticLineKey,row.metricCode ?? "",row.fiscalYear ?? "",
    row.currency ?? "",row.unit ?? "",row.reportedMultiplier ?? "",row.actuality ?? "",row.scenarioType ?? ""].join("\u001f");
}

/**
 * Annual mode never invents values from YTD/LTM columns. It prefers a reported
 * annual disclosure. Only when one is absent may it sum four explicit fiscal
 * quarters for the same semantic line, and only for compatible flow values.
 */
export function rowsForPeriodicity(rows: PositionFinancialStatementRow[], periodicity: StatementPeriodicity): PositionFinancialStatementRow[] {
  if (periodicity === "reported") return rows;
  const structural = rows.filter((row) => row.valueId === null);
  if (periodicity === "quarterly") return [...structural, ...rows.filter((row) => row.valueId !== null && row.periodType === "quarter")];

  const reportedAnnual = rows.filter((row) => row.valueId !== null && (row.periodType === "annual" || row.periodType === "annual_embedded_in_quarterly"));
  const reportedKeys = new Set(reportedAnnual.filter((row) => row.fiscalYear != null).map(annualGroupKey));
  const quarterGroups = new Map<string, Map<number, PositionFinancialStatementRow>>();
  for (const row of rows) {
    if (row.valueId === null || row.periodType !== "quarter" || row.valueNature !== "flow" || row.valueNumber == null || row.fiscalYear == null || row.fiscalQuarter == null) continue;
    const key = annualGroupKey(row);
    if (reportedKeys.has(key)) continue;
    const quarters = quarterGroups.get(key) ?? new Map<number, PositionFinancialStatementRow>();
    const current = quarters.get(row.fiscalQuarter);
    quarters.set(row.fiscalQuarter, current ? latestDisclosure(current,row) : row);
    quarterGroups.set(key, quarters);
  }

  const derived: PositionFinancialStatementRow[] = [];
  for (const [key, quarters] of quarterGroups) {
    if (![1,2,3,4].every((quarter) => quarters.has(quarter))) continue;
    const values = [1,2,3,4].map((quarter) => quarters.get(quarter)!);
    const numbers = values.map((row) => Number(row.valueNumber));
    if (numbers.some((value) => !Number.isFinite(value))) continue;
    const base = values[3];
    const references = [...new Set(values.flatMap((row) => row.sourceReferenceIds))];
    derived.push({
      ...base,
      statementId: `derived:${key}`,
      statementKey: `derived-annual:${base.semanticLineKey}:${base.fiscalYear}`,
      sourceTitle: "Derived from four compatible reported quarters",
      reportPeriod: `FY${base.fiscalYear}`,
      valueId: `derived:${key}`,
      valueRaw: null,
      valueNumber: numbers.reduce((sum,value) => sum + value,0).toString(),
      valueString: null,
      valueQualifier: "exact",
      periodType: "annual",
      periodStart: values[0].periodStart,
      periodEnd: values[3].periodEnd,
      asOfDate: values[3].periodEnd,
      fiscalQuarter: null,
      sourceDocumentPeriodEnd: values.map((row) => row.sourceDocumentPeriodEnd ?? "").sort().at(-1) || null,
      sourceColumnLabel: `FY${base.fiscalYear}`,
      preliminary: values.some((row) => row.preliminary),
      isRestatement: false,
      isReReportedPriorPeriod: false,
      isDerived: true,
      derivationFormula: "sum of four non-overlapping compatible fiscal-quarter flow disclosures",
      sourceReferenceIds: references,
    });
  }
  return [...structural, ...reportedAnnual, ...derived];
}

export class PostgresPositionFinancialStatementRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  async list(identity: RequestIdentity, query: PositionFinancialStatementQuery = {}): Promise<PositionFinancialStatementRow[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    const documentIds = identity.entitlements.documentIds ?? [];
    if (fundIds.length === 0 || documentIds.length === 0) return [];
    if (query.fundId && !fundIds.includes(query.fundId)) return [];

    const parameters: PostgresPrimitive[] = [identity.tenantId,allowedJson(fundIds),allowedJson(documentIds),identity.workspaceId];
    const predicates: string[] = [
      "v.tenant_id=$1::uuid",
      "v.fund_id in (select jsonb_array_elements_text($2::jsonb))",
      "v.document_id::text in (select jsonb_array_elements_text($3::jsonb))",
      `exists (
        select 1
        from corvis_consolidated.reconciliation_run rr
        join corvis_consolidated.fund_period_snapshot ps
          on ps.tenant_id=rr.tenant_id
         and ps.snapshot_id=rr.snapshot_id
         and ps.version>=rr.snapshot_version
        where rr.tenant_id=v.tenant_id
          and rr.canonicalization_run_id=v.canonicalization_run_id
          and rr.document_id=v.document_id
          and rr.fund_id=v.fund_id
          and rr.report_period=v.report_period
          and rr.status='ready'
          and ps.status='published'
          and not exists (
            select 1 from corvis_consolidated.fund_period_snapshot newer
            where newer.tenant_id=ps.tenant_id
              and newer.snapshot_id=ps.snapshot_id
              and newer.version>ps.version
          )
      )`,
    ];
    if (query.portfolioId) {
      parameters.push(query.portfolioId);
      predicates.push(`exists (
        select 1
        from corvis_serving.client_portfolio_holding_attribution pa
        where pa.tenant_id=v.tenant_id
          and pa.workspace_id::text=$4
          and pa.portfolio_id::text=$${parameters.length}
          and pa.owning_fund_id=v.fund_id
          and pa.holding_id::text=v.holding_id
          and pa.root_fund_id in (select jsonb_array_elements_text($2::jsonb))
          and pa.owning_fund_id in (select jsonb_array_elements_text($2::jsonb))
      )`);
    }
    const add = (column: string, value: string | undefined) => {
      if (!value) return;
      parameters.push(value); predicates.push(`${column}=$${parameters.length}`);
    };
    add("v.fund_id",query.fundId);
    add("v.holding_id",query.holdingId);
    add("v.company_id",query.companyId);
    add("v.statement_type",query.statementType ?? "income_statement");
    const limit = Math.max(1,Math.min(query.limit ?? 5000,5000));
    parameters.push(limit);
    const rows = await this.db.query(`select v.*
      from corvis_serving.position_financial_statement_values v
      where ${predicates.join("\n        and ")}
      order by v.company_id,v.holding_id,v.source_document_period_end nulls last,v.report_period,
               v.display_order,v.line_id,v.period_end nulls last,v.value_id nulls first
      limit $${parameters.length}`, parameters);
    return rowsForPeriodicity(rows.map(mapRow),query.periodicity ?? "reported");
  }
}

let singleton: PostgresPositionFinancialStatementRepository | undefined;
export function positionFinancialStatements(dsn = getServerConfig().postgresDsn): PostgresPositionFinancialStatementRepository {
  if (!singleton) singleton = new PostgresPositionFinancialStatementRepository(postgres(dsn));
  return singleton;
}
