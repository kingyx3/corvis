import type { DeletionRequestView, RetentionView } from "@/modules/governance/domain/data-retention";
import type { TenantExportDownload, TenantExportPage, TenantExportRequest } from "@/modules/delivery/domain/tenant-export";
import { apiUrl } from "@/shared/lib/api-url";
import { apiResponseError, friendlyErrorMessage } from "@/shared/lib/api-errors";
import { workspaceContextHeaders } from "@/shared/lib/workspace-context";

const RETENTION = "/api/v1/access/retention";
const EXPORTS = "/api/v1/access/data-exports";
const DELETIONS = "/api/v1/access/deletion-requests";

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

/** Plain-language copy for the stable error codes the retention and export routes return; anything else gets `fallback`. */
export function dataGovernanceErrorMessage(reason: unknown, fallback: string): string {
  const code = (reason as { code?: unknown } | null)?.code;
  const known: Record<string, string> = {
    tenant_admin_required: "Only an Organization Admin can do this.",
    invalid_reason: "Say why, in 3 to 1,000 characters.",
    invalid_data_classes: "Choose at least one kind of data your organization has a retention policy for.",
    invalid_note: "Add a short note (up to 1,000 characters) explaining the decision.",
    data_export_already_active: "Another export request is already open. Finish or withdraw it before starting a new one.",
    data_export_independent_approver_required: "A different Organization Admin must approve or reject this request. You cannot decide your own request.",
    data_export_cancel_requester_only: "Only the person who made the request can withdraw it.",
    data_export_approval_expired: "The approval window has passed. Make a new request if you still need the export.",
    data_export_status_changed: "This request changed while you were looking at it. The list has been refreshed.",
    data_export_transition_not_allowed: "This request can no longer be changed.",
    data_export_not_found: "This request is no longer available.",
    data_export_not_available: "This export is no longer available to download. Make a new request if you still need it.",
    data_export_rights_changed: "Your data rights have changed since this export was built, so it can no longer be downloaded. Make a new request.",
    deletion_blocked_by_legal_hold: "A legal hold applies to some of this data, so it cannot be deleted while the hold lasts. Contact Corvis support if you think this is a mistake.",
    deletion_request_already_pending: "Another deletion request is waiting for approval. Finish or withdraw it before starting a new one.",
    deletion_independent_approver_required: "A different Organization Admin must approve or reject this request. You cannot decide your own request.",
    deletion_cancel_requester_only: "Only the person who made the request can withdraw it.",
    deletion_approval_expired: "The approval window has passed. Make a new request if you still need the deletion.",
    deletion_status_changed: "This request changed while you were looking at it. The list has been refreshed.",
    deletion_transition_not_allowed: "This request can no longer be changed.",
    deletion_request_not_found: "This request is no longer available.",
  };
  return typeof code === "string" && known[code] ? known[code]! : friendlyErrorMessage(reason, fallback);
}

export async function getRetention(signal?: AbortSignal): Promise<RetentionView> {
  return (await (await send(RETENTION, { signal })).json() as { data: RetentionView }).data;
}

/** One page of requests, newest first. Pass the previous page's `nextCursor` to read the next (older) page. */
export async function listDataExports(options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}): Promise<TenantExportPage> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor) query.set("cursor", options.cursor);
  const body = await (await send(query.size > 0 ? `${EXPORTS}?${query}` : EXPORTS, { signal: options.signal })).json() as { data: TenantExportRequest[]; nextCursor?: string | null };
  return { items: body.data, nextCursor: body.nextCursor ?? null };
}

export async function getDataExport(requestId: string): Promise<TenantExportRequest> {
  return (await (await send(`${EXPORTS}/${encodeURIComponent(requestId)}`)).json() as { data: TenantExportRequest }).data;
}

export async function requestDataExport(reason: string): Promise<TenantExportRequest> {
  return (await (await send(EXPORTS, { method: "POST", body: JSON.stringify({ reason }) })).json() as { data: TenantExportRequest }).data;
}

export async function decideDataExport(requestId: string, action: "approve" | "reject" | "cancel", options: { note?: string; expectedStatus?: string } = {}): Promise<TenantExportRequest> {
  const body = JSON.stringify({ action, ...options });
  return (await (await send(`${EXPORTS}/${encodeURIComponent(requestId)}`, { method: "POST", body })).json() as { data: TenantExportRequest }).data;
}

/** Issues a fresh single-use link; the caller navigates to it (the response is a file, not JSON). */
export async function prepareDataExportDownload(requestId: string): Promise<TenantExportDownload> {
  return (await (await send(`${EXPORTS}/${encodeURIComponent(requestId)}`, { method: "POST", body: JSON.stringify({ action: "prepare_download" }) })).json() as { data: TenantExportDownload }).data;
}

/** Asks for deletion of whole data classes. A different Organization Admin must approve it before Corvis acts on it. */
export async function requestDeletion(dataClasses: string[], reason: string): Promise<DeletionRequestView> {
  return (await (await send(DELETIONS, { method: "POST", body: JSON.stringify({ dataClasses, reason }) })).json() as { data: DeletionRequestView }).data;
}

export async function decideDeletion(requestId: string, action: "approve" | "reject" | "cancel", options: { note?: string; expectedStatus?: string } = {}): Promise<DeletionRequestView> {
  const body = JSON.stringify({ action, ...options });
  return (await (await send(`${DELETIONS}/${encodeURIComponent(requestId)}`, { method: "POST", body })).json() as { data: DeletionRequestView }).data;
}
