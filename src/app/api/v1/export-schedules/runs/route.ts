import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { exportScheduleErrorResponse, listExportScheduleRunsResponse } from "@/modules/delivery/server/schedules/export-schedule-http";
import { correlationId } from "@/platform/http/api/http";

/**
 * The scheduled part of delivery history: every run of the caller's schedules (every schedule in the tenant for an
 * Organization Admin with `?scope=all`), including runs that were refused and exported nothing. `?scheduleId=` narrows
 * it to one schedule. Each requested run names the export it produced; its file is downloaded from the export history.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    return await listExportScheduleRunsResponse(request, identity, id);
  } catch (error) { return exportScheduleErrorResponse(error, id); }
}
