import { createHash } from "node:crypto";
import { TENANT_EXPORT_ARCHIVE_NAME, TENANT_EXPORT_MAX_BUILD_ATTEMPTS, type TenantExportProgress } from "../domain/tenant-export.ts";
import { computeExportRetryDelayMs, type RandomSource } from "./delivery.ts";
import { getServerConfig } from "../../../platform/config.ts";
import { gcs, type GcsControlClient } from "../../../platform/gcp/gcs.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { safeErrorText } from "../../processing/server/processing-error-text.ts";
import { TENANT_EXPORT_CONTENT_TYPE } from "./tenant-export-bundle.ts";
import { createTenantExportArchive, type TenantExportArchiveOptions } from "./tenant-export-archive.ts";
import { countMetric } from "../../../platform/telemetry.ts";

/**
 * The build of a full tenant export (F10, #266; at scale F10b #322 and F10c #323), run by the delivery worker tick
 * (`/api/internal/delivery`) next to the per-user export queue. It claims one approved request at a time
 * (`claim_next_tenant_export_build`, which also reclaims builds abandoned by a crashed worker), streams the
 * checksum-manifested archive (`tenant-export-archive.ts`) straight to the object store under the same `exports/` prefix and
 * lifecycle as every other export, and records the artifact with an expiry equal to the export artifact lifetime.
 *
 * The archive is never held in memory and no transaction is held open while it is built: every query is its own statement,
 * and the upload is a resumable write that holds one chunk. A build can therefore outlast its ten-minute lease, so it reports
 * progress as it goes (`record_tenant_export_build_progress`), which both shows the request's size estimate and progress
 * and extends the lease; a worker that stops reporting still loses it and the request is reclaimed and retried as before.
 * Failures retry with the same capped backoff as the per-user queue, starting over from the first page (a retry never
 * depends on what an earlier attempt wrote). A source file that does not match its recorded checksum fails permanently.
 *
 * Contractual data rights decide what goes in (criterion 4): only funds and documents returned by
 * `corvis_control.tenant_export_rights` (migration 084) are exported, source files only where source-file access is also
 * granted, and what was left out is reported as counts in the manifest, never listed or silently dropped.
 */

export const TENANT_EXPORT_BUILD_LEASE_MINUTES = 10;

type ObjectStore = Pick<GcsControlClient, "bucket" | "putObjectStream" | "deleteObject" | "getObjectStream">;
export type TenantExportWorkerDependencies = {
  store?: PostgresSqlApi;
  objectStore?: ObjectStore;
  random?: RandomSource;
  now?: () => number;
  /** Page and part sizes and the progress interval (tests shrink them to cross a part boundary with a handful of rows). */
  archive?: Pick<TenantExportArchiveOptions, "rowsPerFile" | "pageRows" | "documentPage" | "progressIntervalMs">;
};

export function tenantExportObjectKey(tenantId: string, requestId: string, attempt: number): string {
  return `exports/${tenantId}/tenant-export-${requestId}/attempt-${attempt}/${TENANT_EXPORT_ARCHIVE_NAME}`;
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
      const archive = createTenantExportArchive(claimed, store, objectStore, { now, ...dependencies.archive, onProgress: (progress) => recordProgress(store, tenantId, requestId, attempt, progress) });
      // The checksum and size of the archive are measured on the way to the object store, never by holding it.
      const digest = createHash("sha256");
      let sizeBytes = 0;
      const measured = async function* (): AsyncGenerator<Buffer> {
        for await (const part of archive.bytes) { digest.update(part); sizeBytes += part.length; yield part; }
      };
      await objectStore.putObjectStream(key, measured(), TENANT_EXPORT_CONTENT_TYPE);
      const { publicManifest, scope } = archive.outcome();
      const checksum = digest.digest("hex");
      const expiresAt = new Date(now() + config.exportArtifactTtlSeconds * 1000).toISOString();
      // `artifact` is internal (the rights re-check at download reads the scope from it) and is never sent to clients.
      const manifest = { ...publicManifest, artifact: { contentType: TENANT_EXPORT_CONTENT_TYPE, sizeBytes, objectKey: key, ...scope } };
      const completed = await store.query(`select request_id from corvis_control.complete_tenant_export_build($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6,$7,$8::jsonb)`,
        [tenantId, requestId, attempt, `gs://${objectStore.bucket}/${key}`, expiresAt, checksum, sizeBytes, JSON.stringify(manifest)]);
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
      // Deterministic failures (a source file that fails its checksum) can never succeed on retry.
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

/**
 * Stores a progress report and extends the lease. False when this attempt no longer owns the build (so it stops). A report
 * that could not be stored is not a reason to abandon a build that is making progress: it is only display, and the next
 * report extends the lease again; if none ever lands the lease lapses and the request is reclaimed as usual.
 */
async function recordProgress(store: PostgresSqlApi, tenantId: string, requestId: string, attempt: number, progress: TenantExportProgress): Promise<boolean> {
  try {
    const row = (await store.query(`select corvis_control.record_tenant_export_build_progress($1::uuid,$2::uuid,$3,$4::jsonb,$5) as owned`,
      [tenantId, requestId, attempt, JSON.stringify(progress), TENANT_EXPORT_BUILD_LEASE_MINUTES]))[0];
    return String(row?.owned) === "true";
  } catch {
    return true;
  }
}
