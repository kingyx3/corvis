import { assertPermission } from "@/shared/domain/enterprise";
import { parseCreateScheduleCommand } from "@/modules/delivery/domain/export-schedule";
import { readJsonObject } from "@/platform/http/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { exportScheduleErrorResponse, listExportSchedulesResponse } from "@/modules/delivery/server/export-schedule-http";
import { exportScheduleService } from "@/modules/delivery/server/export-schedule-service";
import { correlationId, json } from "@/platform/http/http";

/**
 * Scheduled exports (F4): a saved "Export this view" scope that requests a governed export when a matching snapshot is
 * published, or monthly or quarterly. The caller sees their own schedules; an Organization Admin may list the whole
 * tenant with `?scope=all`. A schedule never exports on its own: each run re-authorizes the owner and goes through the
 * same export pipeline as `POST /api/v1/exports`.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    return await listExportSchedulesResponse(request, identity, id);
  } catch (error) { return exportScheduleErrorResponse(error, id); }
}

/** Idempotent per owner: `idempotencyKey` in the body or the `Idempotency-Key` header. A replay answers 200 with the original schedule. */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "exports:create");
    const command = parseCreateScheduleCommand(await readJsonObject(request), request.headers.get("idempotency-key"));
    const { item, created } = await exportScheduleService().create(identity, command, id);
    return json({ data: item, replayed: !created, correlationId: id }, { status: created ? 201 : 200 });
  } catch (error) { return exportScheduleErrorResponse(error, id); }
}
