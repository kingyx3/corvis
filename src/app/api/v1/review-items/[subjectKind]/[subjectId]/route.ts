import { assertPermission } from "@/core/enterprise";
import { parseSubjectRef } from "@/core/review-discussion";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { correlationId, json } from "@/lib/server/http";
import { reviewDiscussionErrorResponse } from "@/lib/server/review-discussion-http";
import { reviewDiscussionService } from "@/lib/server/review-discussion-service";

type Context = { params: Promise<{ subjectKind: string; subjectId: string }> };

/**
 * One review item's thread: its assignee, its comments oldest first (at most 200) and everyone who may be assigned or
 * mentioned on it (review access to its fund in this workspace). An item the caller cannot read in Data review, a missing
 * one and a malformed id all answer the same 404, so existence is not leaked.
 */
export async function GET(request: Request, context: Context) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const { subjectKind, subjectId } = await context.params;
    return json({ data: await reviewDiscussionService().getThread(identity, parseSubjectRef(subjectKind, subjectId)), correlationId: id });
  } catch (error) { return reviewDiscussionErrorResponse(error, id); }
}
