import { createHash } from "crypto";
import type { PositionFinancialStatementRow } from "../../../shared/domain/contracts.ts";
import type { ExportScope, PositionFinancialsExportScope } from "../domain/delivery.ts";
import { assertRedistributionAllowed, type RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { SCORECARD_EXPORT_COLUMNS } from "../../analytics/domain/performance-scorecard.ts";
import { PostgresMembershipAuthorizationRepository } from "../../identity-access/server/authorization.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import { assertExportRowLimit, EXPORT_COLUMNS, EXPORT_MAX_ROWS, POSITION_EXPORT_COLUMNS, renderExport, type ExportRow } from "./export-renderer.ts";
import { gcs, type GcsControlClient } from "../../../platform/gcp/gcs.ts";
import { loadScorecardExportRows, performanceScorecardScope } from "../../analytics/server/performance-scorecard-export.ts";
import { rowsForPeriodicity } from "../../analytics/server/position-financial-statements.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";

export type QueuedExportRow = PostgresRow & {
  tenant_id?: unknown;
  export_id?: unknown;
  workspace_id?: unknown;
  auth_method?: unknown;
  session_id?: unknown;
  requested_by?: unknown;
  format?: unknown;
  snapshot_ids?: unknown;
  manifest?: unknown;
};

function jsonIds(values: readonly string[]): string { return JSON.stringify(values); }
function required(row: QueuedExportRow, key: string): string {
  const value = row[key];
  if (value == null || String(value).trim() === "") throw new Error(`export_missing_${key}`);
  return String(value);
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}
function cell(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
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
    try { const parsed = JSON.parse(value) as unknown; if (Array.isArray(parsed)) return parsed.map(String); } catch { /* PostgreSQL arrays are not JSON. */ }
  }
  return [];
}
function uniqueStringColumn(rows: readonly ExportRow[], key: string): string[] {
  return [...new Set(rows.map((row) => row[key]).filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}
function positionScope(value: unknown): PositionFinancialsExportScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("positionFinancials" in value)) return undefined;
  const position = (value as { positionFinancials?: unknown }).positionFinancials;
  if (!position || typeof position !== "object" || Array.isArray(position)) return undefined;
  const p = position as Record<string, unknown>;
  if (typeof p.fundId !== "string" || typeof p.holdingId !== "string" || typeof p.companyId !== "string") return undefined;
  if (p.periodicity !== "reported" && p.periodicity !== "quarterly" && p.periodicity !== "annual") return undefined;
  return { positionFinancials: { fundId: p.fundId, holdingId: p.holdingId, companyId: p.companyId, periodicity: p.periodicity, ...(typeof p.portfolioId === "string" ? { portfolioId: p.portfolioId } : {}) } };
}

async function resolveRequestIdentity(row: QueuedExportRow, store: PostgresSqlApi): Promise<RequestIdentity> {
  const authMethod = required(row, "auth_method");
  if (authMethod !== "oidc" && authMethod !== "saml" && authMethod !== "service_account") {
    throw new Error("export_invalid_auth_method");
  }
  const principal = {
    tenantId: required(row, "tenant_id"),
    workspaceId: required(row, "workspace_id"),
    subject: required(row, "requested_by"),
    authMethod,
    sessionId: required(row, "session_id"),
  } as const;
  const authorization = await new PostgresMembershipAuthorizationRepository(store).resolve(principal, { applySessionPolicy: false });
  if (!authorization) throw new Error("export_authorization_expired");
  return {
    ...principal,
    roles: authorization.roles,
    entitlements: {
      workspaceIds: authorization.workspaceIds,
      fundIds: authorization.fundIds,
      documentIds: authorization.documentIds,
      sourceDocumentIds: authorization.sourceDocumentIds,
      sourceDocumentAccessAllowed: authorization.sourceDocumentIds.length > 0,
      internalAnalyticsAllowed: authorization.internalAnalyticsAllowed,
      modelTrainingAllowed: authorization.modelTrainingAllowed,
      redistributionAllowed: authorization.redistributionAllowed,
    },
  };
}

