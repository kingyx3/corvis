/**
 * Assigning and discussing review items (F3, #259): the domain contract shared by the API, the Postgres and demo
 * implementations, the notification template and the UI.
 *
 * A review item is an observation (Data review) or a reconciliation exception. Anyone with review access can assign one
 * to a teammate who also has review access to it, and discuss it in a thread of append-only comments that may @mention
 * such teammates. Discussion records a conversation only: it never changes data, never records a review decision and
 * never counts toward dual control. A decision is still a review action made through the existing review routes.
 */

export const REVIEW_SUBJECT_KINDS = ["observation", "reconciliation_exception"] as const;
export type ReviewSubjectKind = (typeof REVIEW_SUBJECT_KINDS)[number];

export const REVIEW_SUBJECT_KIND_LABEL: Record<ReviewSubjectKind, string> = {
  observation: "Observation",
  reconciliation_exception: "Reconciliation exception",
};

export function isReviewSubjectKind(value: unknown): value is ReviewSubjectKind {
  return REVIEW_SUBJECT_KINDS.some((kind) => kind === value);
}

/** The database roles that can review, and so can be assigned or mentioned (migration 086 `review_member_eligible`). */
export const REVIEW_ROLES = ["tenant_admin", "accountadmin", "reviewer"] as const;

const ROLE_LABEL: Record<(typeof REVIEW_ROLES)[number], string> = {
  tenant_admin: "Organization Admin",
  accountadmin: "Workspace Admin",
  reviewer: "Review Analyst",
};

/** The most senior review role a member holds, in words. */
export function reviewRoleLabel(roleNames: readonly string[]): string {
  const held = REVIEW_ROLES.find((role) => roleNames.includes(role));
  return held ? ROLE_LABEL[held] : "Review access";
}

export const MAX_REVIEW_COMMENT_LENGTH = 2000;
export const MAX_REVIEW_MENTIONS = 10;
/** A thread holds at most this many comments (migration 086), so a thread is always returned whole. */
export const MAX_REVIEW_COMMENTS_PER_THREAD = 200;

export type ReviewSubjectRef = { subjectKind: ReviewSubjectKind; subjectId: string };

export function reviewItemKey(ref: ReviewSubjectRef): string {
  return `${ref.subjectKind}:${ref.subjectId}`;
}

export type ReviewPerson = { userId: string; displayName: string; isMe: boolean };
export type ReviewMember = ReviewPerson & { roleLabel: string };

export type ReviewComment = {
  commentId: string;
  author: ReviewPerson;
  /** Free text as written. Rendered as text only, and never copied into an email, a notification or an audit event. */
  body: string;
  mentions: ReviewPerson[];
  createdAt: string;
};

export type ReviewThreadSummary = ReviewSubjectRef & {
  assignee: ReviewPerson | null;
  /** When the current assignee was set; null while unassigned. */
  assignedAt: string | null;
  /** Counts changes of assignee (0 until the first); send it back as `expectedVersion` when assigning. */
  version: number;
  commentCount: number;
  lastCommentAt: string | null;
};

export type ReviewThread = ReviewThreadSummary & {
  comments: ReviewComment[];
  /** Everyone who may be assigned or mentioned on this item (review access to its fund in this workspace). */
  members: ReviewMember[];
};

export type ReviewThreadPage = { items: ReviewThreadSummary[]; nextCursor: string | null };

/** One of the caller's own open assignments, as the Overview attention list shows it. */
export type AssignedReviewItem = ReviewSubjectRef & {
  title: string;
  detail: string;
  severity: "blocking" | "high";
  assignedAt: string | null;
  snapshotId?: string;
};

export type AssignReviewItemCommand = {
  /** The new assignee, or null to unassign. */
  assigneeUserId: string | null;
  /** The thread version the person saw (0 when it had none): a stale screen is refused instead of overwriting. */
  expectedVersion: number;
};

export type AddReviewCommentCommand = {
  idempotencyKey: string;
  body: string;
  mentionUserIds: string[];
};

export type ReviewAssignmentAction = "assign" | "reassign" | "unassign";

/** What a change of assignee is called in the audit trail. */
export function reviewAssignmentAction(previousAssigneeUserId: string | null, assigneeUserId: string | null): ReviewAssignmentAction {
  if (assigneeUserId === null) return "unassign";
  return previousAssigneeUserId === null ? "assign" : "reassign";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ReviewDiscussionValidationError extends Error {
  readonly code: string;
  readonly status = 400 as const;
  constructor(code: string) { super(code); this.name = "ReviewDiscussionValidationError"; this.code = code; }
}

// Real identifiers are UUIDs; the demo composition uses short readable ids. Anything outside this shape can never name an item or a person.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/;
const FREE_TEXT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
const MAX_EXPECTED_VERSION = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseId(value: unknown, code: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new ReviewDiscussionValidationError(code);
  return value;
}

/** The kind and id named in a route path. */
export function parseSubjectRef(kind: string, id: string): ReviewSubjectRef {
  if (!isReviewSubjectKind(kind)) throw new ReviewDiscussionValidationError("invalid_subject_kind");
  return { subjectKind: kind, subjectId: parseId(id, "invalid_subject_id") };
}

export function parseAssignCommand(body: unknown): AssignReviewItemCommand {
  if (!isRecord(body)) throw new ReviewDiscussionValidationError("invalid_request");
  const assigneeUserId = body.assigneeUserId === null ? null : parseId(body.assigneeUserId, "invalid_assignee");
  const version = body.expectedVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > MAX_EXPECTED_VERSION) {
    throw new ReviewDiscussionValidationError("invalid_expected_version");
  }
  return { assigneeUserId, expectedVersion: version };
}

function idempotencyKeyOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ReviewDiscussionValidationError("invalid_idempotency_key");
  const clean = value.trim();
  if (clean.length === 0 || clean.length > 256 || SINGLE_LINE_FORBIDDEN.test(clean)) throw new ReviewDiscussionValidationError("invalid_idempotency_key");
  return clean;
}

/**
 * Validates a comment. The idempotency key comes from the body or, when absent there, the `Idempotency-Key` header (one
 * namespace: naming it in both places with different values is refused).
 */
export function parseCommentCommand(body: unknown, headerKey?: string | null): AddReviewCommentCommand {
  if (!isRecord(body)) throw new ReviewDiscussionValidationError("invalid_request");
  const fromBody = idempotencyKeyOf(body.idempotencyKey);
  const fromHeader = idempotencyKeyOf(headerKey);
  if (fromBody !== undefined && fromHeader !== undefined && fromBody !== fromHeader) throw new ReviewDiscussionValidationError("invalid_idempotency_key");
  const idempotencyKey = fromBody ?? fromHeader;
  if (idempotencyKey === undefined) throw new ReviewDiscussionValidationError("idempotency_key_required");
  if (typeof body.body !== "string") throw new ReviewDiscussionValidationError("invalid_comment");
  const text = body.body.trim();
  if (text.length === 0 || text.length > MAX_REVIEW_COMMENT_LENGTH || FREE_TEXT_FORBIDDEN.test(text)) throw new ReviewDiscussionValidationError("invalid_comment");
  let mentionUserIds: string[] = [];
  if (body.mentionUserIds !== undefined && body.mentionUserIds !== null) {
    if (!Array.isArray(body.mentionUserIds) || body.mentionUserIds.length > MAX_REVIEW_MENTIONS) throw new ReviewDiscussionValidationError("invalid_mentions");
    mentionUserIds = [...new Set(body.mentionUserIds.map((value) => parseId(value, "invalid_mentions")))];
  }
  return { idempotencyKey, body: text, mentionUserIds };
}

// ---------------------------------------------------------------------------
// Presentation helpers (UI and tests share them)
// ---------------------------------------------------------------------------

export const ASSIGNMENT_FILTERS = ["all", "mine", "unassigned"] as const;
export type AssignmentFilter = (typeof ASSIGNMENT_FILTERS)[number];

export function isAssignmentFilter(value: unknown): value is AssignmentFilter {
  return ASSIGNMENT_FILTERS.some((filter) => filter === value);
}

export const ASSIGNMENT_FILTER_LABEL: Record<AssignmentFilter, string> = {
  all: "All assignees",
  mine: "Assigned to me",
  unassigned: "Unassigned",
};

/** Whether an item whose current assignee is `assignee` (null when unassigned) passes the assignment filter. */
export function matchesAssignmentFilter(filter: AssignmentFilter, assignee: ReviewPerson | null | undefined): boolean {
  if (filter === "mine") return assignee?.isMe === true;
  if (filter === "unassigned") return !assignee;
  return true;
}

/** "Assigned to you", "Assigned to Priya" or "Unassigned". */
export function assigneeLabel(assignee: ReviewPerson | null | undefined): string {
  if (!assignee) return "Unassigned";
  return assignee.isMe ? "Assigned to you" : `Assigned to ${assignee.displayName}`;
}

type Range = { start: number; end: number };

const WORD = /[A-Za-z0-9_-]/;

/**
 * Where `@name` mentions of the given names occur in `text`. A mention starts at the beginning or after a space or
 * punctuation (never inside a word, so an address such as a@b.test is not a mention of b.test), ends where the name ends
 * and is not followed by more name characters. Longer names are matched first, so one name is never found inside another.
 */
