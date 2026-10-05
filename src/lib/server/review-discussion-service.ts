import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  reviewAssignmentAction,
  type AddReviewCommentCommand,
  type AssignReviewItemCommand,
  type AssignedReviewItem,
  type ReviewComment,
  type ReviewSubjectRef,
  type ReviewThread,
  type ReviewThreadPage,
  type ReviewThreadSummary,
} from "../../core/review-discussion.ts";
import { demoReviewDiscussionStore } from "../../adapters/demo/review-discussion-store.ts";
import { runAuditedMutation } from "./audited-mutation.ts";
import { getServerConfig } from "./config.ts";
import { postgres } from "./postgres.ts";
import {
  PostgresReviewDiscussionBackend,
  assertHumanIdentity,
  reviewDiscussionAuditEvent,
  type ReviewDiscussionBackend,
  type ReviewThreadQuery,
} from "./review-discussion.ts";

/**
 * The operations behind `/api/v1/review-items/**`, over either backend (Postgres, or the in-memory demo store in demo
 * mode). Authorization that does not depend on where threads are stored lives here, once: discussion is for signed-in
 * people. The route has already required `observations:review`. Mutations run through `runAuditedMutation`, so the
 * command and its audit event commit together. Nothing here can change an observation, record a review decision or
 * resolve an exception: those stay with `/review`, `/extraction-review` and `/reconciliation-exceptions/resolve`.
 */
export interface ReviewDiscussionService {
  listThreads(identity: RequestIdentity, query: ReviewThreadQuery): Promise<ReviewThreadPage>;
  getThread(identity: RequestIdentity, ref: ReviewSubjectRef): Promise<ReviewThread>;
  /** Assign, reassign or unassign. A command that changes nothing is not audited and notifies nobody. */
  assign(identity: RequestIdentity, ref: ReviewSubjectRef, command: AssignReviewItemCommand, correlationId: string): Promise<ReviewThreadSummary>;
  /** Append a comment. A replay of a recorded comment answers with it and is not audited again. */
  comment(identity: RequestIdentity, ref: ReviewSubjectRef, command: AddReviewCommentCommand, correlationId: string): Promise<{ comment: ReviewComment; created: boolean; thread: ReviewThreadSummary }>;
  assignedToMe(identity: RequestIdentity): Promise<AssignedReviewItem[]>;
}

export function createReviewDiscussionService(backend: ReviewDiscussionBackend): ReviewDiscussionService {
  return {
    async listThreads(identity, query) {
      assertHumanIdentity(identity);
      return backend.listThreads(identity, query);
    },
    async getThread(identity, ref) {
      assertHumanIdentity(identity);
      return backend.getThread(identity, ref);
    },
    async assign(identity, ref, command, correlationId) {
      assertHumanIdentity(identity);
      const outcome = await runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.assign(identity, ref, command, db),
        audit: ({ thread, change }) => change === null ? undefined : reviewDiscussionAuditEvent(
          identity, correlationId, `review_item.${reviewAssignmentAction(change.previousAssigneeUserId, thread.assignee?.userId ?? null)}`, ref,
          { fundId: change.fundId, assigneeUserId: thread.assignee?.userId ?? null, previousAssigneeUserId: change.previousAssigneeUserId, version: thread.version },
        ),
      });
      return outcome.thread;
    },
    async comment(identity, ref, command, correlationId) {
      assertHumanIdentity(identity);
      const outcome = await runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.comment(identity, ref, command, db),
        // A replayed comment changed nothing, so it needs no second audit event. The text is never audited: ids and counts only.
        audit: ({ comment, created, fundId }) => created ? reviewDiscussionAuditEvent(
          identity, correlationId, "review_item.comment", ref,
          { fundId, commentId: comment.commentId, mentionedUserIds: comment.mentions.map((mention) => mention.userId), commentLength: comment.body.length },
        ) : undefined,
      });
      return { comment: outcome.comment, created: outcome.created, thread: outcome.thread };
    },
    async assignedToMe(identity) {
      assertHumanIdentity(identity);
      return backend.assignedToMe(identity);
    },
  };
}

export const postgresReviewDiscussionService: ReviewDiscussionService = createReviewDiscussionService(new PostgresReviewDiscussionBackend(() => postgres(getServerConfig().postgresDsn)));
export const demoReviewDiscussionService: ReviewDiscussionService = createReviewDiscussionService(demoReviewDiscussionStore());

let override: ReviewDiscussionService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideReviewDiscussionService(service?: ReviewDiscussionService): void { override = service; }

export function reviewDiscussionService(): ReviewDiscussionService {
  return override ?? (getServerConfig().demoMode ? demoReviewDiscussionService : postgresReviewDiscussionService);
}
