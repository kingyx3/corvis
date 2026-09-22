import { createHash } from "crypto";
import { assertRedistributionAllowed, type RequestIdentity } from "../../core/enterprise.ts";
import { PostgresMembershipAuthorizationRepository } from "./authorization.ts";
import { getServerConfig } from "./config.ts";
import { renderExport, type ExportRow } from "./export-renderer.ts";
import { gcs, type GcsControlClient } from "./gcs.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

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
  const authorization = await new PostgresMembershipAuthorizationRepository(store).resolve(principal);
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

async function loadArtifactRows(
  identity: RequestIdentity,
  snapshotIds: readonly string[],
  store: PostgresSqlApi,
): Promise<ExportRow[]> {
  if (snapshotIds.length === 0) return [];
  const fundIds = identity.entitlements.fundIds ?? [];
  const documentIds = identity.entitlements.documentIds ?? [];
  if (fundIds.length === 0 || documentIds.length === 0) throw new Error("export_authorization_expired");

  const snapshotCheck = await store.query(`select count(*) as snapshot_count
    from corvis_consolidated.fund_period_snapshot s
    where s.tenant_id=$1 and s.status='published'
      and s.snapshot_id::text in (select jsonb_array_elements_text($2::jsonb))
      and s.fund_id in (select jsonb_array_elements_text($3::jsonb))`,
  [identity.tenantId, jsonIds(snapshotIds), jsonIds(fundIds)]);
  if (Number(snapshotCheck[0]?.snapshot_count ?? 0) !== snapshotIds.length) throw new Error("export_snapshot_authorization_expired");

  const rows = await store.query(`with requested_snapshot as (
      select s.snapshot_id,s.fund_id,s.fact_ids
      from corvis_consolidated.fund_period_snapshot s
      where s.tenant_id=$1 and s.status='published'
        and s.snapshot_id::text in (select jsonb_array_elements_text($2::jsonb))
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
      and r.document_id::text in (select jsonb_array_elements_text($4::jsonb))
    order by o.fund_id,o.report_date,o.metric_code,o.observation_id`,
  [identity.tenantId, jsonIds(snapshotIds), jsonIds(fundIds), jsonIds(documentIds)]);

  return rows.map((row) => ({
    observation_id: cell(row.observation_id),
    fund_id: cell(row.fund_id),
    company_id: cell(row.company_id),
    holding_id: cell(row.holding_id),
    instrument_id: cell(row.instrument_id),
    metric_code: cell(row.metric_code),
    value_number: row.value_number == null ? null : Number(row.value_number),
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

export async function deliverExportArtifact(
  row: QueuedExportRow,
  store: PostgresSqlApi,
  objectStore: Pick<GcsControlClient, "bucket" | "putObject"> = gcs(),
): Promise<{ objectUri: string; checksumSha256: string; expiresAt: string; manifest: unknown }> {
  const identity = await resolveRequestIdentity(row, store);
  assertRedistributionAllowed(identity);
  const snapshotIds = ids(row.snapshot_ids);
  const format = required(row, "format");
  if (format !== "csv" && format !== "xlsx" && format !== "parquet") throw new Error("export_invalid_format");
  const rows = await loadArtifactRows(identity, snapshotIds, store);
  const rendered = renderExport(format, rows);
  const checksumSha256 = createHash("sha256").update(rendered.bytes).digest("hex");
  const exportId = required(row, "export_id");
  const key = `exports/${identity.tenantId}/${exportId}/observations.${rendered.extension}`;
  await objectStore.putObject(key, rendered.bytes, rendered.contentType);
  const ttlSeconds = getServerConfig().exportArtifactTtlSeconds;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const existingManifest = row.manifest && typeof row.manifest === "object" ? row.manifest as Record<string, unknown> : {};
  const manifest = {
    ...existingManifest,
    checksumSha256,
    rowCounts: { ...((existingManifest.rowCounts as Record<string, number> | undefined) ?? {}), observations: rows.length, snapshots: snapshotIds.length },
    artifact: { contentType: rendered.contentType, sizeBytes: rendered.bytes.length, objectKey: key },
  };
  return { objectUri: `gs://${objectStore.bucket}/${key}`, checksumSha256, expiresAt, manifest };
}
