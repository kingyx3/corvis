import { getServerConfig } from "../../../platform/config.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";

/** Upper bound on one call to {@link sweepExpiredExportDownloadGrants}. */
export const EXPORT_GRANT_SWEEP_LIMIT = 5000;
/** A grant lives at most 10 minutes; this long after expiry it is deleted. */
export const EXPORT_GRANT_RETENTION_DAYS = 7;

export type ExportGrantSweepOptions = {
  /** Delete grants that expired more than this many days ago. */
  retentionDays?: number;
  /** Rows deleted per call, so one tick never holds a long scan or lock. */
  limit?: number;
};

/**
 * Deletes spent download grants from `corvis_serving.export_download_grant`. Every redemption
 * token is short-lived (see `physical-exports.ts`) and single-use, but nothing deleted the rows,
 * so one accumulated per status read forever. Rows are kept for a few days past expiry (so a
 * support investigation can still see recent grants) and then removed, whether consumed or not:
 * a grant past its expiry can never be redeemed again. Like the idempotency-key sweep this is a
 * single tenant-agnostic bounded delete over the `expires_at` index (migration 039).
 * Returns the number of rows deleted; a full batch means more remain for the next tick.
 */
export async function sweepExpiredExportDownloadGrants(
  db: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
  options: ExportGrantSweepOptions = {},
): Promise<number> {
  const retentionDays = Math.max(1, Math.floor(options.retentionDays ?? EXPORT_GRANT_RETENTION_DAYS));
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? EXPORT_GRANT_SWEEP_LIMIT)), EXPORT_GRANT_SWEEP_LIMIT);
  const rows = await db.query(`delete from corvis_serving.export_download_grant
    where ctid in (
      select ctid from corvis_serving.export_download_grant
      where expires_at < now() - make_interval(days => $1)
      order by expires_at
      limit $2
    )
    returning grant_id`, [retentionDays, limit]);
  return rows.length;
}
