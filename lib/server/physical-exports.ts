import { createHash, randomBytes, randomUUID } from "crypto";
import { assertRedistributionAllowed, type ExportManifest, type RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type ExportFormat = ExportManifest["format"];

export type ExportStatus = {
  exportId: string;
  format: ExportFormat;
  state: string;
  createdAt: string;
  completedAt?: string;
  expiresAt?: string;
  checksumSha256?: string;
  manifest: ExportManifest;
  downloadUrl?: string;
  downloadExpiresAt?: string;
};

function jsonIds(values: readonly string[]): string { return JSON.stringify(values); }
function text(row: PostgresRow, key: string, fallback = ""): string {
  const value = row[key];
  return value == null ? fallback : value instanceof Date ? value.toISOString() : String(value);
}
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export async function createPhysicalExport(
  identity: RequestIdentity,
  format: ExportFormat,
  store: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<ExportManifest> {
  assertRedistributionAllowed(identity);
  const fundIds = identity.entitlements.fundIds ?? [];
  const documentIds = identity.entitlements.documentIds ?? [];
  const snapshots = fundIds.length === 0 ? [] : await store.query(`select snapshot_id,schema_version,taxonomy_version
    from corvis_serving.fund_period_snapshots
    where tenant_id=$1 and status='published'
      and fund_id in (select jsonb_array_elements_text($2::jsonb))
    order by published_at desc`, [identity.tenantId, jsonIds(fundIds)]);
  const counts = fundIds.length === 0 || documentIds.length === 0 ? [] : await store.query(`select count(distinct o.observation_id) as row_count
    from corvis_serving.observations o
    join corvis_source.source_reference r
      on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
    where o.tenant_id=$1 and o.review_state='approved'
      and o.fund_id in (select jsonb_array_elements_text($2::jsonb))
      and r.document_id::text in (select jsonb_array_elements_text($3::jsonb))`,
  [identity.tenantId, jsonIds(fundIds), jsonIds(documentIds)]);

  const exportId = randomUUID();
  const generatedAt = new Date().toISOString();
  const base = {
    exportId,
    tenantId: identity.tenantId,
    generatedAt,
    schemaVersion: snapshots.length ? text(snapshots[0]!, "schema_version", "v1") : "v1",
    taxonomyVersion: snapshots.length ? text(snapshots[0]!, "taxonomy_version", "v1") : "v1",
    snapshotIds: snapshots.map((row) => text(row, "snapshot_id")),
    format,
    rowCounts: { observations: Number(counts[0]?.row_count ?? 0), snapshots: snapshots.length },
  };
  const manifest: ExportManifest = { ...base, checksumSha256: sha256(JSON.stringify(base)) };

  await store.execute(`insert into corvis_serving.export_job
      (tenant_id,export_id,workspace_id,auth_method,session_id,requested_by,format,snapshot_ids,state,checksum_sha256,manifest,created_at)
    values ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,array(select jsonb_array_elements_text($8::jsonb)::uuid),'queued',$9,$10::jsonb,now())`,
  [identity.tenantId, exportId, identity.workspaceId, identity.authMethod, identity.sessionId, identity.subject,
    format, JSON.stringify(manifest.snapshotIds), manifest.checksumSha256, JSON.stringify(manifest)]);
  await store.execute(`insert into corvis_control.outbox_event
      (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
    values ($1,gen_random_uuid(),'ExportRequested','export',$2,$3::jsonb,now())`,
  [identity.tenantId, exportId, JSON.stringify({ exportId, format, snapshotIds: manifest.snapshotIds })]);
  return manifest;
}

async function assertCurrentArtifactAccess(
  identity: RequestIdentity,
  snapshotIds: readonly string[],
  store: PostgresSqlApi,
): Promise<void> {
  assertRedistributionAllowed(identity);
  if (snapshotIds.length === 0) return;
  const fundIds = identity.entitlements.fundIds ?? [];
  const documentIds = identity.entitlements.documentIds ?? [];
  if (fundIds.length === 0 || documentIds.length === 0) throw new Error("export_access_denied");
  const rows = await store.query(`with requested_snapshot as (
      select s.snapshot_id,s.fund_id,s.fact_ids
      from corvis_consolidated.fund_period_snapshot s
      where s.tenant_id=$1 and s.status='published'
        and s.snapshot_id::text in (select jsonb_array_elements_text($2::jsonb))
    ), artifact_observation as (
      select distinct rs.fund_id, fact_observation.observation_id
      from requested_snapshot rs
      join corvis_consolidated.consolidated_fact cf
        on cf.tenant_id=$1 and cf.consolidated_fact_id=any(rs.fact_ids)
      cross join lateral unnest(cf.source_observation_ids) as fact_observation(observation_id)
    )
    select
      (select count(*) from requested_snapshot) as snapshot_count,
      count(*) filter (
        where ao.fund_id not in (select jsonb_array_elements_text($3::jsonb))
           or r.document_id is null
           or r.document_id::text not in (select jsonb_array_elements_text($4::jsonb))
      ) as denied_observation_count
    from artifact_observation ao
    left join corvis_facts.observation o
      on o.tenant_id=$1 and o.observation_id=ao.observation_id
    left join corvis_source.source_reference r
      on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id`,
  [identity.tenantId, jsonIds(snapshotIds), jsonIds(fundIds), jsonIds(documentIds)]);
  if (Number(rows[0]?.snapshot_count ?? 0) !== snapshotIds.length || Number(rows[0]?.denied_observation_count ?? 0) > 0) {
    throw new Error("export_access_denied");
  }
}

export async function getPhysicalExportStatus(
  identity: RequestIdentity,
  exportId: string,
  store: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<ExportStatus | null> {
  const rows = await store.query(`select export_id,format,state,manifest,checksum_sha256,created_at,completed_at,expires_at,snapshot_ids
    from corvis_serving.export_job
    where tenant_id=$1 and export_id=$2::uuid and requested_by=$3
    limit 1`, [identity.tenantId, exportId, identity.subject]);
  const row = rows[0];
  if (!row) return null;
  const manifest = row.manifest as ExportManifest;
  const snapshotIds = Array.isArray(row.snapshot_ids) ? row.snapshot_ids.map(String) : manifest.snapshotIds;
  await assertCurrentArtifactAccess(identity, snapshotIds, store);

  const result: ExportStatus = {
    exportId: text(row, "export_id"),
    format: text(row, "format") as ExportFormat,
    state: text(row, "state"),
    createdAt: text(row, "created_at"),
    completedAt: row.completed_at == null ? undefined : text(row, "completed_at"),
    expiresAt: row.expires_at == null ? undefined : text(row, "expires_at"),
    checksumSha256: row.checksum_sha256 == null ? undefined : text(row, "checksum_sha256"),
    manifest,
  };
  if (result.state === "complete" && result.expiresAt && Date.parse(result.expiresAt) > Date.now()) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Math.min(Date.parse(result.expiresAt), Date.now() + 10 * 60_000)).toISOString();
    await store.execute(`insert into corvis_serving.export_download_grant
        (tenant_id,grant_id,export_id,subject,token_sha256,expires_at,created_at)
      values ($1,gen_random_uuid(),$2::uuid,$3,$4,$5::timestamptz,now())`,
    [identity.tenantId, exportId, identity.subject, sha256(token), expiresAt]);
    result.downloadUrl = `/api/v1/exports/${encodeURIComponent(exportId)}/download?grant=${encodeURIComponent(token)}`;
    result.downloadExpiresAt = expiresAt;
  }
  return result;
}

export async function redeemPhysicalExportGrant(
  identity: RequestIdentity,
  exportId: string,
  token: string,
  store: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<{ objectUri: string; format: ExportFormat; checksumSha256: string } | null> {
  if (!token || token.length > 256) return null;
  const rows = await store.query(`select j.object_uri,j.format,j.checksum_sha256,j.snapshot_ids,j.manifest
    from corvis_serving.export_download_grant g
    join corvis_serving.export_job j
      on j.tenant_id=g.tenant_id and j.export_id=g.export_id
    where g.tenant_id=$1 and g.export_id=$2::uuid and g.subject=$3
      and g.token_sha256=$4 and g.expires_at>now()
      and j.requested_by=$3 and j.state='complete' and j.expires_at>now()
    limit 1`, [identity.tenantId, exportId, identity.subject, sha256(token)]);
  const row = rows[0];
  if (!row?.object_uri || !row?.checksum_sha256) return null;
  const manifest = row.manifest as ExportManifest;
  const snapshotIds = Array.isArray(row.snapshot_ids) ? row.snapshot_ids.map(String) : manifest.snapshotIds;
  await assertCurrentArtifactAccess(identity, snapshotIds, store);
  return {
    objectUri: String(row.object_uri),
    format: String(row.format) as ExportFormat,
    checksumSha256: String(row.checksum_sha256),
  };
}

export function exportObjectKey(objectUri: string): string {
  const config = getServerConfig();
  const prefix = `gs://${config.objectStoreBucket ?? ""}/`;
  if (!config.objectStoreBucket || !objectUri.startsWith(prefix)) throw new Error("invalid_export_object_uri");
  const key = objectUri.slice(prefix.length);
  if (!key.startsWith("exports/") || key.includes("..")) throw new Error("invalid_export_object_uri");
  return key;
}
