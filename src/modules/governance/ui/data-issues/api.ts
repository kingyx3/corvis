import type { DataIssueCase, DataIssuePage, DataIssueStatus, ReportDataIssueCommand } from "@/modules/governance/domain/data-issue";
import { apiUrl } from "@/shared/lib/api-url";
import { apiResponseError, friendlyErrorMessage } from "@/shared/lib/api-errors";
import { downloadText } from "@/shared/lib/download";
import { workspaceContextHeaders } from "@/shared/lib/workspace-context";

const ENDPOINT = "/api/v1/data-issues";

export type DataIssueListResult = DataIssuePage & { unseenUpdateCount: number };
export type DataIssueScopeChoice = "mine" | "all";

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

/** Plain-language copy for the stable error codes the data-issue routes return; anything else gets `fallback`. */
export function dataIssueErrorMessage(reason: unknown, fallback: string): string {
  const code = (reason as { code?: unknown } | null)?.code;
  const known: Record<string, string> = {
    fund_not_entitled: "You no longer have access to this fund, so it cannot be reported on.",
    data_issue_report_conflict: "This report is already being submitted. Wait a moment and check your reports.",
    idempotency_key_reused: "A different report was already sent with this reference. Close this dialog and start again.",
    invalid_comment: "Describe what looks wrong in 1 to 2,000 characters.",
    invalid_scope: "This figure can no longer be identified. Refresh the page and try again.",
    data_issue_snapshot_not_found: "This figure is no longer available to report on. Refresh the page and try again.",
    data_issue_not_found: "This report is no longer available to you.",
  };
  return typeof code === "string" && known[code] ? known[code]! : friendlyErrorMessage(reason, fallback);
}

export async function reportDataIssue(command: ReportDataIssueCommand): Promise<{ item: DataIssueCase; replayed: boolean }> {
  const payload = await (await send(ENDPOINT, { method: "POST", body: JSON.stringify(command) })).json() as { data: DataIssueCase; replayed: boolean };
  return { item: payload.data, replayed: payload.replayed };
}

export async function listDataIssues(query: { scope: DataIssueScopeChoice; status?: DataIssueStatus; limit?: number; cursor?: string | null }, signal?: AbortSignal): Promise<DataIssueListResult> {
  const params = new URLSearchParams({ scope: query.scope, limit: String(query.limit ?? 50) });
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  const payload = await (await send(`${ENDPOINT}?${params}`, { signal })).json() as { data: DataIssueCase[]; nextCursor: string | null; unseenUpdateCount: number };
  return { items: payload.data, nextCursor: payload.nextCursor, unseenUpdateCount: payload.unseenUpdateCount };
}

/** How many of the caller's own reports changed status since they last looked (the sidebar indicator). */
export async function unseenDataIssueUpdates(signal?: AbortSignal): Promise<number> {
  return (await listDataIssues({ scope: "mine", limit: 1 }, signal)).unseenUpdateCount;
}

export async function getDataIssue(caseId: string): Promise<DataIssueCase> {
  return (await (await send(`${ENDPOINT}/${encodeURIComponent(caseId)}`)).json() as { data: DataIssueCase }).data;
}

export async function acknowledgeDataIssue(caseId: string): Promise<DataIssueCase> {
  return (await (await send(`${ENDPOINT}/${encodeURIComponent(caseId)}`, { method: "PATCH", body: JSON.stringify({ seen: true }) })).json() as { data: DataIssueCase }).data;
}

/** Downloads every report the caller may list as a file for their own records. */
export async function exportDataIssues(format: "csv" | "json", scope: DataIssueScopeChoice): Promise<void> {
  const text = await (await send(`${ENDPOINT}?format=${format}&scope=${scope}`)).text();
  downloadText(`corvis-data-issues.${format}`, text, format === "csv" ? "text/csv;charset=utf-8" : "application/json");
}
