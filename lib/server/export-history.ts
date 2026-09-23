import { AuthorizationError, assertRedistributionAllowed, type RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { EXPORT_STATUS_COLUMNS, exportStatusFromJob, type ExportStatus } from "./physical-exports.ts";

/**
 * Lists the caller's own most recent exports without issuing download grants,
 * so a polling history view stays read-only. Rows are checked sequentially to
 * keep the per-request fan-out bounded. An export whose artifact the caller's
 * current rights no longer cover is omitted rather than failing the listing:
 * its manifest (snapshot ids, row counts, artifact fund/document scope)
 * describes data the caller may no longer see, and the single-export read
 * denies it for the same reason.
 */
export async function listPhysicalExportStatuses(
  identity: RequestIdentity,
  limit = 20,
  store: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<ExportStatus[]> {
  assertRedistributionAllowed(identity);
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await store.query(`select ${EXPORT_STATUS_COLUMNS}
    from corvis_serving.export_job
    where tenant_id=$1 and requested_by=$2
    order by created_at desc
    limit $3`, [identity.tenantId, identity.subject, boundedLimit]);
  const statuses: ExportStatus[] = [];
  for (const row of rows) {
    try {
      statuses.push(await exportStatusFromJob(identity, row, store));
    } catch (error) {
      if (error instanceof AuthorizationError) continue;
      throw error;
    }
  }
  return statuses;
}