function mentionRanges(text: string, names: readonly string[]): Array<Range & { name: string }> {
  const found: Array<Range & { name: string }> = [];
  const ordered = [...new Set(names.filter((name) => name.length > 0))].sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const name of ordered) {
    const token = `@${name}`;
    let from = 0;
    for (let at = text.indexOf(token, from); at !== -1; at = text.indexOf(token, from)) {
      const end = at + token.length;
      from = end;
      const before = at === 0 ? "" : text[at - 1]!;
      const after = end >= text.length ? "" : text[end]!;
      if (before && WORD.test(before)) continue;
      if (after && WORD.test(after)) continue;
      if (found.some((range) => at < range.end && end > range.start)) continue;
      found.push({ start: at, end, name });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The teammates whose `@name` appears in the comment text: the people it notifies. */
export function mentionedUserIds(text: string, members: readonly Pick<ReviewPerson, "userId" | "displayName">[]): string[] {
  const byName = new Map(members.map((member) => [member.displayName, member.userId]));
  const ids = mentionRanges(text, [...byName.keys()]).map((range) => byName.get(range.name)!);
  return [...new Set(ids)].slice(0, MAX_REVIEW_MENTIONS);
}

/** Adds `@name ` for a teammate at the end of the comment being written. */
export function appendMention(text: string, member: Pick<ReviewPerson, "displayName">): string {
  const separator = text.length === 0 || /\s$/.test(text) ? "" : " ";
  return `${text}${separator}@${member.displayName} `;
}

export type CommentSegment = { text: string; mention: boolean };

/** The comment split so each mention of one of `names` can be shown as such; everything else is plain text. */
export function commentSegments(text: string, names: readonly string[]): CommentSegment[] {
  const segments: CommentSegment[] = [];
  let cursor = 0;
  for (const range of mentionRanges(text, names)) {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), mention: false });
    segments.push({ text: text.slice(range.start, range.end), mention: true });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false });
  return segments;
}

/** Plain-language copy for the stable error codes the review-item routes return; anything else gets `fallback`. */
export const REVIEW_DISCUSSION_ERROR_MESSAGES: Record<string, string> = {
  review_item_not_found: "This review item is no longer available to you.",
  assignee_not_eligible: "That person can no longer be assigned this item: they need review access to its fund in this workspace.",
  mention_not_eligible: "Someone you mentioned can no longer be mentioned on this item. Remove the mention and try again.",
  assignment_changed: "Someone else changed the assignment while you were looking. The latest assignment is shown; try again.",
  idempotency_key_reused: "A different comment was already sent with this reference. Close this dialog and start again.",
  review_comment_limit_reached: "This discussion has reached its limit of 200 comments. Continue the conversation outside Corvis or ask an administrator.",
  human_identity_required: "Assignments and discussion are for signed-in people, not service identities.",
  invalid_comment: "Write a comment of 1 to 2,000 characters.",
  invalid_mentions: "A comment can mention at most 10 teammates.",
};

// ---------------------------------------------------------------------------
// Overview attention: "assigned to me"
// ---------------------------------------------------------------------------

type AssignedObservationFacts = { company?: string | null; metric?: string | null; fund?: string | null; period?: string | null };
type AssignedExceptionFacts = { summary?: string | null; type?: string | null; fund?: string | null; period?: string | null };

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" · ");
}

/** The attention row for an observation assigned to the caller that still needs review. */
export function assignedObservationItem(
  ref: { subjectId: string; assignedAt: string | null; snapshotId?: string | null },
  facts: AssignedObservationFacts,
): AssignedReviewItem {
  const item: AssignedReviewItem = {
    subjectKind: "observation",
    subjectId: ref.subjectId,
    title: joinParts([facts.company ?? "Observation", facts.metric]),
    detail: `${joinParts([facts.fund, facts.period])}${facts.fund || facts.period ? " · " : ""}Assigned to you for review.`,
    severity: "high",
    assignedAt: ref.assignedAt,
  };
  if (ref.snapshotId) item.snapshotId = ref.snapshotId;
  return item;
}

/** The attention row for a reconciliation exception assigned to the caller that is still open. */
export function assignedExceptionItem(
  ref: { subjectId: string; assignedAt: string | null; snapshotId?: string | null },
  facts: AssignedExceptionFacts,
): AssignedReviewItem {
  const item: AssignedReviewItem = {
    subjectKind: "reconciliation_exception",
    subjectId: ref.subjectId,
    title: facts.summary?.trim() || `${(facts.type ?? "reconciliation").replaceAll("_", " ")} exception`,
    detail: `${joinParts([facts.fund, facts.period])}${facts.fund || facts.period ? " · " : ""}Blocks publication until resolved.`,
    severity: "blocking",
    assignedAt: ref.assignedAt,
  };
  if (ref.snapshotId) item.snapshotId = ref.snapshotId;
  return item;
}

/** Blocking exceptions first, then newest assignment first. */
export function sortAssignedItems(items: readonly AssignedReviewItem[]): AssignedReviewItem[] {
  const rank = { blocking: 0, high: 1 } as const;
  return [...items].sort((a, b) => rank[a.severity] - rank[b.severity]
    || (b.assignedAt ?? "").localeCompare(a.assignedAt ?? "")
    || a.subjectId.localeCompare(b.subjectId));
}
