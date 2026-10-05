import { createHash, randomUUID } from "node:crypto";
import type { AuditEvent, RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  REVIEW_ROLES,
  assignedExceptionItem,
  assignedObservationItem,
  reviewRoleLabel,
  sortAssignedItems,
  type AddReviewCommentCommand,
  type AssignReviewItemCommand,
  type AssignedReviewItem,
  type ReviewAssignmentAction,
  type ReviewComment,
  type ReviewMember,
  type ReviewPerson,
  type ReviewSubjectRef,
  type ReviewThread,
  type ReviewThreadPage,
  type ReviewThreadSummary,
} from "../domain/review-discussion.ts";
import { bestEffortNotification, enqueueForUser } from "../../notifications/server/notifications.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../../../platform/http/pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";

/**
 * Assigning and discussing review items (F3, #259), Postgres side. A thread only ever writes
 * `corvis_control.review_item_thread` and `review_item_comment` (migration 086): it cannot change observations, review
 * events, reconciliation resolutions or publication, which stay with the existing review routes, and a comment is never
 * read when dual control is decided. Whether a person may open a thread, be assigned or be mentioned is decided in SQL
 * (`resolve_review_subject`, `review_member_eligible`) from the same entitlements the review lists apply.
 */

export type ReviewThreadQuery = { limit: number; cursor?: string | null };

export type AssignOutcome = {
  thread: ReviewThreadSummary;
  /** Null when the command changed nothing (the item already had that assignee). */
  change: { previousAssigneeUserId: string | null; fundId: string } | null;
};

export type CommentOutcome = {
  comment: ReviewComment;
  /** False for an idempotent replay of a comment that was already recorded. */
  created: boolean;
  thread: ReviewThreadSummary;
  fundId: string;
};

/** Where threads live. Postgres in production, an in-memory store in demo mode; both enforce the same rules. */
export interface ReviewDiscussionBackend {
  readonly demo: boolean;
  listThreads(identity: RequestIdentity, query: ReviewThreadQuery, db?: PostgresSqlApi): Promise<ReviewThreadPage>;
  getThread(identity: RequestIdentity, ref: ReviewSubjectRef, db?: PostgresSqlApi): Promise<ReviewThread>;
  assign(identity: RequestIdentity, ref: ReviewSubjectRef, command: AssignReviewItemCommand, db?: PostgresSqlApi): Promise<AssignOutcome>;
  comment(identity: RequestIdentity, ref: ReviewSubjectRef, command: AddReviewCommentCommand, db?: PostgresSqlApi): Promise<CommentOutcome>;
  /** The caller's own open assignments, for the Overview attention list. */
  assignedToMe(identity: RequestIdentity, db?: PostgresSqlApi): Promise<AssignedReviewItem[]>;
}