/** Exported so the defensive entitlement guards can be tested directly; deliverExportArtifact always passes a fully resolved identity. */
export async function loadArtifactRows(
  identity: RequestIdentity,
  snapshotIds: readonly string[],
  store: PostgresSqlApi,
): Promise<ExportRow[]> {
  if (snapshotIds.length === 0) return [];
  const fundIds = identity.entitlements.fundIds ?? [];
  const documentIds = identity.entitlements.documentIds ?? [];
  if (fundIds.length === 0 || documentIds.length === 0) throw new Error("export_authorization_expired");

  const snapshotCheck = await store.query(`select count(distinct s.snapshot_id) as snapshot_count
    from corvis_consolidated.fund_period_snapshot s
    where s.tenant_id=$1 and s.status='published'
      and not exists (select 1 from corvis_consolidated.fund_period_snapshot newer where newer.tenant_id=s.tenant_id and newer.snapshot_id=s.snapshot_id and newer.version>s.version)
      and s.snapshot_id in (select entitled.id::uuid from jsonb_array_elements_text($2::jsonb) as entitled(id) where entitled.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      and s.fund_id in (select jsonb_array_elements_text($3::jsonb))`,
  [identity.tenantId, jsonIds(snapshotIds), jsonIds(fundIds)]);
  if (Number(snapshotCheck[0]?.snapshot_count ?? 0) !== snapshotIds.length) throw new Error("export_snapshot_authorization_expired");

  const rows = await store.query(`with requested_snapshot as (
      select s.snapshot_id,s.fund_id,s.fact_ids
      from corvis_consolidated.fund_period_snapshot s
      where s.tenant_id=$1 and s.status='published'
        and not exists (select 1 from corvis_consolidated.fund_period_snapshot newer where newer.tenant_id=s.tenant_id and newer.snapshot_id=s.snapshot_id and newer.version>s.version)
        and s.snapshot_id in (select entitled.id::uuid from jsonb_array_elements_text($2::jsonb) as entitled(id) where entitled.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    ), artifact_observation as (
      select distinct fact_observation.observation_id
      from requested_snapshot rs
      join corvis_consolidated.consolidated_fact cf
        on cf.tenant_id=$1 and cf.consolidated_fact_id=any(rs.fact_ids)
      cross join lateral unnest(cf.source_observation_ids) as fact_observation(observation_id)
    )
    select o.observation_id::text,o.fund_id,o.company_id::text,o.holding_id::text,o.instrument_id::text,
      o.metric_code,o.value_number,o.value_string,o.currency,o.economic_period,o.report_date,o.review_state,
      o.source_reference_id::text,r.document_id::text,o.version,o.updated_at
    from artifact_observation ao
    join corvis_serving.observations o
      on o.tenant_id=$1 and o.observation_id=ao.observation_id and o.review_state='approved'
    join corvis_source.source_reference r
      on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
    where o.fund_id in (select jsonb_array_elements_text($3::jsonb))
      and r.document_id in (select entitled.id::uuid from jsonb_array_elements_text($4::jsonb) as entitled(id) where entitled.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    order by o.fund_id,o.report_date,o.metric_code,o.observation_id
    limit ${EXPORT_MAX_ROWS + 1}`,
  [identity.tenantId, jsonIds(snapshotIds), jsonIds(fundIds), jsonIds(documentIds)]);
  // One row past the cap proves the export is too large without ever loading it all.
  assertExportRowLimit(rows.length);

  return rows.map((row) => ({
    observation_id: cell(row.observation_id),
    fund_id: cell(row.fund_id),
    company_id: cell(row.company_id),
    holding_id: cell(row.holding_id),
    instrument_id: cell(row.instrument_id),
    metric_code: cell(row.metric_code),
    // numeric(38,10) stays a decimal string end to end; Number() would lose digits beyond ~15.
    value_number: row.value_number == null ? null : String(row.value_number),
    value_string: cell(row.value_string),
    currency: cell(row.currency),
    economic_period: cell(row.economic_period),
    report_date: cell(row.report_date),
    review_state: cell(row.review_state),
    source_reference_id: cell(row.source_reference_id),
    document_id: cell(row.document_id),
    version: row.version == null ? null : Number(row.version),
    updated_at: cell(row.updated_at),
  }));
}

