import { AuthorizationError, assertRedistributionAllowed, type RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type { ScheduledExportMarker } from "../../domain/export-schedule.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { postgres, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { EXPORT_STATUS_COLUMNS, exportStatusFromJob, type ExportStatus } from "./physical-exports.ts";

export type ListedExportStatus = ExportStatus & {
  /** Present when the export was requested by a schedule (F4): which schedule, and the trigger that fired it. */
  schedule?: ScheduledExportMarker;
};

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
  store: PostgresSqlApi = postgres(getServerConfig().databaseDsn),
): Promise<ListedExportStatus[]> {
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
  if (statuses.length === 0) return statuses;
  // An export a schedule requested carries its schedule's label and trigger, so delivery history says why it exists.
  // One bounded lookup keyed by the (at most 50) listed export ids; the label is the schedule's own, never the caller's input here.
  const scheduled = await store.query(`select r.export_id,r.schedule_id,r.trigger_key,s.label
    from corvis_control.export_schedule_run r
    join corvis_control.export_schedule s on s.tenant_id=r.tenant_id and s.schedule_id=r.schedule_id
    where r.tenant_id=$1 and r.export_id in (select jsonb_array_elements_text($2::jsonb)::uuid)`,
  [identity.tenantId, JSON.stringify(statuses.map((status) => status.exportId))]);
  const markers = new Map(scheduled.map((row) => [String(row.export_id), { scheduleId: String(row.schedule_id), label: String(row.label), triggerKey: String(row.trigger_key) }]));
  return statuses.map((status) => {
    const schedule = markers.get(status.exportId);
    return schedule ? { ...status, schedule } : status;
  });
}
