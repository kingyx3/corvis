import { TENANT_EXPORT_ARCHIVE_NAME, TENANT_EXPORT_MAX_BUILD_ATTEMPTS } from "../../core/tenant-export.ts";
import { computeExportRetryDelayMs, type RandomSource } from "./delivery.ts";
import { getServerConfig } from "./config.ts";
import { assertExportRowLimit, EXPORT_COLUMNS, EXPORT_MAX_ROWS, renderCsv, type ExportCell, type ExportRow } from "./export-renderer.ts";
import { gcs, type GcsControlClient } from "./gcs.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { safeErrorText } from "./processing-error-text.ts";
import { TENANT_ACCESS_AUDIT_FILTER } from "./tenant-admin-self-service.ts";
import { assembleTenantExportBundle, type TenantExportBundle } from "./tenant-export-bundle.ts";
import { countMetric } from "./telemetry.ts";

/**
 * The build of a full tenant export (F10, #266), run by the delivery worker tick (`/api/internal/delivery`) next to the
 * per-user export queue. It claims one approved request at a time (`claim_next_tenant_export_build`, which also
 * reclaims builds abandoned by a crashed worker), gathers the data, assembles the checksum-manifested archive, stores it
 * under the same `exports/` prefix and lifecycle as every other export, and records the artifact with an expiry equal to
 * the export artifact lifetime. Failures retry with the same capped backoff as the per-user queue; a data set over the
 * row cap fails permanently, because retrying cannot help.
 *
 * Contractual data rights decide what goes in (criterion 4): only funds and documents returned by
 * `corvis_control.tenant_export_rights` (migration 084) are exported, and what was left out is reported as counts in the
 * manifest, never listed or silently dropped. Source document files are not part of this release of the export (the
 * archive carries an inventory with their checksums); that is stated in the manifest's `notIncluded`.
 */

export const TENANT_EXPORT_BUILD_LEASE_MINUTES = 10;
const UUID = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";

const INVENTORY_COLUMNS = ["document_id", "display_name", "media_type", "status", "created_at", "size_bytes", "sha256"] as const;
const AUDIT_COLUMNS = ["occurred_at", "actor", "action", "workspace_id", "target_type", "target_id", "outcome", "metadata"] as const;

type ObjectStore = Pick<GcsControlClient, "bucket" | "putObject" | "deleteObject">;
export type TenantExportWorkerDependencies = {
  store?: PostgresSqlApi;
  objectStore?: ObjectStore;
  random?: RandomSource;
  now?: () => number;
};

export function tenantExportObjectKey(tenantId: string, requestId: string, attempt: number): string {
  return `exports/${tenantId}/tenant-export-${requestId}/attempt-${attempt}/${TENANT_EXPORT_ARCHIVE_NAME}`;
}

