import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { correlationId, json } from "@/lib/server/http";
import { reviewDiscussionErrorResponse } from "@/lib/server/review-discussion-http";
import { reviewDiscussionService } from "@/lib/server/review-discussion-service";

/**
 * The caller's own open assignments (observations still needing review, exceptions still open), blocking exceptions
 * first, for the Overview attention list's "Assigned to me" view. Work that has since been decided is not listed.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    return json({ data: await reviewDiscussionService().assignedToMe(identity), correlationId: id });
  } catch (error) { return reviewDiscussionErrorResponse(error, id); }
}
