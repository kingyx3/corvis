import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { ExportScheduleValidationError } from "../../domain/export-schedule.ts";
import { exportScheduleService } from "./export-schedule-service.ts";
import { ExportScheduleRequestError } from "./export-schedule.ts";
import { apiError, json } from "../../../../platform/http/api/http.ts";
import { parseLimit } from "../../../../platform/http/api/pagination.ts";

/** Typed schedule failures keep their stable code and status; everything else goes through the shared API error mapper. */
export function exportScheduleErrorResponse(error: unknown, correlationId: string): Response {
  if (error instanceof ExportScheduleValidationError || error instanceof ExportScheduleRequestError) {
    return json({ error: error.code, correlationId }, { status: error.status });
  }
  return apiError(error, correlationId);
}

function listParameters(request: Request): { scope: "mine" | "all"; limit: number; cursor: string | null; params: URLSearchParams } {
  const params = new URL(request.url).searchParams;
  const scope = params.get("scope") ?? "mine";
  if (scope !== "mine" && scope !== "all") throw new ExportScheduleValidationError("invalid_scope");
  return { scope, limit: parseLimit(params.get("limit")), cursor: params.get("cursor"), params };
}

/**
 * `GET` of the schedule list: the caller's own schedules, or every schedule in the tenant for an Organization Admin with
 * `?scope=all`. Newest first, keyset-paged.
 */
export async function listExportSchedulesResponse(request: Request, identity: RequestIdentity, correlationId: string): Promise<Response> {
  const { scope, limit, cursor } = listParameters(request);
  const page = await exportScheduleService().list(identity, { scope, limit, cursor });
  return json({ data: page.items, nextCursor: page.nextCursor, correlationId });
}

/**
 * `GET` of the run history of the schedules the caller may list: every run, including refused ones, newest first.
 * `?scheduleId=` narrows it to one schedule.
 */
export async function listExportScheduleRunsResponse(request: Request, identity: RequestIdentity, correlationId: string): Promise<Response> {
  const { scope, limit, cursor, params } = listParameters(request);
  const page = await exportScheduleService().listRuns(identity, { scope, limit, cursor, scheduleId: params.get("scheduleId") ?? undefined });
  return json({ data: page.items, nextCursor: page.nextCursor, correlationId });
}