function cell(value: unknown): ExportCell {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function jsonIds(values: readonly string[]): string { return JSON.stringify(values); }
function unique(values: ReadonlyArray<ExportCell | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

async function loadRights(store: PostgresSqlApi, tenantId: string): Promise<{ fundIds: string[]; documentIds: string[] }> {
  const rows = await store.query(`select resource_type, resource_id from corvis_control.tenant_export_rights($1::uuid)`, [tenantId]);
  const ids = (type: string) => rows.filter((row) => row.resource_type === type).map((row) => String(row.resource_id));
  return { fundIds: ids("fund"), documentIds: ids("document") };
}

/**
 * Approved observations in the latest published version of each redistributable fund's snapshots, whose source document
 * is also redistributable. The same selection as a per-user observation export (`export-delivery.ts`), tenant-wide.
 */
async function loadObservations(store: PostgresSqlApi, tenantId: string, fundIds: readonly string[], documentIds: readonly string[]): Promise<ExportRow[]> {
  if (fundIds.length === 0 || documentIds.length === 0) return [];
  const rows = await store.query(`with latest_snapshot as (
      select s.snapshot_id, s.fact_ids
      from corvis_consolidated.fund_period_snapshot s
      where s.tenant_id = $1::uuid and s.status = 'published'
        and s.fund_id in (select jsonb_array_elements_text($2::jsonb))
        and not exists (select 1 from corvis_consolidated.fund_period_snapshot newer
          where newer.tenant_id = s.tenant_id and newer.snapshot_id = s.snapshot_id and newer.version > s.version)
    ), artifact_observation as (
      select distinct fact_observation.observation_id
      from latest_snapshot rs
      join corvis_consolidated.consolidated_fact cf on cf.tenant_id = $1::uuid and cf.consolidated_fact_id = any(rs.fact_ids)
      cross join lateral unnest(cf.source_observation_ids) as fact_observation(observation_id)
    )
    select o.observation_id::text, o.fund_id, o.company_id::text, o.holding_id::text, o.instrument_id::text,
      o.metric_code, o.value_number, o.value_string, o.currency, o.economic_period, o.report_date, o.review_state,
      o.source_reference_id::text, r.document_id::text, o.version, o.updated_at
    from artifact_observation ao
    join corvis_serving.observations o on o.tenant_id = $1::uuid and o.observation_id = ao.observation_id and o.review_state = 'approved'
    join corvis_source.source_reference r on r.tenant_id = o.tenant_id and r.source_reference_id = o.source_reference_id
    where o.fund_id in (select jsonb_array_elements_text($2::jsonb))
      and r.document_id in (select entitled.id::uuid from jsonb_array_elements_text($3::jsonb) as entitled(id) where entitled.id ~* ${UUID})
    order by o.fund_id, o.report_date, o.metric_code, o.observation_id
    limit ${EXPORT_MAX_ROWS + 1}`, [tenantId, jsonIds(fundIds), jsonIds(documentIds)]);
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

async function loadInventory(store: PostgresSqlApi, tenantId: string, documentIds: readonly string[]): Promise<ExportRow[]> {
  if (documentIds.length === 0) return [];
  const rows = await store.query(`select d.document_id::text as document_id, d.display_name, d.media_type, d.status, d.created_at, v.size_bytes, v.sha256
    from corvis_source.document d
    left join lateral (
      select av.size_bytes, av.sha256 from corvis_source.document_artifact_version av
      where av.tenant_id = d.tenant_id and av.document_id = d.document_id order by av.created_at desc limit 1
    ) v on true
    where d.tenant_id = $1::uuid and d.document_id::text in (select jsonb_array_elements_text($2::jsonb))
    order by d.created_at, d.document_id
    limit ${EXPORT_MAX_ROWS + 1}`, [tenantId, jsonIds(documentIds)]);
  assertExportRowLimit(rows.length);
  return rows.map((row) => Object.fromEntries(INVENTORY_COLUMNS.map((column) => [column, cell(row[column])])));
}

async function loadAccessAudit(store: PostgresSqlApi, tenantId: string): Promise<ExportRow[]> {
  const rows = await store.query(`select occurred_at, actor_subject, action, workspace_id::text as workspace_id, target_type, target_id, outcome, metadata
    from corvis_control.audit_event
    where tenant_id = $1::uuid and ${TENANT_ACCESS_AUDIT_FILTER}
    order by occurred_at, audit_event_id
    limit ${EXPORT_MAX_ROWS + 1}`, [tenantId]);
  assertExportRowLimit(rows.length);
  return rows.map((row) => ({
    occurred_at: cell(row.occurred_at), actor: cell(row.actor_subject), action: cell(row.action), workspace_id: cell(row.workspace_id),
    target_type: cell(row.target_type), target_id: cell(row.target_id), outcome: cell(row.outcome),
    metadata: typeof row.metadata === "string" ? row.metadata : JSON.stringify(row.metadata ?? {}),
  }));
}

/** How many funds and documents the tenant has, against how many the archive covers, so what was left out is a count. */
async function loadCoverage(store: PostgresSqlApi, tenantId: string, fundIds: readonly string[]): Promise<{ documents: number; funds: number; includedFunds: number }> {
  const row = (await store.query(`select
      (select count(*) from corvis_source.document where tenant_id = $1::uuid)::int as documents,
      (select count(distinct fund_id) from corvis_consolidated.fund_period_snapshot where tenant_id = $1::uuid and status = 'published')::int as funds,
      (select count(distinct fund_id) from corvis_consolidated.fund_period_snapshot where tenant_id = $1::uuid and status = 'published'
         and fund_id in (select jsonb_array_elements_text($2::jsonb)))::int as included_funds`, [tenantId, jsonIds(fundIds)]))[0]!;
  return { documents: Number(row.documents), funds: Number(row.funds), includedFunds: Number(row.included_funds) };
}

export type BuiltTenantExport = { bundle: TenantExportBundle; scope: { fundIds: string[]; documentIds: string[] } };

/** Gathers the data the tenant may redistribute and assembles the archive. Throws `ExportRowLimitError` (not retryable) when a file is too large. */
export async function buildTenantExportArtifact(claimed: PostgresRow, store: PostgresSqlApi, now: () => number = Date.now): Promise<BuiltTenantExport> {
  const tenantId = String(claimed.tenant_id);
  const rights = await loadRights(store, tenantId);
  const observations = await loadObservations(store, tenantId, rights.fundIds, rights.documentIds);
  const inventory = await loadInventory(store, tenantId, rights.documentIds);
  const audit = await loadAccessAudit(store, tenantId);
  const coverage = await loadCoverage(store, tenantId, rights.fundIds);
  const documentIds = unique([...inventory.map((row) => row.document_id), ...observations.map((row) => row.document_id)]);
  const includedDocuments = inventory.length;
  const bundle = assembleTenantExportBundle({
    requestId: String(claimed.request_id),
    tenantId,
    generatedAt: new Date(now()).toISOString(),
    requestedBy: String(claimed.requested_by_subject),
    approvedBy: String(claimed.decided_by_subject),
    files: [
      { path: "published-data/observations.csv", description: "Approved observations in published snapshots", rowCount: observations.length, bytes: renderCsv(observations, EXPORT_COLUMNS) },
      { path: "access-audit/access-audit.csv", description: "Access, support, source-connection, data-issue and data-export audit trail", rowCount: audit.length, bytes: renderCsv(audit, AUDIT_COLUMNS) },
      { path: "source-documents/inventory.csv", description: "Source documents with their size and SHA-256 (the files themselves are not included)", rowCount: inventory.length, bytes: renderCsv(inventory, INVENTORY_COLUMNS) },
    ],
    dataRights: {
      basis: "Funds and documents are included only while every effective contractual data right for them allows client visibility and redistribution, and the organization holds a workspace-level redistribution right.",
      funds: { included: coverage.includedFunds, excluded: Math.max(0, coverage.funds - coverage.includedFunds) },
      documents: { included: includedDocuments, excluded: Math.max(0, coverage.documents - includedDocuments) },
    },
    notIncluded: [
      { item: "Source document files", reason: "Not included in this release of the export. The inventory lists each document with its size and SHA-256 so files can be matched when delivered separately." },
    ],
  });
  return { bundle, scope: { fundIds: unique(observations.map((row) => row.fund_id)), documentIds } };
}

/** One tick: builds up to `limit` approved requests. Returns how many completed and how many attempts failed. */
export async function processApprovedTenantExports(limit = 5, dependencies: TenantExportWorkerDependencies = {}): Promise<{ processed: number; failed: number }> {
  const config = getServerConfig();
  const store = dependencies.store ?? postgres(config.postgresDsn);
  const random = dependencies.random ?? Math.random;
  const now = dependencies.now ?? Date.now;
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const claimed = (await store.query(`select * from corvis_control.claim_next_tenant_export_build($1, $2)`, [TENANT_EXPORT_BUILD_LEASE_MINUTES, TENANT_EXPORT_MAX_BUILD_ATTEMPTS]))[0];
    if (!claimed) break;
    const tenantId = String(claimed.tenant_id);
    const requestId = String(claimed.request_id);
    const attempt = Number(claimed.build_attempts);
    const context = { correlationId: `tenant-export:${requestId}`, tenantId };
    const key = tenantExportObjectKey(tenantId, requestId, attempt);
    let objectStore: ObjectStore | undefined;
    try {
      objectStore = dependencies.objectStore ?? gcs();
      const { bundle, scope } = await buildTenantExportArtifact(claimed, store, now);
      await objectStore.putObject(key, bundle.bytes, bundle.contentType);
      const expiresAt = new Date(now() + config.exportArtifactTtlSeconds * 1000).toISOString();
      const manifest = { ...bundle.manifest, artifact: { contentType: bundle.contentType, sizeBytes: bundle.bytes.length, objectKey: key, ...scope } };
      const completed = await store.query(`select request_id from corvis_control.complete_tenant_export_build($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6,$7,$8::jsonb)`,
        [tenantId, requestId, attempt, `gs://${objectStore.bucket}/${key}`, expiresAt, bundle.checksumSha256, bundle.bytes.length, JSON.stringify(manifest)]);
      if (!completed[0]) {
        // The lease was reclaimed and another attempt owns the request: this attempt's object is unreferenced.
        await objectStore.deleteObject(key).catch(() => undefined);
        continue;
      }
      // Objects written by earlier (failed or abandoned) attempts are no longer referenced.
      for (let earlier = 1; earlier < attempt; earlier += 1) await objectStore.deleteObject(tenantExportObjectKey(tenantId, requestId, earlier)).catch(() => undefined);
      countMetric("delivery.tenant_export", 1, context, { outcome: "complete" });
      processed += 1;
    } catch (error) {
      failed += 1;
      // Deterministic failures (the row cap) can never succeed on retry.
      const permanent = (error as { retryable?: unknown } | null)?.retryable === false;
      const nextAttemptAt = new Date(now() + computeExportRetryDelayMs(attempt, random)).toISOString();
      if (objectStore) await objectStore.deleteObject(key).catch(() => undefined);
      await store.query(`select request_id from corvis_control.fail_tenant_export_build($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,$7)`,
        [tenantId, requestId, attempt, safeErrorText(error), permanent, nextAttemptAt, TENANT_EXPORT_MAX_BUILD_ATTEMPTS]);
      countMetric("delivery.tenant_export", 1, context, { outcome: permanent ? "failed" : "retryable" });
    }
  }
  return { processed, failed };
}
