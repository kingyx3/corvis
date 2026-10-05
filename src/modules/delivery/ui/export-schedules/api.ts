import type { CreateExportScheduleCommand, ExportSchedule, ExportScheduleAction, ExportScheduleRun } from "@/modules/delivery/domain/export-schedule";
import { apiUrl } from "@/shared/lib/api-url";
import { apiResponseError, friendlyErrorMessage } from "@/shared/lib/api-errors";
import { workspaceContextHeaders } from "@/shared/lib/workspace-context";

const ENDPOINT = "/api/v1/export-schedules";

export type ScheduleScopeChoice = "mine" | "all";

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { ...workspaceContextHeaders(), accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  if (!response.ok) throw await apiResponseError(response);
  return response;
}

/** Plain-language copy for the stable error codes the schedule routes return; anything else gets `fallback`. */
export function exportScheduleErrorMessage(reason: unknown, fallback: string): string {
  const code = (reason as { code?: unknown } | null)?.code;
  const known: Record<string, string> = {
    export_scope_not_entitled: "You no longer have access to the data in this view, so it cannot be scheduled.",
    feature_disabled: "This export format is not enabled for your organization. Choose another format.",
    forbidden: "Your organization's data rights do not currently allow exports to be scheduled.",
    idempotency_key_reused: "A different schedule was already saved with this reference. Close this dialog and start again.",
    export_schedule_limit_reached: "You already have 50 schedules. Delete one you no longer need and try again.",
    export_schedule_transition_not_allowed: "This schedule cannot be changed that way right now. Refresh and try again.",
    export_schedule_not_found: "This schedule no longer exists or is not yours to change.",
    invalid_label: "Give the schedule a name of 1 to 80 characters on a single line.",
    invalid_scope: "This view can no longer be identified. Refresh the page and try again.",
  };
  return typeof code === "string" && known[code] ? known[code]! : friendlyErrorMessage(reason, fallback);
}

export async function createExportSchedule(command: CreateExportScheduleCommand): Promise<{ item: ExportSchedule; replayed: boolean }> {
  const payload = await (await send(ENDPOINT, { method: "POST", body: JSON.stringify(command) })).json() as { data: ExportSchedule; replayed: boolean };
  return { item: payload.data, replayed: payload.replayed };
}

export async function listExportSchedules(scope: ScheduleScopeChoice, signal?: AbortSignal): Promise<ExportSchedule[]> {
  const payload = await (await send(`${ENDPOINT}?scope=${scope}&limit=200`, { signal })).json() as { data: ExportSchedule[] };
  return payload.data;
}

export async function listExportScheduleRuns(scope: ScheduleScopeChoice, signal?: AbortSignal): Promise<ExportScheduleRun[]> {
  const payload = await (await send(`${ENDPOINT}/runs?scope=${scope}&limit=25`, { signal })).json() as { data: ExportScheduleRun[] };
  return payload.data;
}

export async function setExportScheduleStatus(scheduleId: string, action: ExportScheduleAction): Promise<ExportSchedule> {
  return (await (await send(`${ENDPOINT}/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: JSON.stringify({ action }) })).json() as { data: ExportSchedule }).data;
}

export async function setExportScheduleNotification(scheduleId: string, notifyOnCompletion: boolean): Promise<ExportSchedule> {
  return (await (await send(`${ENDPOINT}/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: JSON.stringify({ notifyOnCompletion }) })).json() as { data: ExportSchedule }).data;
}

export async function deleteExportSchedule(scheduleId: string): Promise<void> {
  await send(`${ENDPOINT}/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
}
