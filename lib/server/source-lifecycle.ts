import type { DocumentFactLink, DocumentLifecycle, DocumentOrigin, DocumentVersion } from "../../core/contracts.ts";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type SourceActivityAcquisition = {
  acquisitionId: string;
  disposition: "accepted" | "duplicate" | "rejected" | "quarantined";
  remotePath: string;
  remoteVersion: string;
  acquiredAt: string;
  documentId?: string;
  reason: string;
};

export type SourceActivityRun = {
  runId: string;
  trigger: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  discoveredCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  startedAt: string;
  finishedAt?: string;
  zeroDiscoveryLongRunning: boolean;
  errorClass?: string;
  acquisitions: SourceActivityAcquisition[];
};

export type SourceActivityConnection = {
  sourceConnectionId: string;
  providerKey: string;
  connectionLabel: string;
  status: string;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  needsAttention: boolean;
  attentionReason?: string;
  runs: SourceActivityRun[];
};

const LONG_RUNNING_ZERO_DISCOVERY_MS = 15 * 60 * 1000;

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }
function text(row: PostgresRow, key: string): string { const value = row[key]; return value == null ? "" : value instanceof Date ? value.toISOString() : String(value); }
function numberValue(row: PostgresRow, key: string): number { const value = Number(row[key] ?? 0); return Number.isFinite(value) ? value : 0; }
function jsonIds(values: string[]): string { return JSON.stringify(values); }
function reviewState(value: string): DocumentFactLink["state"] { const normalized = value.toLowerCase(); return normalized === "approved" ? "Approved" : normalized === "rejected" ? "Rejected" : "Needs review"; }

export function plainAcquisitionReason(disposition: SourceActivityAcquisition["disposition"], rejectionReason?: string): string {
  if (disposition === "accepted") return "Accepted into the normal document processing lifecycle.";
  if (disposition === "duplicate") return "Already acquired unchanged; no duplicate document was created.";
  if (disposition === "quarantined") return "Held by source-file security or validation controls and not released to processing.";
  const normalized = (rejectionReason ?? "").toLowerCase();
  if (normalized.includes("download")) return "The provider document could not be downloaded.";
  if (normalized.includes("validation")) return "The document did not pass source validation.";
  return "The document was rejected before entering the processing lifecycle.";
}

export function isLongRunningZeroDiscovery(state: string, discoveredCount: number, startedAt: string, now = new Date()): boolean {
  if (state !== "running" || discoveredCount !== 0) return false;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && now.getTime() - started >= LONG_RUNNING_ZERO_DISCOVERY_MS;
}

function connectionAttention(status: string, failures: number): string | undefined {
  if (status === "reauthorization_required") return "Connection authorization must be renewed before acquisition can continue.";
  if (status === "suspended") return "Connection is suspended and needs administrator attention.";
  if (failures >= 3) return `Connection has failed ${failures} consecutive times.`;
  return undefined;
}

