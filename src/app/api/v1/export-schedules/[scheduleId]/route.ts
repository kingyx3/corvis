import { assertPermission } from "@/shared/domain/enterprise";
import { parseSchedulePatch } from "@/modules/delivery/domain/export-schedule";
import { readJsonObject } from "@/platform/http/identity/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { exportScheduleErrorResponse } from "@/modules/delivery/server/schedules/export-schedule-http";
import { exportScheduleService } from "@/modules/delivery/server/schedules/export-schedule-service";
import { correlationId, json } from "@/platform/http/api/http";

/** One schedule, for its owner or an Organization Admin. Anyone else gets the same 404 as a missing schedule. */
export async function GET(request: Request, context: { params: Promise<{ scheduleId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const { scheduleId } = await context.params;
    return json({ data: await exportScheduleService().get(identity, scheduleId), correlationId: id });
  } catch (error) { return exportScheduleErrorResponse(error, id); }
}

/**
 * The owner pauses or resumes the schedule (`{ "action": "pause" | "resume" }`) or switches the emails about it on or off
 * (`{ "notifyOnCompletion": boolean }`). Nobody else can, an Organization Admin included.
 */
export async function PATCH(request: Request, context: { params: Promise<{ scheduleId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const patch = parseSchedulePatch(await readJsonObject(request));
    const { scheduleId } = await context.params;
    const service = exportScheduleService();
    const data = patch.kind === "action"
      ? await service.setStatus(identity, scheduleId, patch.action, id)
      : await service.setNotification(identity, scheduleId, patch.notifyOnCompletion, id);
    return json({ data, correlationId: id });
  } catch (error) { return exportScheduleErrorResponse(error, id); }
}

/** The owner deletes the schedule: it never runs again. Its runs and the exports they produced stay in delivery history. */
export async function DELETE(request: Request, context: { params: Promise<{ scheduleId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const { scheduleId } = await context.params;
    const removed = await exportScheduleService().remove(identity, scheduleId, id);
    return json({ data: { scheduleId: removed.scheduleId, status: "deleted" }, correlationId: id });
  } catch (error) { return exportScheduleErrorResponse(error, id); }
}
