import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  MAX_REVIEW_COMMENTS_PER_THREAD,
  assignedExceptionItem,
  assignedObservationItem,
  reviewItemKey,
  reviewRoleLabel,
  sortAssignedItems,
  type AddReviewCommentCommand,
  type AssignReviewItemCommand,
  type AssignedReviewItem,
  type ReviewComment,
  type ReviewMember,
  type ReviewPerson,
  type ReviewSubjectKind,
  type ReviewSubjectRef,
  type ReviewThread,
  type ReviewThreadPage,
  type ReviewThreadSummary,
} from "../domain/review-discussion.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../../../platform/http/pagination.ts";
import {
  ReviewDiscussionRequestError,
  commentFingerprint,
  type AssignOutcome,
  type CommentOutcome,
  type ReviewDiscussionBackend,
  type ReviewThreadQuery,
} from "../server/review-discussion.ts";
import { fundSnapshots, observations } from "../../../platform/demo/catalog.ts";

/**
 * In-memory review-item threads for demo mode and the browser suites; not production evidence. Each demo tenant and
 * workspace gets its own threads, so a test that pins its own tenant never sees another's. There are no seeded threads:
 * an assignment or a comment is something the person does, and nothing about the demo's observations or exceptions
 * changes (a thread only ever records who owns an item and what was said about it, exactly as in Postgres).
 *
 * The demo has no real membership, so its people are fixed: the signed-in demo person plus two review teammates. They
 * stand in for "workspace members with review access" and are the only people who can be assigned or mentioned.
 */

/** What the demo knows about a review item: enough to resolve a thread and to describe an open assignment. */
export type DemoSubject = {
  fundId: string;
  fundLabel: string;
  period: string;
  snapshotId?: string;
  company?: string;
  metric?: string;
  summary?: string;
  type?: string;
  /** Still needs a decision: an observation awaiting review, an exception that is still open. */
  open: boolean;
};
export type DemoSubjectResolver = (ref: ReviewSubjectRef) => DemoSubject | undefined;

/**
 * The reconciliation exception the customer demo shows on the in-review Nordic Capital snapshot
 * (src/platform/demo/customer-journey-store.ts `listReconciliationExceptions`). A test keeps the two in step.
 */
export const DEMO_EXCEPTIONS: ReadonlyMap<string, DemoSubject> = new Map([
  ["demo-source-authority", {
    fundId: "fund-nordic-v", fundLabel: "Nordic Capital Fund V", period: "Q2 2026", snapshotId: "seed-snapshot-2",
    summary: "Northstar Health fair value differs between source reports", type: "source_authority", open: true,
  }],
]);

/** Observations uploaded during a demo session get a client-generated `obs_xxxxxxxx` id; they are reviewable like any other. */
const UPLOADED_OBSERVATION = /^obs_[0-9a-f]{8}$/;

export const demoSubjectResolver: DemoSubjectResolver = (ref) => {
  if (ref.subjectKind === "reconciliation_exception") return DEMO_EXCEPTIONS.get(ref.subjectId);
  const known = observations.find((row) => row.id === ref.subjectId);
  if (known) {
    return {
      fundId: known.fundId ?? "fund-demo", fundLabel: known.fund ?? "Demo fund", period: known.period,
      snapshotId: known.snapshotId ?? fundSnapshots.find((snapshot) => snapshot.fund === known.fund)?.id,
      company: known.company, metric: known.metric, open: known.state === "Needs review",
    };
  }
  return UPLOADED_OBSERVATION.test(ref.subjectId)
    ? { fundId: "fund-demo-upload", fundLabel: "Uploaded fund", period: "Current period", company: "Uploaded fund", metric: "Review item", open: true }
    : undefined;
};

type Teammate = { userId: string; displayName: string; roleLabel: string };
const TEAMMATES: Teammate[] = [
  { userId: "demo-member-priya", displayName: "priya.nair@example.test", roleLabel: "Review Analyst" },
  { userId: "demo-member-marcus", displayName: "marcus.chen@example.test", roleLabel: "Review Analyst" },
];

/** A demo person who signs in as one of the teammates is that teammate; anyone else gets an id of their own. */
export function demoMemberId(subject: string): string {
  return TEAMMATES.find((member) => member.displayName === subject)?.userId ?? `demo-self-${subject.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100)}`;
}

type StoredComment = { comment: ReviewComment; authorUserId: string; mentionUserIds: string[]; key: string; fingerprint: string };
type Thread = {
  ref: ReviewSubjectRef;
  assigneeUserId: string | null;
  assignedAt: string | null;
  version: number;
  comments: StoredComment[];
};
type Workspace = { threads: Map<string, Thread> };

