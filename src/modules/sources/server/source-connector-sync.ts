import { createHash, randomUUID } from "crypto";
import { getServerConfig } from "../../../platform/config/config.ts";
import { bestEffortNotification, enqueueForRoleAudience, sourceAttentionAudienceRoles } from "../../notifications/server/notifications.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { nextRunAt, scheduleAfter } from "./source-sync-schedule.ts";
import {
  acquisitionKey,
  isFailClosedErrorClass,
  isRetryableErrorClass,
  statusAfterError,
  type AcquisitionDisposition,
  type ConnectionStatus,
  type ConnectorDriver,
  type ConnectorErrorClass,
  type IngestSink,
  type RemoteDocumentRef,
  type RunState,
  type RunTrigger,
  type SecretPayload,
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
  credentialType: string;
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

export function connectorErrorClass(error: unknown): ConnectorErrorClass {
  if (error && typeof error === "object" && "connectorErrorClass" in error) {
    const value = (error as { connectorErrorClass?: unknown }).connectorErrorClass;
    if (typeof value === "string") return value as ConnectorErrorClass;
  }
  return "network";
}

/** The path as segments: `.` and empty segments are dropped, and a `..` makes it unusable. */
function pathSegments(path: string): string[] | undefined {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? undefined : segments;
}

/**
 * Whether a discovered document is inside the scope the administrator confirmed. When every scope entry carries a path,
 * a document must sit under one of them (whole segments, so `/Fund III` does not admit `/Fund III-other`). A scope that
 * names folders only by label cannot be checked by path, so the driver's own scoping is all there is. This is a second
 * check behind the driver, never a replacement for it.
 */
export function withinConfirmedScope(remotePath: string, scope: SourceScope[]): boolean {
  if (scope.length === 0 || scope.some((entry) => !entry.path)) return true;
  const target = pathSegments(remotePath);
  if (!target) return false;
  return scope.some((entry) => {
    const root = pathSegments(entry.path!);
    return root !== undefined && root.length <= target.length && root.every((segment, index) => segment === target[index]);
  });
}

export type LedgerEntry = {
  ref: RemoteDocumentRef;
  contentSha256: string;
  disposition: AcquisitionDisposition;
  rejectionReason?: string;
  documentId?: string;
  documentArtifactVersionId?: string;
};

/** Where acquisitions are remembered, so a document version already ingested is recognised on every later run. */
export interface AcquisitionLedger {
  alreadyAcquired(acquisitionKey: string): Promise<boolean>;
  record(entry: LedgerEntry): Promise<void>;
}

export type CollectionCounts = { discovered: number; accepted: number; duplicate: number; rejected: number };

/** The hash recorded for a document that was never downloaded (so it has no content hash). */
function identityHash(ref: RemoteDocumentRef): string {
  return createHash("sha256").update(ref.remoteDocumentId).update(ref.remoteVersion).digest("hex");
}

/**
 * The discovery-and-acquisition loop shared by the Postgres sync and the demo store: discover within the confirmed
 * scope, download, skip what the ledger already holds (idempotent per remote id, version and content), and hand the
 * rest to the ingest sink. `counts` is filled as it goes so a run that fails part-way still reports what it did.
 */
export async function collectDocuments(
  input: {
    connection: { sourceConnectionId: string; tenantId: string; workspaceId: string; providerKey: string; sourceScope: SourceScope[] };
    driver: ConnectorDriver;
    credential: SecretPayload;
    ledger: AcquisitionLedger;
    ingest: IngestSink;
  },
  counts: CollectionCounts,
): Promise<void> {
  const { connection, driver, credential, ledger } = input;
  const refs = await driver.discover(credential, connection.sourceScope, undefined);
  counts.discovered = refs.length;

  for (const ref of refs) {
    if (!withinConfirmedScope(ref.remotePath, connection.sourceScope)) {
      // Never downloaded: whatever the driver listed outside the confirmed scope is not read.
      counts.rejected += 1;
      await ledger.record({ ref, contentSha256: identityHash(ref), disposition: "rejected", rejectionReason: "outside_confirmed_scope" });
      continue;
    }
    try {
      const download = await driver.download(credential, ref);
      const contentSha256 = createHash("sha256").update(download.bytes).digest("hex");
      const key = acquisitionKey(ref.remoteDocumentId, ref.remoteVersion, contentSha256);

      if (await ledger.alreadyAcquired(key)) {
        counts.duplicate += 1;
        await ledger.record({ ref, contentSha256, disposition: "duplicate", rejectionReason: "already_acquired" });
        continue;
      }

      const fileName = ref.remotePath.split("/").pop() || ref.remoteDocumentId;
      const result = await input.ingest.ingest({
        tenantId: connection.tenantId, workspaceId: connection.workspaceId, providerKey: connection.providerKey,
        fileName, bytes: download.bytes, contentType: download.contentType, contentSha256,
        sourceConnectionId: connection.sourceConnectionId, acquisitionKey: key,
      });

      if (result.accepted) {
        counts.accepted += 1;
        await ledger.record({ ref, contentSha256, disposition: "accepted", documentId: result.documentId, documentArtifactVersionId: result.documentArtifactVersionId });
      } else {
        counts.rejected += 1;
        await ledger.record({ ref, contentSha256, disposition: result.quarantined ? "quarantined" : "rejected", rejectionReason: result.reason });
      }
    } catch (error) {
      // An auth/permission-class failure is about the connection's credential, not this document: it fails the
      // whole run closed (and moves the connection out of "active") instead of looking like one rejected file.
      if (isFailClosedErrorClass(connectorErrorClass(error))) throw error;
      // Any other per-document failure is recorded as a rejection and the run continues;
      // it never silently drops the document and never aborts the whole run.
      counts.rejected += 1;
      await ledger.record({ ref, contentSha256: identityHash(ref), disposition: "rejected", rejectionReason: error instanceof Error ? error.message : "download_failed" });
    }
  }
}

export type RunFailure = { errorClass: ConnectorErrorClass; message: string; state: RunState; nextStatus: ConnectionStatus };

/** What a failed run is recorded as and what it does to the connection: fail-closed classes stop it, transient ones retry until `maxAttempts`. */
export function classifyRunFailure(error: unknown, attempt: number, maxAttempts: number, consecutiveFailures: number): RunFailure {
  const errorClass = connectorErrorClass(error);
  const failClosed = isFailClosedErrorClass(errorClass);
  const retryable = !failClosed && isRetryableErrorClass(errorClass) && attempt < maxAttempts;
  return {
    errorClass,
    message: error instanceof Error ? error.message : "sync_failed",
    state: failClosed ? "refused" : retryable ? "retryable" : "dead_letter",
    nextStatus: statusAfterError("active", errorClass, consecutiveFailures + 1),
  };
}

async function loadConnectionForSync(db: PostgresSqlApi, tenantId: string, sourceConnectionId: string): Promise<ConnectionForSync> {
  const rows = await db.query(`select source_connection_id, tenant_id, workspace_id, provider_key, credential_type, status,
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
    credentialType: String(row.credential_type ?? ""),
    status: String(row.status),
    sourceScope: jsonArray(row.source_scope),
    secretReference: String(row.secret_reference),
    connectorVersion: String(row.connector_version),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
  };
}

function postgresLedger(db: PostgresSqlApi, run: { tenantId: string; sourceConnectionId: string; runId: string; providerKey: string; connectorVersion: string }): AcquisitionLedger {
  return {
    async alreadyAcquired(key) {
      const rows = await db.query(`select 1 from corvis_source.acquired_document
        where tenant_id=$1 and source_connection_id=$2::uuid and acquisition_key=$3 and disposition='accepted' limit 1`,
      [run.tenantId, run.sourceConnectionId, key]);
      return rows.length > 0;
    },
    async record(entry) {
      const key = acquisitionKey(entry.ref.remoteDocumentId, entry.ref.remoteVersion, entry.contentSha256);
      await db.execute(`insert into corvis_source.acquired_document
          (tenant_id, source_connection_id, run_id, provider_key, remote_document_id, remote_version, remote_path,
           remote_modified_at, content_sha256, acquisition_key, connector_version, disposition, rejection_reason,
           document_id, document_artifact_version_id)
        values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid,$15::uuid)
        on conflict (tenant_id, source_connection_id, run_id, acquisition_key, disposition) do nothing`,
      [run.tenantId, run.sourceConnectionId, run.runId, run.providerKey, entry.ref.remoteDocumentId,
        entry.ref.remoteVersion, entry.ref.remotePath, entry.ref.remoteModifiedAt ?? null, entry.contentSha256, key,
        run.connectorVersion, entry.disposition, entry.rejectionReason ?? null, entry.documentId ?? null,
        entry.documentArtifactVersionId ?? null]);
    },
  };
}

/**
 * One discovery-and-acquisition cycle for a connection. Fails closed before
 * even discovering: paused/revoked/pending/suspended connections never
 * reach the driver. A discovery/download error the driver marks
 * non-retryable moves the connection itself out of "active" (reauthorization
 * required, suspended, or — after repeated failures — suspended) rather than
 * being silently retried forever; a per-document rejection never aborts the
 * whole run. The scheduler (source-sync-scheduler.ts) is the caller for scheduled runs; however a run ends, the
 * connection's next run time is set from its outcome (the interval after a success, a bounded backoff after a failure,
 * nothing while the connection is not active).
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
    now?: () => number;
    /**
     * Turns the stored credential into one safe to use now: the seam for OAuth token refresh
     * (`resolveConnectionCredential` in source-connector-governance.ts, which needs the scheduler's system identity).
     * A refusal it throws with a `connectorErrorClass` (an expired OAuth credential is `reauthorization`) fails the run
     * closed like any credential the provider rejects.
     */
    resolveCredential?: (connection: { sourceConnectionId: string; workspaceId: string; providerKey: string; credentialType: string; secretReference: string }, credential: SecretPayload) => Promise<SecretPayload>;
  },
): Promise<SyncOutcome> {
  const db = dependencies.db ?? controlDb();
  const maxAttempts = dependencies.maxAttempts ?? 5;
  const now = dependencies.now ?? Date.now;
  const connection = await loadConnectionForSync(db, tenantId, sourceConnectionId);
  const runId = randomUUID();

  if (connection.status !== "active") {
    // Refused before anything was read. The error class stays empty: the reason is the connection's state, not a provider fault.
    await db.execute(`insert into corvis_source.source_connection_run
        (tenant_id, run_id, source_connection_id, trigger, state, attempt, max_attempts, connector_version,
         finished_at, error_class, error_summary)
      values ($1::uuid,$2::uuid,$3::uuid,$4,'refused',1,$5,$6,now(),null,$7)`,
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

  const counts: CollectionCounts = { discovered: 0, accepted: 0, duplicate: 0, rejected: 0 };

  try {
    const stored = await dependencies.secrets.read(connection.secretReference);
    const credential = dependencies.resolveCredential ? await dependencies.resolveCredential(connection, stored) : stored;
    await collectDocuments({
      connection, driver, credential, ingest: dependencies.ingest,
      ledger: postgresLedger(db, { tenantId, sourceConnectionId, runId, providerKey: connection.providerKey, connectorVersion: connection.connectorVersion }),
    }, counts);

    await db.execute(`update corvis_source.source_connection_run set
        state='succeeded', discovered_count=$3, accepted_count=$4, duplicate_count=$5, rejected_count=$6, finished_at=now()
      where tenant_id=$1 and run_id=$2::uuid`,
    [tenantId, runId, counts.discovered, counts.accepted, counts.duplicate, counts.rejected]);
    await db.execute(`update corvis_source.source_connection set
        consecutive_failures=0, last_error_class=null, last_success_at=now(), last_attempt_at=now(), updated_at=now(),
        next_scheduled_at=$3::timestamptz
      where tenant_id=$1 and source_connection_id=$2::uuid`,
    [tenantId, sourceConnectionId, scheduleAfter("succeeded", 0, now()).toISOString()]);

    return { runId, state: "succeeded", discoveredCount: counts.discovered, acceptedCount: counts.accepted, duplicateCount: counts.duplicate, rejectedCount: counts.rejected };
  } catch (error) {
    const failure = classifyRunFailure(error, attempt, maxAttempts, connection.consecutiveFailures);
    const { errorClass, message, state, nextStatus } = failure;

    await db.execute(`update corvis_source.source_connection_run set
        state=$3, discovered_count=$4, accepted_count=$5, duplicate_count=$6, rejected_count=$7,
        error_class=$8, error_summary=$9, finished_at=now(),
        next_attempt_at=case when $3='retryable' then now() + interval '1 minute' else null end
      where tenant_id=$1 and run_id=$2::uuid`,
    [tenantId, runId, state, counts.discovered, counts.accepted, counts.duplicate, counts.rejected, errorClass, message]);

    const nextConsecutiveFailures = connection.consecutiveFailures + 1;
    await db.execute(`update corvis_source.source_connection set
        consecutive_failures=$3, last_error_class=$4, last_attempt_at=now(), status=$5, updated_at=now(),
        next_scheduled_at=$6::timestamptz
      where tenant_id=$1 and source_connection_id=$2::uuid`,
    [tenantId, sourceConnectionId, nextConsecutiveFailures, errorClass, nextStatus,
      nextRunAt({ outcome: "failed", status: nextStatus, consecutiveFailures: nextConsecutiveFailures, now: now() })?.toISOString() ?? null]);
    if (nextStatus === "reauthorization_required" || nextStatus === "suspended") {
      // The connection just stopped collecting: tell the workspace's admins (their preference applies).
      await bestEffortNotification(db, `source_attention:${runId}`, () => enqueueForRoleAudience(db, {
        tenantId, workspaceId: connection.workspaceId, roles: sourceAttentionAudienceRoles(), category: "source_attention",
        params: { status: nextStatus }, dedupeBase: `source_attention:${runId}`,
      }));
    }

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
