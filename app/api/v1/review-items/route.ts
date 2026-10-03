import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { correlationId, json } from "@/lib/server/http";
import { parseLimit } from "@/lib/server/pagination";
import { reviewDiscussionErrorResponse } from "@/lib/server/review-discussion-http";
import { reviewDiscussionService } from "@/lib/server/review-discussion-service";

/**
 * Review items (F3) that have an assignee or a discussion in the caller's workspace, with who holds each and how many
 * comments it has, so Data review can show the assignee on a row and filter by it. Items the caller cannot read in Data
 * review are never listed. Discussion records a conversation only: it never changes data or a review decision.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const params = new URL(request.url).searchParams;
    const page = await reviewDiscussionService().listThreads(identity, { limit: parseLimit(params.get("limit")), cursor: params.get("cursor") });
    return json({ data: page.items, nextCursor: page.nextCursor, correlationId: id });
  } catch (error) { return reviewDiscussionErrorResponse(error, id); }
}
