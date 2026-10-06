import { assertPermission } from "@/shared/domain/enterprise";
import { ReviewDiscussionValidationError, parseAssignCommand, parseSubjectRef } from "@/modules/review/domain/review-discussion";
import { readJsonObject } from "@/modules/identity-access/server/request/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/modules/identity-access/server/request/authorized-request";
import { correlationId, json } from "@/platform/http/api/http";
import { reviewDiscussionErrorResponse } from "@/modules/review/server/review-discussion-http";
import { reviewDiscussionService } from "@/modules/review/server/review-discussion-service";

type Context = { params: Promise<{ subjectKind: string; subjectId: string }> };

/**
 * Assigns, reassigns or unassigns a review item: `{ "assigneeUserId": "<member>" | null, "expectedVersion": <n> }`.
 * `expectedVersion` is the thread version the caller saw (0 when it had none); a stale one is `409 assignment_changed`
 * instead of silently overwriting a newer assignment. The assignee must be a workspace member with review access to the
 * item's fund (`422 assignee_not_eligible`). Assigning the person who already holds the item changes nothing. This is not
 * a review decision: the item's state, value and dual-control record are untouched.
 */
export async function PUT(request: Request, context: Context) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const body = await readJsonObject(request);
    if (!body) throw new ReviewDiscussionValidationError("invalid_request");
    const { subjectKind, subjectId } = await context.params;
    const thread = await reviewDiscussionService().assign(identity, parseSubjectRef(subjectKind, subjectId), parseAssignCommand(body), id);
    return json({ data: thread, correlationId: id });
  } catch (error) { return reviewDiscussionErrorResponse(error, id); }
}