function mapPositionRow(row: PostgresRow): PositionFinancialStatementRow {
  return {
    statementId: String(row.statement_id ?? ""), documentId: String(row.document_id ?? ""), fundId: String(row.fund_id ?? ""),
    holdingId: String(row.holding_id ?? ""), companyId: String(row.company_id ?? ""), statementType: String(row.statement_type ?? ""),
    statementKey: String(row.statement_key ?? ""), sourceTitle: nullableText(row,"source_title"), reportPeriod: String(row.report_period ?? ""),
    lineId: String(row.line_id ?? ""), lineKey: String(row.line_key ?? ""), semanticLineKey: String(row.semantic_line_key ?? ""),
    sourceLabel: String(row.source_label ?? ""), metricCode: nullableText(row,"metric_code"), lineRole: String(row.line_role ?? ""),
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

export async function loadPositionFinancialRows(
  identity: RequestIdentity,
  snapshotIds: readonly string[],
  scope: PositionFinancialsExportScope,
  store: PostgresSqlApi,
): Promise<ExportRow[]> {
  const fundIds = identity.entitlements.fundIds ?? [];
  const documentIds = identity.entitlements.documentIds ?? [];
  const p = scope.positionFinancials;
  if (!fundIds.includes(p.fundId) || documentIds.length === 0 || snapshotIds.length === 0) throw new Error("export_authorization_expired");
  const parameters: import("../../../platform/database/postgres.ts").PostgresPrimitive[] = [identity.tenantId,jsonIds(fundIds),jsonIds(documentIds),jsonIds(snapshotIds),identity.workspaceId,p.fundId,p.holdingId,p.companyId];
  let portfolioPredicate = "";
  if (p.portfolioId) {
    parameters.push(p.portfolioId);
    portfolioPredicate = `and exists (
      select 1 from corvis_serving.client_portfolio_holding_attribution pa
      where pa.tenant_id=v.tenant_id and pa.workspace_id::text=$5 and pa.portfolio_id::text=$9
        and pa.owning_fund_id=v.fund_id and pa.holding_id::text=v.holding_id::text
        and pa.root_fund_id in (select jsonb_array_elements_text($2::jsonb))
        and pa.owning_fund_id in (select jsonb_array_elements_text($2::jsonb))
    )`;
  }
  const raw = await store.query(`select v.*
    from corvis_serving.position_financial_statement_values v
    where v.tenant_id=$1::uuid
      and v.fund_id in (select jsonb_array_elements_text($2::jsonb))
      and v.document_id in (select entitled.id::uuid from jsonb_array_elements_text($3::jsonb) as entitled(id) where entitled.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      and v.fund_id=$6 and v.holding_id::text=$7 and v.company_id::text=$8
      ${portfolioPredicate}
      and exists (
        select 1
        from corvis_consolidated.reconciliation_run rr
        join corvis_consolidated.fund_period_snapshot ps
          on ps.tenant_id=rr.tenant_id and ps.snapshot_id=rr.snapshot_id and ps.version>=rr.snapshot_version
        where rr.tenant_id=v.tenant_id
          and rr.canonicalization_run_id=v.canonicalization_run_id
          and rr.document_id=v.document_id
          and rr.fund_id=v.fund_id
          and rr.report_period=v.report_period
          and rr.status='ready'
          and ps.status='published'
          and ps.snapshot_id in (select entitled.id::uuid from jsonb_array_elements_text($4::jsonb) as entitled(id) where entitled.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          and not exists (
            select 1 from corvis_consolidated.fund_period_snapshot newer
            where newer.tenant_id=ps.tenant_id and newer.snapshot_id=ps.snapshot_id and newer.version>ps.version
          )
      )
    order by v.source_document_period_end nulls last,v.report_period,v.display_order,v.line_id,v.period_end nulls last,v.value_id nulls first
    limit ${EXPORT_MAX_ROWS + 1}`, parameters);
  assertExportRowLimit(raw.length);
  const rows = rowsForPeriodicity(raw.map(mapPositionRow), p.periodicity);
  return rows.map((position) => ({
    statement_id: position.statementId,
    document_id: position.documentId,
    fund_id: position.fundId,
    holding_id: position.holdingId,
    company_id: position.companyId,
    statement_type: position.statementType,
    report_period: position.reportPeriod,
    source_label: position.sourceLabel,
    metric_code: position.metricCode,
    line_role: position.lineRole,
    display_order: position.displayOrder,
    depth: position.depth,
    value_raw: position.valueRaw,
    value_number: position.valueNumber,
    value_string: position.valueString,
    currency: position.currency,
    unit: position.unit,
    period_type: position.periodType,
    period_start: position.periodStart,
    period_end: position.periodEnd,
    as_of_date: position.asOfDate,
    fiscal_year: position.fiscalYear,
    fiscal_quarter: position.fiscalQuarter,
    source_column_label: position.sourceColumnLabel,
    preliminary: position.preliminary,
    is_restatement: position.isRestatement,
    is_derived: position.isDerived,
    derivation_formula: position.derivationFormula,
    source_reference_ids: JSON.stringify(position.sourceReferenceIds),
  }));
}

/**
 * Deterministic key for one delivery attempt. It contains no random component:
 * the same (export, attempt) always maps to the same object, and the attempt
 * number isolates a stale worker (reclaimed after a crash) from the attempt that
 * replaced it. Failed attempts delete their own object and a successful attempt
 * deletes its predecessors, so retries never leave orphans behind.
 */
export function exportAttemptObjectKey(input: { tenantId: string; exportId: string; attempt: number; scoped: boolean; scorecard?: boolean; extension: string }): string {
  const basename = input.scorecard ? "performance-scorecard" : input.scoped ? "position-financials" : "observations";
  return `exports/${input.tenantId}/${input.exportId}/attempt-${input.attempt}/${basename}.${input.extension}`;
}

function attemptKeys(row: QueuedExportRow, attempts: readonly number[]): string[] {
  const format = String(row.format ?? "");
  if (format !== "csv" && format !== "xlsx" && format !== "parquet") return [];
  const manifest = row.manifest && typeof row.manifest === "object" ? row.manifest as Record<string, unknown> : {};
  const scoped = positionScope(manifest.scope as ExportScope | undefined) !== undefined;
  const scorecard = performanceScorecardScope(manifest.scope) !== undefined;
  return attempts.map((attempt) => exportAttemptObjectKey({ tenantId: String(row.tenant_id), exportId: String(row.export_id), attempt, scoped, scorecard, extension: format }));
}

/** Best-effort removal of the objects the given attempts may have written. Never throws for a missing object. */
export async function deleteExportAttemptArtifacts(
  row: QueuedExportRow,
  attempts: number | readonly number[],
  objectStore: Pick<GcsControlClient, "deleteObject"> = gcs(),
): Promise<void> {
  const list = typeof attempts === "number" ? [attempts] : attempts;
  for (const key of attemptKeys(row, list)) await objectStore.deleteObject(key);
}

export async function deliverExportArtifact(
  row: QueuedExportRow,
  store: PostgresSqlApi,
  objectStore: Pick<GcsControlClient, "bucket" | "putObject"> = gcs(),
  options: { attempt?: number } = {},
): Promise<{ objectUri: string; checksumSha256: string; expiresAt: string; manifest: unknown }> {
  const identity = await resolveRequestIdentity(row, store);
  assertRedistributionAllowed(identity);
  const snapshotIds = ids(row.snapshot_ids);
  const format = required(row, "format");
  if (format !== "csv" && format !== "xlsx" && format !== "parquet") throw new Error("export_invalid_format");
  const existingManifest = row.manifest && typeof row.manifest === "object" ? row.manifest as Record<string, unknown> : {};
  const scopedPosition = positionScope(existingManifest.scope as ExportScope | undefined);
  const scopedScorecard = performanceScorecardScope(existingManifest.scope);
  const rows = scopedPosition
    ? await loadPositionFinancialRows(identity, snapshotIds, scopedPosition, store)
    : scopedScorecard
      ? await loadScorecardExportRows(identity, snapshotIds, store, scopedScorecard)
      : await loadArtifactRows(identity, snapshotIds, store);
  const rendered = renderExport(format, rows, scopedPosition ? POSITION_EXPORT_COLUMNS : scopedScorecard ? SCORECARD_EXPORT_COLUMNS : EXPORT_COLUMNS);
  const checksumSha256 = createHash("sha256").update(rendered.bytes).digest("hex");
  const exportId = required(row, "export_id");
  const key = exportAttemptObjectKey({ tenantId: identity.tenantId, exportId, attempt: options.attempt ?? 1, scoped: scopedPosition !== undefined, scorecard: scopedScorecard !== undefined, extension: rendered.extension });
  await objectStore.putObject(key, rendered.bytes, rendered.contentType);
  const ttlSeconds = getServerConfig().exportArtifactTtlSeconds;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const countKey = scopedPosition ? "positionFinancials" : scopedScorecard ? "performanceScorecard" : "observations";
  const manifest = {
    ...existingManifest,
    checksumSha256,
    rowCounts: { ...((existingManifest.rowCounts as Record<string, number> | undefined) ?? {}), [countKey]: rows.length, snapshots: snapshotIds.length },
    artifact: {
      contentType: rendered.contentType,
      sizeBytes: rendered.bytes.length,
      objectKey: key,
      fundIds: uniqueStringColumn(rows, "fund_id"),
      documentIds: uniqueStringColumn(rows, "document_id"),
    },
  };
  return { objectUri: `gs://${objectStore.bucket}/${key}`, checksumSha256, expiresAt, manifest };
}