export async function listDocumentLifecycles(identity: RequestIdentity, db: PostgresSqlApi = controlDb()): Promise<DocumentLifecycle[]> {
  const documentIds = identity.entitlements.documentIds ?? [];
  if (documentIds.length === 0) return [];
  const documentJson = jsonIds(documentIds);

  const [origins, sourceVersions, artifactVersions, factRows] = await Promise.all([
    db.query(`select d.document_id, d.created_by, d.created_at,
        a.acquisition_id, a.source_connection_id, a.run_id, a.provider_key, a.remote_document_id,
        a.remote_version, a.remote_path, a.acquired_at, c.connection_label
      from corvis_source.document d
      left join lateral (
        select ad.* from corvis_source.acquired_document ad
        where ad.tenant_id=d.tenant_id and ad.document_id=d.document_id and ad.disposition='accepted'
        order by ad.acquired_at desc limit 1
      ) a on true
      left join corvis_source.source_connection c
        on c.tenant_id=d.tenant_id and c.source_connection_id=a.source_connection_id
      where d.tenant_id=$1::uuid
        and d.document_id::text in (select jsonb_array_elements_text($2::jsonb))`, [identity.tenantId, documentJson]),
    db.query(`with current_origin as (
        select distinct ad.document_id as current_document_id, ad.source_connection_id, ad.remote_document_id
        from corvis_source.acquired_document ad
        where ad.tenant_id=$1::uuid
          and ad.document_id::text in (select jsonb_array_elements_text($2::jsonb))
          and ad.disposition='accepted'
      )
      select co.current_document_id, h.acquisition_id, h.document_id, h.document_artifact_version_id,
             h.remote_version, h.acquired_at, h.disposition
      from current_origin co
      join corvis_source.acquired_document h
        on h.tenant_id=$1::uuid and h.source_connection_id=co.source_connection_id
       and h.remote_document_id=co.remote_document_id
      order by co.current_document_id, h.acquired_at desc`, [identity.tenantId, documentJson]),
    db.query(`select document_id, document_artifact_version_id, ingestion_id, created_at
      from corvis_source.document_artifact_version
      where tenant_id=$1::uuid
        and document_id::text in (select jsonb_array_elements_text($2::jsonb))
      order by document_id, created_at desc`, [identity.tenantId, documentJson]),
    (identity.entitlements.fundIds ?? []).length === 0 ? Promise.resolve([]) : db.query(`select r.document_id, o.observation_id, o.source_reference_id,
             coalesce(o.company_name, o.company_id, 'Unknown company') as company_name,
             o.metric_code, coalesce(o.economic_period, o.report_date::text, '') as period,
             o.review_state
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
      where o.tenant_id=$1::uuid
        and r.document_id::text in (select jsonb_array_elements_text($2::jsonb))
        and o.fund_id in (select jsonb_array_elements_text($3::jsonb))
      order by r.document_id, o.updated_at desc`, [identity.tenantId, documentJson, jsonIds(identity.entitlements.fundIds ?? [])]),
  ]);

  const versionsByDocument = new Map<string, DocumentVersion[]>();
  for (const row of sourceVersions) {
    const currentDocumentId = text(row, "current_document_id");
    const disposition = text(row, "disposition") as DocumentVersion["disposition"];
    const version: DocumentVersion = {
      versionKey: text(row, "acquisition_id"), kind: "source_version", label: text(row, "remote_version") || "Source version",
      occurredAt: text(row, "acquired_at"), documentId: text(row, "document_id") || undefined,
      artifactVersionId: text(row, "document_artifact_version_id") || undefined, disposition,
      current: text(row, "document_id") === currentDocumentId && disposition === "accepted",
    };
    versionsByDocument.set(currentDocumentId, [...(versionsByDocument.get(currentDocumentId) ?? []), version]);
  }
  for (const row of artifactVersions) {
    const documentId = text(row, "document_id");
    if (versionsByDocument.has(documentId)) continue;
    const rows = versionsByDocument.get(documentId) ?? [];
    rows.push({
      versionKey: text(row, "document_artifact_version_id"), kind: "artifact_version",
      label: text(row, "ingestion_id") || "Uploaded artifact", occurredAt: text(row, "created_at"),
      documentId, artifactVersionId: text(row, "document_artifact_version_id"), current: rows.length === 0,
    });
    versionsByDocument.set(documentId, rows);
  }

  const factsByDocument = new Map<string, DocumentFactLink[]>();
  for (const row of factRows) {
    const documentId = text(row, "document_id");
    const fact: DocumentFactLink = {
      observationId: text(row, "observation_id"), sourceReferenceId: text(row, "source_reference_id"),
      company: text(row, "company_name") || "Unknown company", metric: text(row, "metric_code"),
      period: text(row, "period"), state: reviewState(text(row, "review_state")),
    };
    factsByDocument.set(documentId, [...(factsByDocument.get(documentId) ?? []), fact]);
  }

  return origins.map((row) => {
    const documentId = text(row, "document_id");
    const acquisitionId = text(row, "acquisition_id");
    const origin: DocumentOrigin = acquisitionId ? {
      kind: "connector", providerKey: text(row, "provider_key"), connectionLabel: text(row, "connection_label") || text(row, "provider_key"),
      sourceConnectionId: text(row, "source_connection_id"), runId: text(row, "run_id"), acquisitionId,
      acquiredAt: text(row, "acquired_at"), remotePath: text(row, "remote_path"),
      remoteDocumentId: text(row, "remote_document_id"), remoteVersion: text(row, "remote_version"),
    } : { kind: "upload", actor: text(row, "created_by") || "Unknown uploader", occurredAt: text(row, "created_at") };
    return { documentId, origin, versions: versionsByDocument.get(documentId) ?? [], facts: factsByDocument.get(documentId) ?? [] };
  });
}

