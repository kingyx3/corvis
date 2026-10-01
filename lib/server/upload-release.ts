import { getServerConfig } from "./config.ts";
import { gcs, type UploadObjectStore } from "./gcs.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { sealArtifactIntegrity } from "./upload-integrity.ts";
import { QUARANTINE_RETENTION_MS } from "./uploads.ts";

export type UploadReleaseSummary = {
  scanned: number;
  released: number;
  threats: number;
  integrityFailed: number;
  pending: number;
  errors: number;
};

export type UploadReleaseOptions = {
  store?: UploadObjectStore;
  db?: PostgresSqlApi;
  limit?: number;
  /** Stop starting new artifacts after this long so overlapping scheduler ticks stay bounded. */
  budgetMs?: number;
  now?: () => number;
};

const DEFAULT_LIMIT = 50;
const DEFAULT_BUDGET_MS = 200_000;

function objectKeyOf(objectUri: string, bucket: string): string | undefined {
  const prefix = `gs://${bucket}/`;
  return objectUri.startsWith(prefix) ? objectUri.slice(prefix.length) : undefined;
}

/**
 * Malware scanning is asynchronous, so an upload is still quarantined when
 * `complete` returns and the browser stops polling. This releases every
 * artifact whose scanner verdict has since landed, driven from the database
 * rather than per-session bucket state so it needs no bucket writes and can
 * run on the private worker's existing scheduler tick. It applies the same
 * gates as the interactive path: size and generation must still match what was
 * verified at completion, and the bytes' SHA-256 is sealed (and checked against
 * any declared digest) before `release_clean_artifact` queues processing.
 * Every step is idempotent, so overlapping ticks or a concurrent
 * `GET /uploads/{id}` cannot double-release.
 */
export async function releaseScannedUploads(options: UploadReleaseOptions = {}): Promise<UploadReleaseSummary> {
  const summary: UploadReleaseSummary = { scanned: 0, released: 0, threats: 0, integrityFailed: 0, pending: 0, errors: 0 };
  const config = getServerConfig();
  if (config.demoMode) return summary;
  const store = options.store ?? gcs();
  const db = options.db ?? postgres(config.postgresDsn);
  const now = options.now ?? Date.now;
  const started = now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;

  // Only artifacts still inside the quarantine retention window: older ones are
  // the sweep's to purge and must not starve fresh uploads of the batch limit.
  // Rows that stayed pending (no scanner verdict yet, or a failed attempt) carry
  // `last_release_attempt_at` and go to the back, and each tenant's rows are
  // interleaved by rank, so neither a stuck row nor one tenant's backlog can
  // hold the head of the queue for the whole retention window.
  const rows = await db.query(
    `select tenant_id::text as tenant_id, document_id::text as document_id,
            document_artifact_version_id::text as artifact_version_id, ingestion_id,
            object_uri, size_bytes, storage_generation
       from (
         select tenant_id, document_id, document_artifact_version_id, ingestion_id,
                object_uri, size_bytes, storage_generation, created_at, last_release_attempt_at,
                row_number() over (partition by tenant_id order by last_release_attempt_at nulls first, created_at) as tenant_rank
           from corvis_source.document_artifact_version
          where malware_scan_status='pending' and quarantine_status='quarantined' and storage_generation is not null
            and created_at > now() - make_interval(secs => $2)
       ) queued
      order by tenant_rank, last_release_attempt_at nulls first, created_at
      limit $1`,
    [Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), 200), Math.floor(QUARANTINE_RETENTION_MS / 1000)],
  );

  for (const row of rows) {
    if (now() - started > budgetMs) break;
    summary.scanned += 1;
    try {
      const outcome = await processArtifact(store, db, row, config);
      summary[outcome] += 1;
      if (outcome === "pending") await markAttempted(db, row);
    } catch {
      // One unreadable object must not stop the rest; the next tick retries it.
      summary.errors += 1;
      await markAttempted(db, row);
    }
  }
  return summary;
}

/** Sends a row that is still unreleased to the back of the queue; best effort, so a failure only costs fairness. */
async function markAttempted(db: PostgresSqlApi, row: PostgresRow): Promise<void> {
  await db.execute(`update corvis_source.document_artifact_version set last_release_attempt_at=now()
    where tenant_id=$1::uuid and document_artifact_version_id=$2::uuid`,
  [String(row.tenant_id), String(row.artifact_version_id)]).catch(() => undefined);
}

async function processArtifact(
  store: UploadObjectStore,
  db: PostgresSqlApi,
  row: PostgresRow,
  config: ReturnType<typeof getServerConfig>,
): Promise<"released" | "threats" | "integrityFailed" | "pending"> {
  const tenantId = String(row.tenant_id);
  const documentId = String(row.document_id);
  const artifactVersionId = String(row.artifact_version_id);
  const generation = String(row.storage_generation);
  const objectKey = objectKeyOf(String(row.object_uri), store.bucket);
  if (!objectKey) throw new Error("artifact object is not in the configured source bucket");

  const object = await store.getObjectMetadata(objectKey);
  const verdict = object?.metadata?.[config.gcsMalwareMetadataKey];

  if (!object || (verdict !== config.gcsMalwareCleanValue && verdict !== config.gcsMalwareThreatValue)) return "pending";

  if (verdict === config.gcsMalwareThreatValue) {
    await db.execute(`update corvis_source.document_artifact_version
      set malware_scan_status='threat',quarantine_status='quarantined'
      where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [tenantId, artifactVersionId]);
    await db.execute(`update corvis_source.document set status='quarantined'
      where tenant_id=$1 and document_id=$2::uuid`, [tenantId, documentId]);
    return "threats";
  }

  // A clean verdict only counts for the exact object that was verified at completion.
  if (object.generation !== generation || Number(object.size ?? -1) !== Number(row.size_bytes)) {
    await db.execute(`update corvis_source.document_artifact_version
      set malware_scan_status='integrity_failed',quarantine_status='quarantined'
      where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [tenantId, artifactVersionId]);
    await db.execute(`update corvis_source.document set status='quarantined'
      where tenant_id=$1 and document_id=$2::uuid`, [tenantId, documentId]);
    return "integrityFailed";
  }

  const seal = await sealArtifactIntegrity(store, db, { tenantId, artifactVersionId, documentId, objectKey, generation });
  if (seal.outcome === "integrity_failed") return "integrityFailed";
  if (seal.outcome === "blocked") return "pending";
  // Already released by another path (the interactive poll, or a prior tick):
  // release_clean_artifact is not safe to call again, since it unconditionally
  // resets document.status to 'queued' regardless of how far the pipeline has
  // since progressed.
  if (seal.outcome === "released") return "released";

  const released = await db.query(`select corvis_source.release_clean_artifact($1::uuid,$2::uuid,$3::uuid,$4,$5) as job_id`,
    [tenantId, documentId, artifactVersionId, generation, String(row.ingestion_id)]);
  if (!released[0]?.job_id) throw new Error("Artifact release did not create processing state");
  return "released";
}
