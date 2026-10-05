import type { ExportScheduleNotifiedReason } from "../../domain/export-schedule.ts";
import { bestEffortNotification } from "../../../notifications/server/notifications.ts";
import type { PostgresSqlApi } from "../../../../platform/database/postgres.ts";

/**
 * Scheduled-export notifications (F4b, #328). A scheduled run ends in exactly one of: a completed export, a refusal at the
 * run (fail-closed: owner_inactive, redistribution_not_permitted, ...), or an accepted export whose delivery failed. Each
 * end is announced twice, and neither announcement carries data:
 *
 *  - a webhook event (`ExportScheduleRunCompleted` / `ExportScheduleRunFailed`) through the ordinary outbox, whose payload is
 *    the schedule's id and label, the run, and a closed reason code (migration 090, `emit_export_schedule_run_event`);
 *  - for a failure, an `export_schedule_failed` email to the owner, in words only (`src/modules/notifications/domain/notifications.ts`), unless the
 *    owner switched that schedule's emails off.
 *
 * Both are best effort: a notification fault is logged and never undoes the run or the export.
 */

/** The owner's failure email. Skipped for a service identity (no verified address) and for a schedule with emails off. */
async function enqueueScheduleFailureEmail(db: PostgresSqlApi, input: { tenantId: string; runId: string; reason: ExportScheduleNotifiedReason }): Promise<void> {
  await db.execute(`insert into corvis_control.email_outbox
      (tenant_id,category,recipient_user_id,workspace_id,fund_id,required_roles,template_params,dedupe_key)
    select s.tenant_id,'export_schedule_failed',i.user_id,s.workspace_id,null,null,jsonb_build_object('reason',$3::text),'export_schedule_failed:' || r.run_id::text
    from corvis_control.export_schedule_run r
    join corvis_control.export_schedule s on s.tenant_id=r.tenant_id and s.schedule_id=r.schedule_id
    join corvis_control.identity_subject i on i.tenant_id=s.tenant_id and i.auth_method=s.owner_auth_method and i.subject=s.owner_subject
    where r.tenant_id=$1::uuid and r.run_id=$2::uuid and s.notify_on_completion and i.auth_method in ('oidc','saml')
    on conflict (tenant_id,dedupe_key) do nothing`, [input.tenantId, input.runId, input.reason]);
}

/**
 * A run that ended in failure: the webhook event and the owner's email. `inTransaction` when `db` is the open transaction
 * that records the run, so a failed notification statement is isolated by a savepoint and the run still commits.
 */
export async function notifyScheduledRunFailed(
  db: PostgresSqlApi,
  input: { tenantId: string; runId: string; reason: ExportScheduleNotifiedReason },
  options: { inTransaction?: boolean } = {},
): Promise<void> {
  await bestEffortNotification(db, `export_schedule_run:${input.runId}:failed`, async () => {
    await db.query(`select corvis_control.emit_export_schedule_run_event($1::uuid,$2::uuid,'failed',$3)`, [input.tenantId, input.runId, input.reason]);
    await enqueueScheduleFailureEmail(db, input);
  }, options);
}

/**
 * The governed export behind a scheduled run reached a final state. Does nothing for an export no schedule requested, so
 * the export worker can call it for every export. `complete` emits the completion event; `failed` is a failure like a
 * refusal, with the reason `export_failed`. Best effort end to end, the lookup included: it never throws into the export
 * worker. Answers whether the requester's ordinary `export_ready` email should still be queued: always, except for an
 * export that an opted-out schedule requested (the owner's switch, see `notify_on_completion`); a fault in the lookup
 * leaves the email on, as it was before schedules had a switch.
 */
export async function notifyScheduledExportOutcome(
  db: PostgresSqlApi,
  input: { tenantId: string; exportId: string; outcome: "complete" | "failed" },
): Promise<{ ownerEmails: boolean }> {
  let ownerEmails = true;
  await bestEffortNotification(db, `export_schedule_export:${input.exportId}:${input.outcome}`, async () => {
    const run = (await db.query(`select r.run_id,s.notify_on_completion from corvis_control.export_schedule_run r
      join corvis_control.export_schedule s on s.tenant_id=r.tenant_id and s.schedule_id=r.schedule_id
      where r.tenant_id=$1::uuid and r.export_id=$2::uuid`, [input.tenantId, input.exportId]))[0];
    if (!run) return;
    ownerEmails = run.notify_on_completion === true || run.notify_on_completion === "true";
    const runId = String(run.run_id);
    if (input.outcome === "failed") await notifyScheduledRunFailed(db, { tenantId: input.tenantId, runId, reason: "export_failed" });
    else await db.query(`select corvis_control.emit_export_schedule_run_event($1::uuid,$2::uuid,'completed')`, [input.tenantId, runId]);
  });
  return { ownerEmails };
}
