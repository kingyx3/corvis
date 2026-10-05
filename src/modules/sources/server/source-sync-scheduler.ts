import { demoSourceConnectionStore } from "../adapters/source-connection-store.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { sourceConnectorDrivers, sourceConnectorSecretStore } from "./source-connector-runtime.ts";
import { resolveConnectionCredential } from "./source-connector-governance.ts";
import { runConnectionSync } from "./source-connector-sync.ts";
import { sourceSyncIdentity, uploadIngestSink } from "./source-ingest-sink.ts";
import { approvedSourceProvider } from "./source-providers.ts";
import { emptySyncSummary, leaseExpiry, scheduleAfter, type SourceSyncSummary } from "./source-sync-schedule.ts";
import type { ConnectorDriver, IngestSink, SecretStore } from "./source-connectors.ts";
import { logEvent } from "../../../platform/observability/telemetry.ts";

/**
 * Scheduled collection for active source connections, run from the private delivery tick (task `sourceSync`).
 *
 * Each pass finds active connections that are due (`next_scheduled_at` empty or past), and for each one:
 *  1. claims it with a compare-and-set that pushes `next_scheduled_at` out by the lease, so two workers can never run
 *     the same connection (the loser's claim matches no row);
 *  2. closes any run a dead worker left in `running`;
 *  3. calls `runConnectionSync`, which refuses a connection that is not active, fails closed on credential and
 *     permission errors, feeds documents through the upload pipeline (idempotent per remote document version) and, however
 *     the run ends, sets the next run time (the interval after a success, a bounded backoff after a failure).
 * A connection whose test failed is never active (a failed first test leaves it pending; a fail-closed class suspends it
 * or sends it to reauthorization), so it is never listed here, and `runConnectionSync` refuses it anyway if it changed
 * between the listing and the claim.
 */

export type SourceSyncDependencies = {
  db?: PostgresSqlApi;
  secrets?: SecretStore;
  drivers?: Map<string, ConnectorDriver>;
  ingest?: IngestSink;
  now?: () => number;
};

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().databaseDsn); }

/** Re-queues a connection after a fault the sync itself could not record, but only while this pass still holds its lease. */
async function releaseAfterFault(db: PostgresSqlApi, tenantId: string, sourceConnectionId: string, lease: string, now: number): Promise<void> {
  const retryAt = scheduleAfter("failed", 1, now);
  await db.execute(`update corvis_source.source_connection set next_scheduled_at=$3::timestamptz, updated_at=now()
    where tenant_id=$1::uuid and source_connection_id=$2::uuid and next_scheduled_at=$4::timestamptz`,
  [tenantId, sourceConnectionId, retryAt.toISOString(), lease]);
}

async function syncDueConnection(
  db: PostgresSqlApi,
  due: { tenantId: string; sourceConnectionId: string },
  dependencies: Required<Omit<SourceSyncDependencies, "db">>,
  summary: SourceSyncSummary,
): Promise<void> {
  const now = dependencies.now();
  const lease = leaseExpiry(now).toISOString();
  const claimed = await db.query(`update corvis_source.source_connection set next_scheduled_at=$3::timestamptz, updated_at=now()
    where tenant_id=$1::uuid and source_connection_id=$2::uuid and status='active'
      and (next_scheduled_at is null or next_scheduled_at <= now())
    returning workspace_id`, [due.tenantId, due.sourceConnectionId, lease]);
  const workspaceId = claimed[0]?.workspace_id;
  if (workspaceId === undefined) { summary.skipped += 1; return; }

  try {
    // This pass holds the lease, so a run still marked running belongs to a worker that died.
    await db.execute(`update corvis_source.source_connection_run set state='failed', finished_at=now()
      where tenant_id=$1::uuid and source_connection_id=$2::uuid and state='running'`, [due.tenantId, due.sourceConnectionId]);
    const identity = sourceSyncIdentity(due.tenantId, String(workspaceId));
    const outcome = await runConnectionSync(due.tenantId, due.sourceConnectionId, "scheduled", {
      db, secrets: dependencies.secrets, drivers: dependencies.drivers, ingest: dependencies.ingest, now: dependencies.now,
      resolveCredential: (connection, credential) => resolveConnectionCredential(identity, connection, credential, `source-sync:${due.sourceConnectionId}`, {
        db, secrets: dependencies.secrets, oauthClient: (providerKey) => approvedSourceProvider(providerKey)?.oauth, now: dependencies.now,
      }),
    });
    if (outcome.state === "succeeded") summary.succeeded += 1;
    else if (outcome.state === "refused") summary.refused += 1;
    else summary.failed += 1;
  } catch (error) {
    summary.errors += 1;
    logEvent("error", "source_sync.run_failed", { correlationId: `source-sync:${due.sourceConnectionId}`, tenantId: due.tenantId }, { errorName: error instanceof Error ? error.name : typeof error });
    await releaseAfterFault(db, due.tenantId, due.sourceConnectionId, lease, now).catch(() => undefined);
  }
}

/**
 * One scheduler pass. Bounded by `limit`; whatever is still due waits for the next tick. A connection whose pass raises
 * an unexpected fault is logged and retried after a backoff without holding back the others.
 */
export async function processDueSourceSyncs(limit = 25, dependencies: SourceSyncDependencies = {}): Promise<SourceSyncSummary> {
  const ingest = dependencies.ingest ?? uploadIngestSink();
  const now = dependencies.now ?? Date.now;
  // Demo mode has no database: its connections live in memory and are collected by the same loop through the demo store.
  if (getServerConfig().demoMode && !dependencies.db) return demoSourceConnectionStore().runDueSyncs({ ingest, now: now() });

  const db = dependencies.db ?? controlDb();
  const drivers = dependencies.drivers ?? sourceConnectorDrivers();
  const summary = emptySyncSummary();
  // A provider with no registered driver cannot be collected from, so it is left out of the listing (it is not an error,
  // and it must not crowd out connections that can be collected from).
  const rows = await db.query(`select tenant_id, source_connection_id from corvis_source.source_connection
    where status='active' and (next_scheduled_at is null or next_scheduled_at <= now())
      and provider_key in (select jsonb_array_elements_text($2::jsonb))
    order by coalesce(next_scheduled_at, created_at), source_connection_id
    limit $1::integer`, [limit, JSON.stringify([...drivers.keys()])]);
  // Selected only once there is something to collect, so a deployment with no connections never needs a secret store.
  const secrets = rows.length > 0 ? dependencies.secrets ?? sourceConnectorSecretStore() : undefined;
  for (const row of rows) {
    summary.due += 1;
    await syncDueConnection(db, { tenantId: String(row.tenant_id), sourceConnectionId: String(row.source_connection_id) }, { secrets: secrets!, drivers, ingest, now }, summary);
  }
  return summary;
}
