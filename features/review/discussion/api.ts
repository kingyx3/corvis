import {
  REVIEW_DISCUSSION_ERROR_MESSAGES,
  type AddReviewCommentCommand,
  type AssignReviewItemCommand,
  type AssignedReviewItem,
  type ReviewComment,
  type ReviewSubjectRef,
  type ReviewThread,
  type ReviewThreadSummary,
} from "@/core/review-discussion";
import { apiUrl } from "@/lib/api-url";
import { apiResponseError, friendlyErrorMessage } from "@/lib/api-errors";
import { workspaceContextHeaders } from "@/lib/workspace-context";

const ENDPOINT = "/api/v1/review-items";
/** Far beyond any realistic number of assigned or discussed items, and a ceiling on one load. */
const MAX_PAGES = 50;

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

const itemPath = (ref: ReviewSubjectRef) => `${ENDPOINT}/${encodeURIComponent(ref.subjectKind)}/${encodeURIComponent(ref.subjectId)}`;

/** Plain-language copy for the stable error codes the review-item routes return; anything else gets `fallback`. */
export function reviewDiscussionErrorMessage(reason: unknown, fallback: string): string {
  const code = (reason as { code?: unknown } | null)?.code;
  return typeof code === "string" && REVIEW_DISCUSSION_ERROR_MESSAGES[code] ? REVIEW_DISCUSSION_ERROR_MESSAGES[code]! : friendlyErrorMessage(reason, fallback);
}

/** Every review item in the workspace that has an assignee or a discussion (paged under the hood). */
export async function listReviewThreads(signal?: AbortSignal): Promise<ReviewThreadSummary[]> {
  const items: ReviewThreadSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const payload = await (await send(`${ENDPOINT}?${params}`, { signal })).json() as { data: ReviewThreadSummary[]; nextCursor: string | null };
    items.push(...payload.data);
    cursor = payload.nextCursor;
    if (cursor === null) return items;
  }
  return items;
}

export async function getReviewThread(ref: ReviewSubjectRef, signal?: AbortSignal): Promise<ReviewThread> {
  return (await (await send(itemPath(ref), { signal })).json() as { data: ReviewThread }).data;
}

export async function assignReviewItem(ref: ReviewSubjectRef, command: AssignReviewItemCommand): Promise<ReviewThreadSummary> {
  return (await (await send(`${itemPath(ref)}/assignee`, { method: "PUT", body: JSON.stringify(command) })).json() as { data: ReviewThreadSummary }).data;
}

export async function commentOnReviewItem(ref: ReviewSubjectRef, command: AddReviewCommentCommand): Promise<{ comment: ReviewComment; thread: ReviewThreadSummary }> {
  const payload = await (await send(`${itemPath(ref)}/comments`, { method: "POST", body: JSON.stringify(command) })).json() as { data: ReviewComment; thread: ReviewThreadSummary };
  return { comment: payload.data, thread: payload.thread };
}

/** The caller's own open assignments, for the Overview attention list. */
export async function listAssignedReviewItems(signal?: AbortSignal): Promise<AssignedReviewItem[]> {
  return (await (await send(`${ENDPOINT}/assigned`, { signal })).json() as { data: AssignedReviewItem[] }).data;
}