export async function listSourceActivity(identity: RequestIdentity, db: PostgresSqlApi = controlDb(), now = new Date()): Promise<SourceActivityConnection[]> {
  const connections = await db.query(`select source_connection_id, provider_key, connection_label, status,
      consecutive_failures, last_success_at, last_attempt_at
    from corvis_source.source_connection
    where tenant_id=$1::uuid and workspace_id=$2::uuid
    order by created_at desc`, [identity.tenantId, identity.workspaceId]);
  if (connections.length === 0) return [];

  const [runs, acquisitions] = await Promise.all([
    db.query(`select r.* from corvis_source.source_connection_run r
      join corvis_source.source_connection c
        on c.tenant_id=r.tenant_id and c.source_connection_id=r.source_connection_id
      where r.tenant_id=$1::uuid and c.workspace_id=$2::uuid
      order by r.started_at desc`, [identity.tenantId, identity.workspaceId]),
    db.query(`select a.* from corvis_source.acquired_document a
      join corvis_source.source_connection c
        on c.tenant_id=a.tenant_id and c.source_connection_id=a.source_connection_id
      where a.tenant_id=$1::uuid and c.workspace_id=$2::uuid
      order by a.acquired_at desc`, [identity.tenantId, identity.workspaceId]),
  ]);

  const acquisitionsByRun = new Map<string, SourceActivityAcquisition[]>();
  for (const row of acquisitions) {
    const runId = text(row, "run_id");
    const disposition = text(row, "disposition") as SourceActivityAcquisition["disposition"];
    const acquisition: SourceActivityAcquisition = {
      acquisitionId: text(row, "acquisition_id"), disposition, remotePath: text(row, "remote_path"),
      remoteVersion: text(row, "remote_version"), acquiredAt: text(row, "acquired_at"),
      documentId: text(row, "document_id") || undefined,
      reason: plainAcquisitionReason(disposition, text(row, "rejection_reason")),
    };
    acquisitionsByRun.set(runId, [...(acquisitionsByRun.get(runId) ?? []), acquisition]);
  }

  const runsByConnection = new Map<string, SourceActivityRun[]>();
  for (const row of runs) {
    const runId = text(row, "run_id");
    const startedAt = text(row, "started_at");
    const discoveredCount = numberValue(row, "discovered_count");
    const run: SourceActivityRun = {
      runId, trigger: text(row, "trigger"), state: text(row, "state"), attempt: numberValue(row, "attempt"), maxAttempts: numberValue(row, "max_attempts"),
      discoveredCount, acceptedCount: numberValue(row, "accepted_count"), duplicateCount: numberValue(row, "duplicate_count"), rejectedCount: numberValue(row, "rejected_count"),
      startedAt, finishedAt: text(row, "finished_at") || undefined,
      zeroDiscoveryLongRunning: isLongRunningZeroDiscovery(text(row, "state"), discoveredCount, startedAt, now),
      errorClass: text(row, "error_class") || undefined, acquisitions: acquisitionsByRun.get(runId) ?? [],
    };
    const sourceConnectionId = text(row, "source_connection_id");
    runsByConnection.set(sourceConnectionId, [...(runsByConnection.get(sourceConnectionId) ?? []), run]);
  }

  return connections.map((row) => {
    const sourceConnectionId = text(row, "source_connection_id");
    const status = text(row, "status");
    const consecutiveFailures = numberValue(row, "consecutive_failures");
    const attentionReason = connectionAttention(status, consecutiveFailures);
    return {
      sourceConnectionId, providerKey: text(row, "provider_key"), connectionLabel: text(row, "connection_label"), status,
      consecutiveFailures, lastSuccessAt: text(row, "last_success_at") || undefined, lastAttemptAt: text(row, "last_attempt_at") || undefined,
      needsAttention: Boolean(attentionReason), attentionReason, runs: runsByConnection.get(sourceConnectionId) ?? [],
    };
  });
}
