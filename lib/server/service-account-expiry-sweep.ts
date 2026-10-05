import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { countMetric, logEvent } from "./telemetry.ts";

/** Notices queued per call, so one tick never holds a long scan. A larger backlog drains over the next ticks. */
export const SERVICE_ACCOUNT_EXPIRY_NOTICE_BATCH = 500;

/**
 * Tells Organization Admins before a service account, or the API credential it uses, expires (F6d, #341): the delivery
 * tick calls `corvis_control.queue_service_account_expiry_notices` (migration 096), which queues one mandatory
 * `service_account_expiry` email per active human Organization Admin when an active account, or its credential in use,
 * enters its 14-day warning window and again inside 3 days. The outbox `dedupe_key` (item, window, exact expiry,
 * recipient) makes the sweep idempotent however often it runs: a notice is queued once, a renewal starts new windows
 * rather than repeating an old one, and a deactivated account, an expired one, a revoked or rotated-out credential and
 * a suspended tenant are never announced. The email itself is sent by the ordinary outbox dispatcher, which re-checks
 * at send time that the recipient is still an active Organization Admin.
 *
 * Returns how many notices it queued; a full batch means more are due for the next tick. It logs and counts only that
 * number: never an account, a credential or a person.
 */
export async function sweepServiceAccountExpiry(
  db: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
  limit: number = SERVICE_ACCOUNT_EXPIRY_NOTICE_BATCH,
): Promise<number> {
  const bounded = Math.min(Math.max(1, Math.floor(limit)), SERVICE_ACCOUNT_EXPIRY_NOTICE_BATCH);
  const rows = await db.query(`select corvis_control.queue_service_account_expiry_notices($1::integer) as queued`, [bounded]);
  const queued = Number(rows[0]?.queued ?? 0);
  if (queued > 0) {
    const context = { correlationId: "service-account-expiry-sweep" };
    logEvent("info", "service_account_expiry.queued", context, { queued, fullBatch: queued >= bounded });
    countMetric("service_account_expiry.queued", queued, context);
  }
  return queued;
}
