import { ReviewDiscussionValidationError } from "../domain/review-discussion.ts";
import { apiError, json } from "../../../platform/http/http.ts";
import { ReviewDiscussionRequestError } from "./review-discussion.ts";

/** Typed review-discussion failures keep their stable code and status; everything else goes through the shared API error mapper. */
export function reviewDiscussionErrorResponse(error: unknown, correlationId: string): Response {
  if (error instanceof ReviewDiscussionValidationError || error instanceof ReviewDiscussionRequestError) {
    return json({ error: error.code, correlationId }, { status: error.status });
  }
  return apiError(error, correlationId);
}
