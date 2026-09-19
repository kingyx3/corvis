import { createHash, randomUUID } from "crypto";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import {
  acquisitionKey,
  isFailClosedErrorClass,
  isRetryableErrorClass,
  statusAfterError,
  type AcquisitionDisposition,
  type ConnectorDriver,
  type ConnectorErrorClass,
  type IngestSink,
  type RemoteDocumentRef,
  type RunState,
  type RunTrigger,
  type SecretStore,
  type SourceScope,
} from "./source-connectors.ts";

export type SyncOutcome = {
  runId: string;
  state: RunState;
  discoveredCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  errorClass?: ConnectorErrorClass;
  errorSummary?: string;
};

type ConnectionForSync = {
  sourceConnectionId: string;
  tenantId: string;
  workspaceId: string;
  providerKey: string;
  status: string;
  sourceScope: SourceScope[];
  secretReference: string;
  connectorVersion: string;
  consecutiveFailures: number;
};

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

function jsonArray(value: unknown): SourceScope[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(parsed) ? parsed as SourceScope[] : [];
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function connectorErrorClass(error: unknown): ConnectorErrorClass {
  if (error && typeof error === "object" && "connectorErrorClass" in error) {
    const value = (error as { connectorErrorClass?: unknown }).connectorErrorClass;
    if (typeof value === "string") return value as ConnectorErrorClass;
  }
  return "network";
}

async function loadConnectionForSync(db: PostgresSqlApi, tenantId: string, sourceConnectionId: string): Promise<ConnectionForSync> {
  const rows = await db.query(`select source_connection_id, tenant_id, workspace_id, provider_key, status,
      source_scope, secret_reference, connector_version, consecutive_failures
    from corvis_source.source_connection where tenant_id=$1 and source_connection_id=$2::uuid limit 1`,
  [tenantId, sourceConnectionId]);
  const row = rows[0];
  if (!row) throw new Error("connection_not_found");
  return {
    sourceConnectionId: String(row.source_connection_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    providerKey: String(row.provider_key),
    status: String(row.status),
    sourceScope: jsonArray(row.source_scope),
    secretReference: String(row.secret_reference),
    connectorVersion: String(row.connector_version),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
  };
}

async function recordAcquisition(
  db: PostgresSqlApi,
  input: {
    tenantId: string; sourceConnectionId: string; runId: string; providerKey: string; ref: RemoteDocumentRef;
    contentSha256: string; connectorVersion: string; disposition: AcquisitionDisposition; rejectionReason?: string;
    documentId?: string; documentArtifactVersionId?: string;
  },
): Promise<void> {
  const key = acquisitionKey(input.ref.remoteDocumentId, input.ref.remoteVersion, input.contentSha256);
  await db.execute(`insert into corvis_source.acquired_document
      (tenant_id, source_connection_id, run_id, provider_key, remote_document_id, remote_version, remote_path,
       remote_modified_at, content_sha256, acquisition_key, connector_version, disposition, rejection_reason,
       document_id, document_artifact_version_id)
    values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid,$15::uuid)
    on conflict (tenant_id, source_connection_id, acquisition_key) do nothing`,
  [input.tenantId, input.sourceConnectionId, input.runId, input.providerKey, input.ref.remoteDocumentId,
    input.ref.remoteVersion, input.ref.remotePath, input.ref.remoteModifiedAt ?? null, input.contentSha256, key,
    input.connectorVersion, input.disposition, input.rejectionReason ?? null, input.documentId ?? null,
    input.documentArtifactVersionId ?? null]);
}

async function alreadyAcquired(db: PostgresSqlApi, tenantId: string, sourceConnectionId: string, key: string): Promise<boolean> {
  const rows = await db.query(`select 1 from corvis_source.acquired_document
    where tenant_id=$1 and source_connection_id=$2::uuid and acquisition_key=$3 limit 1`,
  [tenantId, sourceConnectionId, key]);
  return rows.length > 0;
}

/**
 * One discovery-and-acquisition cycle for a connection. Fails closed before
 * even discovering: paused/revoked/pending/suspended connections never
 * reach the driver. A discovery/download error the driver marks
 * non-retryable moves the connection itself out of "active" (reauthorization
 * required, suspended, or — after repeated failures — suspended) rather than
 * being silently retried forever; a per-document rejection never aborts the
 * whole run.
 */
export async function runConnectionSync(
  tenantId: string,
  sourceConnectionId: string,
  trigger: RunTrigger,
  dependencies: {
    db?: PostgresSqlApi;
    secrets: SecretStore;
    drivers: Map<string, ConnectorDriver>;
    ingest: IngestSink;
    maxAttempts?: number;
  },
): Promise<SyncOutcome> {
  const db = dependencies.db ?? controlDb();
  const maxAttempts = dependencies.maxAttempts ?? 5;
  const connection = await loadConnectionForSync(db, tenantId, sourceConnectionId);
  const runId = randomUUID();

  if (connection.status !== "active") {
    await db.execute(`insert into corvis_source.source_connection_run
        (tenant_id, run_id, source_connection_id, trigger, state, attempt, max_attempts, connector_version,
         finished_at, error_class, error_summary)
      values ($1::uuid,$2::uuid,$3::uuid,$4,'refused',1,$5,$6,now(),'permission',$7)`,
    [tenantId, runId, sourceConnectionId, trigger, maxAttempts, connection.connectorVersion, `connection is ${connection.status}`]);
    return { runId, state: "refused", discoveredCount: 0, acceptedCount: 0, duplicateCount: 0, rejectedCount: 0 };
  }

  const driver = dependencies.drivers.get(connection.providerKey);
  if (!driver) throw new Error(`unregistered_provider:${connection.providerKey}`);

  const attempt = connection.consecutiveFailures + 1;
  await db.execute(`insert into corvis_source.source_connection_run
      (tenant_id, run_id, source_connection_id, trigger, state, attempt, max_attempts, connector_version)
    values ($1::uuid,$2::uuid,$3::uuid,$4,'running',$5,$6,$7)`,
  [tenantId, runId, sourceConnectionId, trigger, attempt, maxAttempts, connection.connectorVersion]);

  const counts = { discovered: 0, accepted: 0, duplicate: 0, rejected: 0 };

  try {
    const credential = await dependencies.secrets.read(connection.secretReference);
    const refs = await driver.discover(credential, connection.sourceScope, undefined);
    counts.discovered = refs.length;

    for (const ref of refs) {
      try {
        const download = await driver.download(credential, ref);
        const contentSha256 = createHash("sha256").update(download.bytes).digest("hex");
        const key = acquisitionKey(ref.remoteDocumentId, ref.remoteVersion, contentSha256);

        if (await alreadyAcquired(db, tenantId, sourceConnectionId, key)) {
          counts.duplicate += 1;
          continue;
        }

        const fileName = ref.remotePath.split("/").pop() || ref.remoteDocumentId;
        const result = await dependencies.ingest.ingest({
          tenantId, workspaceId: connection.workspaceId, providerKey: connection.providerKey,
          fileName, bytes: download.bytes, contentType: download.contentType, contentSha256,
        });

        if (result.accepted) {
          counts.accepted += 1;
          await recordAcquisition(db, {
            tenantId, sourceConnectionId, runId, providerKey: connection.providerKey, ref, contentSha256,
            connectorVersion: connection.connectorVersion, disposition: "accepted",
            documentId: result.documentId, documentArtifactVersionId: result.documentArtifactVersionId,
          });
        } else {
          counts.rejected += 1;
          await recordAcquisition(db, {
            tenantId, sourceConnectionId, runId, providerKey: connection.providerKey, ref, contentSha256,
            connectorVersion: connection.connectorVersion, disposition: result.quarantined ? "quarantined" : "rejected",
            rejectionReason: result.reason,
          });
        }
      } catch (error) {
        // A per-document failure is recorded as a rejection and the run continues;
        // it never silently drops the document and never aborts the whole run.
        counts.rejected += 1;
        await recordAcquisition(db, {
          tenantId, sourceConnectionId, runId, providerKey: connection.providerKey, ref,
          contentSha256: createHash("sha256").update(ref.remoteDocumentId).update(ref.remoteVersion).digest("hex"),
          connectorVersion: connection.connectorVersion, disposition: "rejected",
          rejectionReason: error instanceof Error ? error.message : "download_failed",
        });
      }
    }

    await db.execute(`update corvis_source.source_connection_run set
        state='succeeded', discovered_count=$3, accepted_count=$4, duplicate_count=$5, rejected_count=$6, finished_at=now()
      where tenant_id=$1 and run_id=$2::uuid`,
    [tenantId, runId, counts.discovered, counts.accepted, counts.duplicate, counts.rejected]);
    await db.execute(`update corvis_source.source_connection set
        consecutive_failures=0, last_error_class=null, last_success_at=now(), last_attempt_at=now(), updated_at=now()
      where tenant_id=$1 and source_connection_id=$2::uuid`, [tenantId, sourceConnectionId]);

    return { runId, state: "succeeded", discoveredCount: counts.discovered, acceptedCount: counts.accepted, duplicateCount: counts.duplicate, rejectedCount: counts.rejected };
  } catch (error) {
    const errorClass = connectorErrorClass(error);
    const message = error instanceof Error ? error.message : "sync_failed";
    const failClosed = isFailClosedErrorClass(errorClass);
    const retryable = !failClosed && isRetryableErrorClass(errorClass) && attempt < maxAttempts;
    const state: RunState = failClosed ? "refused" : retryable ? "retryable" : "dead_letter";

    await db.execute(`update corvis_source.source_connection_run set
        state=$3, discovered_count=$4, accepted_count=$5, duplicate_count=$6, rejected_count=$7,
        error_class=$8, error_summary=$9, finished_at=now(),
        next_attempt_at=case when $3='retryable' then now() + interval '1 minute' else null end
      where tenant_id=$1 and run_id=$2::uuid`,
    [tenantId, runId, state, counts.discovered, counts.accepted, counts.duplicate, counts.rejected, errorClass, message]);

    const nextConsecutiveFailures = connection.consecutiveFailures + 1;
    const nextStatus = statusAfterError("active", errorClass, nextConsecutiveFailures);
    await db.execute(`update corvis_source.source_connection set
        consecutive_failures=$3, last_error_class=$4, last_attempt_at=now(), status=$5, updated_at=now()
      where tenant_id=$1 and source_connection_id=$2::uuid`,
    [tenantId, sourceConnectionId, nextConsecutiveFailures, errorClass, nextStatus]);

    return { runId, state, discoveredCount: counts.discovered, acceptedCount: counts.accepted, duplicateCount: counts.duplicate, rejectedCount: counts.rejected, errorClass, errorSummary: message };
  }
}

/** A driver throws this to classify a failure explicitly rather than letting it default to "network". */
export class ConnectorError extends Error {
  readonly connectorErrorClass: ConnectorErrorClass;
  constructor(connectorErrorClass: ConnectorErrorClass, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.connectorErrorClass = connectorErrorClass;
  }
}