/** A request the caller is not allowed to make (403), names no visible item (404) or lost a race and can retry (409). */
export class ReviewDiscussionRequestError extends Error {
  readonly code: string;
  readonly status: 403 | 404 | 409 | 422;
  constructor(code: string, status: 403 | 404 | 409 | 422) {
    super(code);
    this.name = "ReviewDiscussionRequestError";
    this.code = code;
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean { return UUID.test(value); }

/** Assignments and discussion are for people: a signed-in human, or the demo person in demo mode. */
export function assertHumanIdentity(identity: RequestIdentity): void {
  if (identity.authMethod !== "oidc" && identity.authMethod !== "saml" && identity.authMethod !== "demo") {
    throw new ReviewDiscussionRequestError("human_identity_required", 403);
  }
}

/** Key-order independent fingerprint of a comment, so a reused idempotency key with different content is refused. */
export function commentFingerprint(ref: ReviewSubjectRef, command: AddReviewCommentCommand): string {
  const canonical = JSON.stringify([ref.subjectKind, ref.subjectId, command.body, [...command.mentionUserIds].sort()]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The audit event for an assignment or a comment. Identifiers and counts only: the comment text is user free text and is
 * never copied into the audit trail, an email or a notification.
 */
export function reviewDiscussionAuditEvent(
  identity: RequestIdentity,
  correlationId: string,
  action: `review_item.${ReviewAssignmentAction | "comment"}`,
  ref: ReviewSubjectRef,
  metadata: Record<string, unknown>,
): AuditEvent {
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType: "review_item", targetId: `${ref.subjectKind}:${ref.subjectId}`,
    outcome: "success", correlationId, metadata: { subjectKind: ref.subjectKind, subjectId: ref.subjectId, ...metadata },
  };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function str(row: PostgresRow, key: string): string { return String(row[key]); }
function optionalStr(row: PostgresRow, key: string): string | null { return row[key] == null ? null : String(row[key]); }
function idList(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
/** The ids among `values` that are present (a thread with nobody assigned has a null assignee). */
function presentIds(values: unknown[]): string[] { return values.filter((value) => value != null).map(String); }

/** Postgres timestamps arrive as text ("2026-10-01 10:00:00+00"); machine timestamps leave the server as ISO-8601 UTC. */
function isoOf(value: unknown): string | null {
  if (value == null) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

const FORMER_MEMBER = "Former member";

type Directory = { actorUserId: string; labels: Map<string, string> };

function person(directory: Directory, userId: string): ReviewPerson {
  return { userId, displayName: directory.labels.get(userId) ?? FORMER_MEMBER, isMe: userId === directory.actorUserId };
}

function toSummary(row: PostgresRow, directory: Directory): ReviewThreadSummary {
  const assigneeId = optionalStr(row, "assignee_user_id");
  return {
    subjectKind: str(row, "subject_kind") as ReviewSubjectRef["subjectKind"],
    subjectId: str(row, "subject_id"),
    assignee: assigneeId === null ? null : person(directory, assigneeId),
    assignedAt: assigneeId === null ? null : isoOf(row.assignment_changed_at),
    version: Number(row.version),
    commentCount: Number(row.comment_count),
    lastCommentAt: isoOf(row.last_comment_at),
  };
}

function toComment(row: PostgresRow, directory: Directory): ReviewComment {
  return {
    commentId: str(row, "comment_id"),
    author: person(directory, str(row, "author_user_id")),
    body: str(row, "body"),
    mentions: idList(row.mentioned_user_ids).map((userId) => person(directory, userId)),
    createdAt: isoOf(row.created_at) as string,
  };
}

function emptySummary(ref: ReviewSubjectRef): ReviewThreadSummary {
  return { ...ref, assignee: null, assignedAt: null, version: 0, commentCount: 0, lastCommentAt: null };
}

// ---------------------------------------------------------------------------
// Keyset cursor: (subject_kind, subject_id)
// ---------------------------------------------------------------------------

function decodeThreadCursor(cursor: string): ReviewSubjectRef {
  const key = decodeCursor(cursor);
  const separator = key.indexOf("|");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator === -1 || (kind !== "observation" && kind !== "reconciliation_exception") || !isUuid(id)) throw new InvalidCursorError();
  return { subjectKind: kind, subjectId: id.toLowerCase() };
}

export class PostgresReviewDiscussionBackend implements ReviewDiscussionBackend {
  readonly demo = false;
  private readonly defaultDb: () => PostgresSqlApi;

  constructor(defaultDb: () => PostgresSqlApi) { this.defaultDb = defaultDb; }

  private scope(identity: RequestIdentity): { funds: string; documents: string } {
    return { funds: JSON.stringify(identity.entitlements.fundIds ?? []), documents: JSON.stringify(identity.entitlements.documentIds ?? []) };
  }

  /** The caller's own user id (an active human identity in this tenant). */
  private async actorUserId(identity: RequestIdentity, db: PostgresSqlApi): Promise<string> {
    const rows = await db.query(`select user_id::text as user_id from corvis_control.identity_subject
      where tenant_id=$1::uuid and auth_method=$2 and subject=$3 and status='active' and auth_method in ('oidc','saml') limit 1`,
    [identity.tenantId, identity.authMethod, identity.subject]);
    const userId = rows[0]?.user_id;
    if (userId == null) throw new ReviewDiscussionRequestError("human_identity_required", 403);
    return String(userId);
  }

  private async labels(identity: RequestIdentity, db: PostgresSqlApi, actorUserId: string, userIds: Iterable<string>): Promise<Directory> {
    const wanted = [...new Set([...userIds].filter((userId) => isUuid(userId)))];
    const labels = new Map<string, string>();
    if (wanted.length > 0) {
      const rows = await db.query(`select member_user_id::text as user_id,member_label from corvis_control.review_member_labels($1::uuid,
        array(select jsonb_array_elements_text($2::jsonb)::uuid))`, [identity.tenantId, JSON.stringify(wanted)]);
      for (const row of rows) if (row.member_label != null) labels.set(str(row, "user_id"), str(row, "member_label"));
    }
    return { actorUserId, labels };
  }

  /** The fund of an item the caller may see. A missing, foreign, unentitled or malformed id is the same 404: existence is not leaked. */
  private async visibleFund(identity: RequestIdentity, ref: ReviewSubjectRef, db: PostgresSqlApi): Promise<string> {
    if (!isUuid(ref.subjectId) || !isUuid(identity.workspaceId)) throw new ReviewDiscussionRequestError("review_item_not_found", 404);
    const { funds, documents } = this.scope(identity);
    const row = (await db.query(`select subject_fund_id from corvis_control.resolve_review_subject($1::uuid,$2,$3::uuid,$4::jsonb,$5::jsonb)`,
      [identity.tenantId, ref.subjectKind, ref.subjectId, funds, documents]))[0];
    if (!row) throw new ReviewDiscussionRequestError("review_item_not_found", 404);
    return str(row, "subject_fund_id");
  }

  private threadRow(identity: RequestIdentity, ref: ReviewSubjectRef, db: PostgresSqlApi): Promise<PostgresRow | undefined> {
    return db.query(`select t.* from corvis_control.review_item_thread t
      where t.tenant_id=$1::uuid and t.workspace_id=$2::uuid and t.subject_kind=$3 and t.subject_id=$4::uuid`,
    [identity.tenantId, identity.workspaceId, ref.subjectKind, ref.subjectId]).then((rows) => rows[0]);
  }

  async listThreads(identity: RequestIdentity, query: ReviewThreadQuery, db: PostgresSqlApi = this.defaultDb()): Promise<ReviewThreadPage> {
    // Decoded before any query: a tampered cursor never reaches the `::uuid` cast.
    const after = query.cursor ? decodeThreadCursor(query.cursor) : null;
    if (!isUuid(identity.workspaceId)) return { items: [], nextCursor: null };
    const { funds, documents } = this.scope(identity);
    const parameters: PostgresPrimitive[] = [identity.tenantId, identity.workspaceId, funds, documents];
    let keyset = "";
    if (after) {
      parameters.push(after.subjectKind, after.subjectId);
      keyset = ` and (t.subject_kind,t.subject_id) > ($5::text,$6::uuid)`;
    }
    parameters.push(query.limit + 1);
    const actorUserId = await this.actorUserId(identity, db);
    const rows = await db.query(`select t.* from corvis_control.review_item_thread t
      where t.tenant_id=$1::uuid and t.workspace_id=$2::uuid and (t.assignee_user_id is not null or t.comment_count>0)
        and exists (select 1 from corvis_control.resolve_review_subject(t.tenant_id,t.subject_kind,t.subject_id,$3::jsonb,$4::jsonb))${keyset}
      order by t.subject_kind,t.subject_id limit $${parameters.length}::integer`, parameters);
    const page = rows.slice(0, query.limit);
    const directory = await this.labels(identity, db, actorUserId, presentIds(page.map((row) => row.assignee_user_id)));
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toSummary(row, directory)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(`${str(last, "subject_kind")}|${str(last, "subject_id")}`) : null,
    };
  }

  async getThread(identity: RequestIdentity, ref: ReviewSubjectRef, db: PostgresSqlApi = this.defaultDb()): Promise<ReviewThread> {
    const actorUserId = await this.actorUserId(identity, db);
    const fundId = await this.visibleFund(identity, ref, db);
    // One after another: inside a transaction every statement shares one connection.
    const thread = await this.threadRow(identity, ref, db);
    const comments = await db.query(`select c.* from corvis_control.review_item_comment c
      where c.tenant_id=$1::uuid and c.workspace_id=$2::uuid and c.subject_kind=$3 and c.subject_id=$4::uuid order by c.comment_seq`,
    [identity.tenantId, identity.workspaceId, ref.subjectKind, ref.subjectId]);
    const members = await db.query(`select member_user_id::text as user_id,member_label,member_roles from corvis_control.review_eligible_members($1::uuid,$2::uuid,$3)
      order by member_label,member_user_id`, [identity.tenantId, identity.workspaceId, fundId]);
    const involved = [
      ...presentIds([thread?.assignee_user_id]),
      ...comments.flatMap((row) => [str(row, "author_user_id"), ...idList(row.mentioned_user_ids)]),
    ];
    const directory = await this.labels(identity, db, actorUserId, involved);
    const roster: ReviewMember[] = members.map((row) => ({
      userId: str(row, "user_id"), displayName: str(row, "member_label"), isMe: str(row, "user_id") === actorUserId,
      roleLabel: reviewRoleLabel(idList(row.member_roles)),
    }));
    return { ...(thread ? toSummary(thread, directory) : emptySummary(ref)), comments: comments.map((row) => toComment(row, directory)), members: roster };
  }

  async assign(identity: RequestIdentity, ref: ReviewSubjectRef, command: AssignReviewItemCommand, db: PostgresSqlApi = this.defaultDb()): Promise<AssignOutcome> {
    const actorUserId = await this.actorUserId(identity, db);
    await this.visibleFund(identity, ref, db);
    // An assignee that is not even a UUID can never be a member: refuse it like any other ineligible person.
    if (command.assigneeUserId !== null && !isUuid(command.assigneeUserId)) throw new ReviewDiscussionRequestError("assignee_not_eligible", 422);
    const { funds, documents } = this.scope(identity);
    const row = (await db.query(`select * from corvis_control.set_review_item_assignee($1::uuid,$2::uuid,$3,$4::uuid,$5::jsonb,$6::jsonb,$7,$8,$9::uuid,$10::integer)`, [
      identity.tenantId, identity.workspaceId, ref.subjectKind, ref.subjectId, funds, documents, identity.authMethod, identity.subject,
      command.assigneeUserId, command.expectedVersion,
    ]))[0];
    if (!row) throw new Error("review item thread was not returned");
    const directory = await this.labels(identity, db, actorUserId, presentIds([row.assignee_user_id]));
    const thread = toSummary(row, directory);
    // The function keeps the version when nothing changed, so a moved version is exactly a changed assignee.
    if (thread.version === command.expectedVersion) return { thread, change: null };
    const fundId = str(row, "fund_id");
    if (thread.assignee && !thread.assignee.isMe) await notifyUser(db, identity, thread.assignee.userId, fundId, "assigned", `review_discussion:assigned:${ref.subjectKind}:${ref.subjectId}:${thread.version}`);
    return { thread, change: { previousAssigneeUserId: optionalStr(row, "previous_assignee_user_id"), fundId } };
  }

  async comment(identity: RequestIdentity, ref: ReviewSubjectRef, command: AddReviewCommentCommand, db: PostgresSqlApi = this.defaultDb()): Promise<CommentOutcome> {
    const actorUserId = await this.actorUserId(identity, db);
    await this.visibleFund(identity, ref, db);
    // A mention that is not even a UUID can never be a member: refuse it like any other ineligible person.
    if (command.mentionUserIds.some((userId) => !isUuid(userId))) throw new ReviewDiscussionRequestError("mention_not_eligible", 422);
    const commentId = randomUUID();
    const { funds, documents } = this.scope(identity);
    let rows: PostgresRow[];
    try {
      rows = await db.query(`select * from corvis_control.add_review_item_comment($1::uuid,$2::uuid,$3,$4::uuid,$5::jsonb,$6::jsonb,$7::uuid,$8,$9,$10,$11,$12,
        array(select jsonb_array_elements_text($13::jsonb)::uuid))`, [
        identity.tenantId, identity.workspaceId, ref.subjectKind, ref.subjectId, funds, documents, commentId, identity.authMethod, identity.subject,
        command.idempotencyKey, commentFingerprint(ref, command), command.body, JSON.stringify(command.mentionUserIds),
      ]);
    } catch (error) {
      // Two concurrent first comments with one key both miss the function's lookup and the loser hits the key's unique
      // index. That is a retryable conflict (the retry finds the winner's comment), not a server failure.
      if ((error as { code?: unknown } | null)?.code === "23505") throw new ReviewDiscussionRequestError("review_comment_conflict", 409);
      throw error;
    }
    const row = rows[0];
    if (!row) throw new Error("review comment was not recorded");
    const threadRow = await this.threadRow(identity, ref, db);
    if (!threadRow) throw new Error("review item thread was not found");
    const mentioned = idList(row.mentioned_user_ids);
    const directory = await this.labels(identity, db, actorUserId, [str(row, "author_user_id"), ...mentioned, ...presentIds([threadRow.assignee_user_id])]);
    const created = str(row, "comment_id") === commentId;
    const fundId = str(threadRow, "fund_id");
    if (created) {
      for (const userId of mentioned.filter((candidate) => candidate !== actorUserId)) {
        await notifyUser(db, identity, userId, fundId, "mentioned", `review_discussion:mention:${commentId}:${userId}`);
      }
    }
    return { comment: toComment(row, directory), created, thread: toSummary(threadRow, directory), fundId };
  }

  async assignedToMe(identity: RequestIdentity, db: PostgresSqlApi = this.defaultDb()): Promise<AssignedReviewItem[]> {
    if (!isUuid(identity.workspaceId)) return [];
    const actorUserId = await this.actorUserId(identity, db);
    const { funds, documents } = this.scope(identity);
    // Open work only: an observation that has been approved or rejected, or an exception that has been resolved, is no longer attention.
    const rows = await db.query(`select t.subject_kind,t.subject_id::text as subject_id,t.assignment_changed_at,
        o.company_name,o.metric_code,o.economic_period,
        coalesce((select max(fs.fund_name) from corvis_serving.fund_period_snapshots fs where fs.tenant_id=t.tenant_id and fs.fund_id=t.fund_id),t.fund_id) as fund_name,
        e.summary,e.exception_type,e.report_period as exception_period,e.snapshot_id::text as exception_snapshot_id,
        (select s.snapshot_id::text from corvis_serving.fund_period_snapshots s
          where s.tenant_id=t.tenant_id and s.fund_id=t.fund_id and lower(s.report_period)=lower(o.economic_period)
          order by s.created_at desc,s.version desc limit 1) as period_snapshot_id
      from corvis_control.review_item_thread t
      left join corvis_serving.observations o on t.subject_kind='observation' and o.tenant_id=t.tenant_id and o.observation_id=t.subject_id
      left join corvis_consolidated.reconciliation_exception e on t.subject_kind='reconciliation_exception' and e.tenant_id=t.tenant_id and e.exception_id=t.subject_id
      where t.tenant_id=$1::uuid and t.workspace_id=$2::uuid and t.assignee_user_id=$3::uuid
        and exists (select 1 from corvis_control.resolve_review_subject(t.tenant_id,t.subject_kind,t.subject_id,$4::jsonb,$5::jsonb))
        and ((t.subject_kind='observation' and o.observation_id is not null and lower(o.review_state) not in ('approved','rejected'))
          or (t.subject_kind='reconciliation_exception' and e.status='open'))
      order by t.assignment_changed_at desc,t.subject_id limit 100`, [identity.tenantId, identity.workspaceId, actorUserId, funds, documents]);
    return sortAssignedItems(rows.map((row) => {
      const ref = { subjectId: str(row, "subject_id"), assignedAt: isoOf(row.assignment_changed_at) };
      return str(row, "subject_kind") === "observation"
        ? assignedObservationItem({ ...ref, snapshotId: optionalStr(row, "period_snapshot_id") }, { company: optionalStr(row, "company_name"), metric: optionalStr(row, "metric_code"), fund: optionalStr(row, "fund_name"), period: optionalStr(row, "economic_period") })
        : assignedExceptionItem({ ...ref, snapshotId: optionalStr(row, "exception_snapshot_id") }, { summary: optionalStr(row, "summary"), type: optionalStr(row, "exception_type"), fund: optionalStr(row, "fund_name"), period: optionalStr(row, "exception_period") });
    }));
  }
}

/**
 * Queues the in-app/email notice (category `review_discussion`). Best effort inside the caller's transaction: a
 * notification fault must never block the assignment or the comment. The outbox row carries only the recipient, the
 * workspace, the item's fund and the roles the recipient must still hold (so send-time eligibility re-checks review
 * access and the fund entitlement); the email says which of two things happened, never the item, the people or any
 * comment text (src/modules/notifications/domain/notifications.ts).
 */
async function notifyUser(db: PostgresSqlApi, identity: RequestIdentity, userId: string, fundId: string, event: "assigned" | "mentioned", dedupeKey: string): Promise<void> {
  await bestEffortNotification(db, dedupeKey, () => enqueueForUser(db, {
    tenantId: identity.tenantId, userId, category: "review_discussion", workspaceId: identity.workspaceId, fundId,
    requiredRoles: REVIEW_ROLES, params: { event }, dedupeKey,
  }), { inTransaction: true });
}
