import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { exportScheduleErrorResponse, listExportScheduleRunsResponse } from "@/lib/server/export-schedule-http";
import { correlationId } from "@/lib/server/http";

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