export class DemoReviewDiscussionStore implements ReviewDiscussionBackend {
  readonly demo = true;
  private readonly workspaces = new Map<string, Workspace>();
  private readonly now: () => Date;
  private readonly resolve: DemoSubjectResolver;

  constructor(now: () => Date = () => new Date(), resolve: DemoSubjectResolver = demoSubjectResolver) {
    this.now = now;
    this.resolve = resolve;
  }

  private workspace(identity: RequestIdentity): Workspace {
    const key = `${identity.tenantId}|${identity.workspaceId}`;
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      workspace = { threads: new Map() };
      this.workspaces.set(key, workspace);
    }
    return workspace;
  }

  /** The demo person plus the two teammates: everyone who can be assigned or mentioned. */
  private roster(identity: RequestIdentity): Array<Teammate & { isMe: boolean }> {
    const meId = demoMemberId(identity.subject);
    const self: Teammate = {
      userId: meId, displayName: identity.authenticatedEmail ?? identity.subject,
      roleLabel: reviewRoleLabel(identity.isTenantAdmin ? ["tenant_admin"] : identity.roles.includes("admin") ? ["accountadmin"] : ["reviewer"]),
    };
    const others = TEAMMATES.filter((member) => member.userId !== meId);
    return [self, ...others].map((member) => ({ ...member, isMe: member.userId === meId }));
  }

  private person(identity: RequestIdentity, userId: string): ReviewPerson {
    const member = this.roster(identity).find((candidate) => candidate.userId === userId);
    return { userId, displayName: member?.displayName ?? "Former member", isMe: member?.isMe ?? false };
  }

  private subject(ref: ReviewSubjectRef): DemoSubject {
    const subject = this.resolve(ref);
    if (!subject) throw new ReviewDiscussionRequestError("review_item_not_found", 404);
    return subject;
  }

  private summary(identity: RequestIdentity, thread: Thread | undefined, ref: ReviewSubjectRef): ReviewThreadSummary {
    if (!thread) return { ...ref, assignee: null, assignedAt: null, version: 0, commentCount: 0, lastCommentAt: null };
    return {
      ...ref,
      assignee: thread.assigneeUserId === null ? null : this.person(identity, thread.assigneeUserId),
      assignedAt: thread.assignedAt,
      version: thread.version,
      commentCount: thread.comments.length,
      lastCommentAt: thread.comments[thread.comments.length - 1]?.comment.createdAt ?? null,
    };
  }

  private thread(identity: RequestIdentity, ref: ReviewSubjectRef): Thread {
    const workspace = this.workspace(identity);
    const key = reviewItemKey(ref);
    let thread = workspace.threads.get(key);
    if (!thread) {
      thread = { ref: { ...ref }, assigneeUserId: null, assignedAt: null, version: 0, comments: [] };
      workspace.threads.set(key, thread);
    }
    return thread;
  }

  async listThreads(identity: RequestIdentity, query: ReviewThreadQuery): Promise<ReviewThreadPage> {
    const after = query.cursor ? this.decode(query.cursor) : null;
    const matching = [...this.workspace(identity).threads.values()]
      .filter((thread) => (thread.assigneeUserId !== null || thread.comments.length > 0) && this.resolve(thread.ref) !== undefined)
      .sort((a, b) => reviewItemKey(a.ref).localeCompare(reviewItemKey(b.ref)));
    const start = after ? matching.findIndex((thread) => reviewItemKey(thread.ref) === after) + 1 : 0;
    const page = matching.slice(start, start + query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((thread) => this.summary(identity, thread, thread.ref)),
      nextCursor: last && start + query.limit < matching.length ? encodeCursor(reviewItemKey(last.ref)) : null,
    };
  }

  private decode(cursor: string): string {
    const key = decodeCursor(cursor);
    const kind = key.split(":")[0];
    if (kind !== "observation" && kind !== "reconciliation_exception") throw new InvalidCursorError();
    return key;
  }

  async getThread(identity: RequestIdentity, ref: ReviewSubjectRef): Promise<ReviewThread> {
    this.subject(ref);
    const thread = this.workspace(identity).threads.get(reviewItemKey(ref));
    const members: ReviewMember[] = this.roster(identity).map(({ userId, displayName, roleLabel, isMe }) => ({ userId, displayName, roleLabel, isMe }));
    return {
      ...this.summary(identity, thread, ref),
      comments: (thread?.comments ?? []).map((stored) => ({ ...stored.comment, mentions: stored.mentionUserIds.map((userId) => this.person(identity, userId)), author: this.person(identity, stored.authorUserId) })),
      members,
    };
  }

  async assign(identity: RequestIdentity, ref: ReviewSubjectRef, command: AssignReviewItemCommand): Promise<AssignOutcome> {
    const subject = this.subject(ref);
    if (command.assigneeUserId !== null && !this.roster(identity).some((member) => member.userId === command.assigneeUserId)) {
      throw new ReviewDiscussionRequestError("assignee_not_eligible", 422);
    }
    const existing = this.workspace(identity).threads.get(reviewItemKey(ref));
    if (command.expectedVersion !== (existing?.version ?? 0)) throw new ReviewDiscussionRequestError("assignment_changed", 409);
    const thread = this.thread(identity, ref);
    if (thread.assigneeUserId === command.assigneeUserId) return { thread: this.summary(identity, thread, ref), change: null };
    const previousAssigneeUserId = thread.assigneeUserId;
    thread.assigneeUserId = command.assigneeUserId;
    thread.assignedAt = command.assigneeUserId === null ? null : this.now().toISOString();
    thread.version += 1;
    return { thread: this.summary(identity, thread, ref), change: { previousAssigneeUserId, fundId: subject.fundId } };
  }

  async comment(identity: RequestIdentity, ref: ReviewSubjectRef, command: AddReviewCommentCommand): Promise<CommentOutcome> {
    const subject = this.subject(ref);
    const authorUserId = demoMemberId(identity.subject);
    const fingerprint = commentFingerprint(ref, command);
    // Keys are scoped to the author across the workspace, as in Postgres: the same key and content is a replay, any other use is refused.
    for (const existing of this.workspace(identity).threads.values()) {
      const replay = existing.comments.find((stored) => stored.authorUserId === authorUserId && stored.key === command.idempotencyKey);
      if (!replay) continue;
      if (replay.fingerprint !== fingerprint) throw new ReviewDiscussionRequestError("idempotency_key_reused", 409);
      return {
        comment: { ...replay.comment, author: this.person(identity, authorUserId), mentions: replay.mentionUserIds.map((userId) => this.person(identity, userId)) },
        created: false, thread: this.summary(identity, existing, ref), fundId: subject.fundId,
      };
    }
    const roster = this.roster(identity);
    if (command.mentionUserIds.some((userId) => !roster.some((member) => member.userId === userId))) throw new ReviewDiscussionRequestError("mention_not_eligible", 422);
    const thread = this.thread(identity, ref);
    if (thread.comments.length >= MAX_REVIEW_COMMENTS_PER_THREAD) throw new ReviewDiscussionRequestError("review_comment_limit_reached", 409);
    const comment: ReviewComment = {
      commentId: randomUUID(), author: this.person(identity, authorUserId), body: command.body,
      mentions: command.mentionUserIds.map((userId) => this.person(identity, userId)), createdAt: this.now().toISOString(),
    };
    thread.comments.push({ comment, authorUserId, mentionUserIds: [...command.mentionUserIds], key: command.idempotencyKey, fingerprint });
    return { comment, created: true, thread: this.summary(identity, thread, ref), fundId: subject.fundId };
  }

  async assignedToMe(identity: RequestIdentity): Promise<AssignedReviewItem[]> {
    const meId = demoMemberId(identity.subject);
    const items: AssignedReviewItem[] = [];
    for (const thread of this.workspace(identity).threads.values()) {
      const subject = thread.assigneeUserId === meId ? this.resolve(thread.ref) : undefined;
      if (!subject || !subject.open) continue;
      const ref = { subjectId: thread.ref.subjectId, assignedAt: thread.assignedAt, snapshotId: subject.snapshotId };
      const kind: ReviewSubjectKind = thread.ref.subjectKind;
      items.push(kind === "observation"
        ? assignedObservationItem(ref, { company: subject.company, metric: subject.metric, fund: subject.fundLabel, period: subject.period })
        : assignedExceptionItem(ref, { summary: subject.summary, type: subject.type, fund: subject.fundLabel, period: subject.period }));
    }
    return sortAssignedItems(items);
  }
}

let singleton: DemoReviewDiscussionStore | undefined;
export function demoReviewDiscussionStore(): DemoReviewDiscussionStore {
  if (!singleton) singleton = new DemoReviewDiscussionStore();
  return singleton;
}
