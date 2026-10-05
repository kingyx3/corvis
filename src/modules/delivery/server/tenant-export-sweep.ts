import { getServerConfig } from "../../../platform/config/config.ts";
import { gcs, type GcsControlClient } from "../../../platform/gcp/gcs.ts";
import { exportObjectKey } from "./physical-exports.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { countMetric, logEvent } from "../../../platform/observability/telemetry.ts";

/**
 * Hygiene for the full tenant export (F10f, #326), run on the private delivery tick (`/api/internal/delivery`, task
 * `tenantExportSweep`). Two things would otherwise accumulate for ever:
 *
 *  - **Stored artifacts.** An export's archive stops being downloadable when its artifact lifetime passes, but the object
 *    stayed in the bucket (only the bucket's own lifecycle rule would ever remove it, and nothing recorded that it had).
 *    The sweep deletes the object and records it (`artifact_deleted_at`, a history row and a `data_export.artifact_deleted`
 *    audit event, in one transaction in `mark_tenant_export_artifact_deleted`), after the object store confirmed the
 *    deletion. A failed deletion leaves the request as it was, so the next tick retries it.
 *  - **Download grants.** Spent and expired links (`tenant_export_download_grant`) are deleted once they are a day past
 *    expiry (a link lives ten minutes and works once, so an expired one can never be redeemed). One
 *    `data_export.grants_swept` audit event per request records how many.
 *
 * Both are bounded per call so one tick never holds a long scan; a full batch means more remain for the next tick.
 */

/** A grant lives at most ten minutes; this long after its expiry it is deleted (long enough to investigate a recent one). */
export const TENANT_EXPORT_GRANT_RETENTION_HOURS = 24;
/** Expired artifacts handled per tick. */
export const TENANT_EXPORT_ARTIFACT_SWEEP_LIMIT = 100;
/** Grants deleted per tick. */
export const TENANT_EXPORT_GRANT_SWEEP_LIMIT = 1000;

export type TenantExportSweepDependencies = {
  store?: PostgresSqlApi;
  objectStore?: Pick<GcsControlClient, "deleteObject">;
  artifactLimit?: number;
  grantLimit?: number;
};

export type TenantExportSweepResult = {
  /** Expired artifacts whose stored object was deleted and recorded. */
  artifactsDeleted: number;
  /** Grants removed. */
  grantsDeleted: number;
  /** Artifacts that could not be deleted this tick (they are retried). The delivery tick reports a non-zero count as a task failure. */
  errors: number;
};

export async function sweepTenantExports(dependencies: TenantExportSweepDependencies = {}): Promise<TenantExportSweepResult> {
  const store = dependencies.store ?? postgres(getServerConfig().databaseDsn);
  const expired = await store.query(`select tenant_id::text as tenant_id, request_id::text as request_id, object_uri
    from corvis_control.expired_tenant_export_artifacts($1)`, [dependencies.artifactLimit ?? TENANT_EXPORT_ARTIFACT_SWEEP_LIMIT]);
  let artifactsDeleted = 0;
  let errors = 0;
  let objectStore = dependencies.objectStore;
  for (const row of expired) {
    const tenantId = String(row.tenant_id);
    const requestId = String(row.request_id);
    const context = { correlationId: `tenant-export:${requestId}`, tenantId };
    try {
      // Only the object store is touched for a key under the exports prefix; anything else throws before a byte is deleted.
      const key = exportObjectKey(String(row.object_uri));
      objectStore ??= gcs();
      await objectStore.deleteObject(key);
      const marked = (await store.query(`select corvis_control.mark_tenant_export_artifact_deleted($1::uuid,$2::uuid) as marked`, [tenantId, requestId]))[0];
      if (String(marked?.marked) === "true") {
        artifactsDeleted += 1;
        countMetric("delivery.tenant_export_sweep", 1, context, { outcome: "artifact_deleted" });
      }
    } catch (error) {
      errors += 1;
      logEvent("error", "delivery.tenant_export_sweep_failed", context, { errorName: error instanceof Error ? error.name : typeof error });
    }
  }
  const grants = (await store.query(`select corvis_control.sweep_tenant_export_grants($1, $2) as deleted`,
    [TENANT_EXPORT_GRANT_RETENTION_HOURS, dependencies.grantLimit ?? TENANT_EXPORT_GRANT_SWEEP_LIMIT]))[0];
  const grantsDeleted = Number(grants?.deleted ?? 0);
  if (grantsDeleted > 0) countMetric("delivery.tenant_export_sweep", grantsDeleted, { correlationId: "tenant-export:sweep" }, { outcome: "grants_deleted" });
  return { artifactsDeleted, grantsDeleted, errors };
}
