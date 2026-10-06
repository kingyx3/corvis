import { SESSION_ACTIVITY_PURGE_LIMIT, sessionActivityRetentionMinutes } from "../../domain/session-policy.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { postgres, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { countMetric, logEvent } from "../../../../platform/observability/telemetry.ts";

export type SessionActivitySweepOptions = {
  /** Keep records this many minutes after the session was last seen. Never below the floor in `src/modules/identity-access/domain/session-policy.ts`. */
  retentionMinutes?: number;
  /** Records removed per call, so one tick never holds a long scan or lock. */
  limit?: number;
};

/**
 * Housekeeping for `corvis_control.tenant_session_activity` (F7d, #337): removes the records of sessions not seen for the
 * whole retention window, through `corvis_control.purge_tenant_session_activity`. The retention is never
 * shorter than the longest session a policy can still be measuring (10,080 minutes plus a day), and the SQL function
 * refuses a shorter one itself, so a session an idle or maximum-length limit is judging is never removed. Revoked
 * sessions are unaffected: `session_revocation` is a separate table that every request consults on its own.
 *
 * The purge writes no audit event (the records are bookkeeping, not decisions); it logs how many records it removed.
 * Returns that number; a full batch means more remain for the next tick.
 */
export async function sweepTenantSessionActivity(
  db: PostgresSqlApi = postgres(getServerConfig().databaseDsn),
  options: SessionActivitySweepOptions = {},
): Promise<number> {
  const retentionMinutes = sessionActivityRetentionMinutes(options.retentionMinutes);
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? SESSION_ACTIVITY_PURGE_LIMIT)), SESSION_ACTIVITY_PURGE_LIMIT);
  const rows = await db.query(`select corvis_control.purge_tenant_session_activity($1::integer,$2::integer) as purged`, [retentionMinutes, limit]);
  const purged = Number(rows[0]?.purged ?? 0);
  if (purged > 0) {
    const context = { correlationId: "session-activity-sweep" };
    logEvent("info", "session_activity.purged", context, { purged, retentionMinutes, fullBatch: purged >= limit });
    countMetric("session_activity.purged", purged, context);
  }
  return purged;
}
