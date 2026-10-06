import { assertPermission } from "@/shared/domain/enterprise";
import { ReviewDiscussionValidationError, parseCommentCommand, parseSubjectRef } from "@/modules/review/domain/review-discussion";
import { readJsonObject } from "@/platform/http/identity/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { correlationId, json } from "@/platform/http/api/http";
import { reviewDiscussionErrorResponse } from "@/modules/review/server/review-discussion-http";
import { reviewDiscussionService } from "@/modules/review/server/review-discussion-service";

type Context = { params: Promise<{ subjectKind: string; subjectId: string }> };

/**
 * Appends a comment: `{ "idempotencyKey": "...", "body": "...", "mentionUserIds": ["<member>", ...] }` (the key may be the
 * `Idempotency-Key` header instead). Comments are append-only: there is no edit or delete. Each mentioned person must be a
 * workspace member with review access to the item's fund (`422 mention_not_eligible`) and is notified (category
 * `review_discussion`) without any comment text. A replay answers `200` with the original comment. A comment never changes
 * data, records a review decision or counts toward dual control.
 */
export async function POST(request: Request, context: Context) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const body = await readJsonObject(request);
    if (!body) throw new ReviewDiscussionValidationError("invalid_request");
    const { subjectKind, subjectId } = await context.params;
    const command = parseCommentCommand(body, request.headers.get("idempotency-key"));
    const { comment, created, thread } = await reviewDiscussionService().comment(identity, parseSubjectRef(subjectKind, subjectId), command, id);
    return json({ data: comment, thread, replayed: !created, correlationId: id }, { status: created ? 201 : 200 });
  } catch (error) { return reviewDiscussionErrorResponse(error, id); }
}
