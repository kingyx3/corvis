import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { REVIEW_ROLES, type AddReviewCommentCommand, type ReviewSubjectRef } from "../../core/review-discussion.ts";
import { InvalidCursorError, decodeCursor, encodeCursor } from "./pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  PostgresReviewDiscussionBackend,
  ReviewDiscussionRequestError,
  assertHumanIdentity,
  commentFingerprint,
  isUuid,
  reviewDiscussionAuditEvent,
} from "./review-discussion.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const OBS = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const OBS_2 = "9f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const EXC = "af3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const ME = "99999999-9999-4999-8999-999999999999";
const PRIYA = "88888888-8888-4888-8888-888888888888";
const MARCUS = "77777777-7777-4777-8777-777777777777";
const COMMENT = "66666666-6666-4666-8666-666666666666";
const SNAPSHOT = "44444444-4444-4444-8444-444444444444";
const observation: ReviewSubjectRef = { subjectKind: "observation", subjectId: OBS };
const refusal = (code: string, status: number) => (error: unknown) => error instanceof ReviewDiscussionRequestError && error.code === code && error.status === status;

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "idp|me", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["reviewer"], authMethod: "oidc", sessionId: "session-1",
    entitlements: { workspaceIds: [WORKSPACE], fundIds: ["fund-1", "fund-2"], documentIds: ["doc-1"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}

function threadRow(overrides: PostgresRow = {}): PostgresRow {
  return {
    tenant_id: TENANT, workspace_id: WORKSPACE, subject_kind: "observation", subject_id: OBS, fund_id: "fund-1", report_period: "Q2 2026",
    assignee_user_id: PRIYA, previous_assignee_user_id: null, assignment_changed_by: "idp|me", assignment_changed_at: "2026-10-01 10:00:00+00",
    version: 1, comment_count: 1, last_comment_at: "2026-10-01 11:00:00+00", created_at: "2026-10-01 09:00:00+00", ...overrides,
  };
}
function commentRow(overrides: PostgresRow = {}): PostgresRow {
  return {
    tenant_id: TENANT, workspace_id: WORKSPACE, subject_kind: "observation", subject_id: OBS, comment_id: COMMENT, comment_seq: "1", author_auth_method: "oidc",
    author_subject: "idp|me", author_user_id: ME, idempotency_key: "k-1", request_hash: "a".repeat(64), body: "Please check page 4.", mentioned_user_ids: [PRIYA],
    created_at: "2026-10-01 11:00:00.123456+00", ...overrides,
  };
}

type Call = { sql: string; parameters: PostgresPrimitive[] };
class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  readonly executed: Call[] = [];
  private readonly handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[];
  failExecute?: (sql: string) => boolean;
  constructor(handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[]) { this.handler = handler; }
  async query(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); return this.handler(sql, parameters); }
  async execute(sql: string, parameters: PostgresPrimitive[] = []) {
    this.executed.push({ sql, parameters });
    if (this.failExecute?.(sql)) throw new Error(`execute failed: ${sql}`);
  }
  async health() { return true; }
}

const labelRows = (...entries: Array<[string, string | null]>): PostgresRow[] => entries.map(([user_id, member_label]) => ({ user_id, member_label }));
const isActor = (sql: string) => sql.includes("from corvis_control.identity_subject");
const isVisible = (sql: string) => sql.includes("select subject_fund_id from corvis_control.resolve_review_subject");
const isLabels = (sql: string) => sql.includes("review_member_labels");
const isThreadRead = (sql: string) => sql.includes("from corvis_control.review_item_thread t") && sql.includes("t.subject_kind=$3 and t.subject_id=$4::uuid");
const isOutbox = (sql: string) => sql.includes("email_outbox");

test("helpers: uuids, human identities and the comment fingerprint", () => {
  assert.equal(isUuid(OBS), true);
  assert.equal(isUuid("obs-1"), false);
  for (const authMethod of ["oidc", "saml", "demo"] as const) assert.doesNotThrow(() => assertHumanIdentity(identity({ authMethod })));
  assert.throws(() => assertHumanIdentity(identity({ authMethod: "service_account" })), refusal("human_identity_required", 403));

  const command: AddReviewCommentCommand = { idempotencyKey: "k-1", body: "Please check page 4.", mentionUserIds: [PRIYA, MARCUS] };
  const base = commentFingerprint(observation, command);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(commentFingerprint(observation, { ...command, idempotencyKey: "another" }), base, "the key itself is not part of the content");
  assert.equal(commentFingerprint(observation, { ...command, mentionUserIds: [MARCUS, PRIYA] }), base, "mention order does not matter");
  assert.notEqual(commentFingerprint(observation, { ...command, body: "different" }), base);
  assert.notEqual(commentFingerprint(observation, { ...command, mentionUserIds: [PRIYA] }), base);
  assert.notEqual(commentFingerprint({ subjectKind: "reconciliation_exception", subjectId: OBS }, command), base, "the item is part of the content");
  assert.notEqual(commentFingerprint({ subjectKind: "observation", subjectId: OBS_2 }, command), base);
});

test("audit events carry identifiers and counts, never the comment text", () => {
  const event = reviewDiscussionAuditEvent(identity(), "corr-1", "review_item.comment", observation, { fundId: "fund-1", commentId: COMMENT, commentLength: 20 });
  assert.equal(event.targetType, "review_item");
  assert.equal(event.targetId, `observation:${OBS}`);
  assert.equal(event.action, "review_item.comment");
  assert.equal(event.workspaceId, WORKSPACE);
  assert.equal(event.actorSubject, "idp|me");
  assert.deepEqual(event.metadata, { subjectKind: "observation", subjectId: OBS, fundId: "fund-1", commentId: COMMENT, commentLength: 20 });
  assert.equal(event.outcome, "success");
});

test("an assignment that changes the assignee notifies the new assignee in the same transaction, with no item or person in the notice", async () => {
  const db = new FakeDb((sql) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (isVisible(sql)) return [{ subject_fund_id: "fund-1" }];
    if (sql.includes("set_review_item_assignee")) return [threadRow({ assignee_user_id: PRIYA, previous_assignee_user_id: null, version: 1, comment_count: 0, last_comment_at: null })];
    if (isLabels(sql)) return labelRows([PRIYA, "priya.nair@example.test"]);
    return [];
  });
  const outcome = await new PostgresReviewDiscussionBackend(() => db).assign(identity(), observation, { assigneeUserId: PRIYA, expectedVersion: 0 }, db);
  assert.deepEqual(outcome.change, { previousAssigneeUserId: null, fundId: "fund-1" });
  assert.deepEqual(outcome.thread, {
    subjectKind: "observation", subjectId: OBS, assignee: { userId: PRIYA, displayName: "priya.nair@example.test", isMe: false },
    assignedAt: "2026-10-01T10:00:00.000Z", version: 1, commentCount: 0, lastCommentAt: null,
  });

  const call = db.calls.find((entry) => entry.sql.includes("set_review_item_assignee"))!;
  assert.deepEqual(call.parameters.slice(0, 4), [TENANT, WORKSPACE, "observation", OBS]);
  assert.equal(call.parameters[4], JSON.stringify(["fund-1", "fund-2"]), "the caller's own fund entitlement goes to the SQL, never a client value");
  assert.equal(call.parameters[5], JSON.stringify(["doc-1"]));
  assert.deepEqual(call.parameters.slice(6), ["oidc", "idp|me", PRIYA, 0]);

  const outbox = db.executed.filter((entry) => isOutbox(entry.sql));
  assert.equal(outbox.length, 1);
  const [tenantId, category, userId, workspaceId, fundId, requiredRoles, params, dedupeKey] = outbox[0]!.parameters;
  assert.deepEqual([tenantId, category, userId, workspaceId, fundId], [TENANT, "review_discussion", PRIYA, WORKSPACE, "fund-1"]);
  assert.equal(requiredRoles, JSON.stringify(REVIEW_ROLES), "send-time eligibility re-checks review access");
  assert.equal(params, JSON.stringify({ event: "assigned" }), "the notice says only that an item was assigned");
  assert.equal(dedupeKey, `review_discussion:assigned:observation:${OBS}:1`);
  assert.ok(db.executed.some((entry) => entry.sql.startsWith("savepoint")), "a notification fault is isolated by a savepoint");
});

test("reassigning and unassigning report the previous assignee; assigning yourself or nobody notifies no one", async () => {
  const run = async (row: PostgresRow, command: { assigneeUserId: string | null; expectedVersion: number }) => {
    const db = new FakeDb((sql) => {
      if (isActor(sql)) return [{ user_id: ME }];
      if (isVisible(sql)) return [{ subject_fund_id: "fund-1" }];
      if (sql.includes("set_review_item_assignee")) return [row];
      if (isLabels(sql)) return labelRows([ME, "me@example.test"], [MARCUS, "marcus.chen@example.test"]);
      return [];
    });
    const outcome = await new PostgresReviewDiscussionBackend(() => db).assign(identity(), observation, command, db);
    return { outcome, notified: db.executed.filter((entry) => isOutbox(entry.sql)).length };
  };

  const reassigned = await run(threadRow({ assignee_user_id: MARCUS, previous_assignee_user_id: PRIYA, version: 2 }), { assigneeUserId: MARCUS, expectedVersion: 1 });
  assert.deepEqual([reassigned.outcome.change?.previousAssigneeUserId, reassigned.outcome.thread.assignee?.userId, reassigned.notified], [PRIYA, MARCUS, 1]);

  const unassigned = await run(threadRow({ assignee_user_id: null, previous_assignee_user_id: MARCUS, assignment_changed_at: null, version: 3 }), { assigneeUserId: null, expectedVersion: 2 });
  assert.deepEqual([unassigned.outcome.change?.previousAssigneeUserId, unassigned.outcome.thread.assignee, unassigned.outcome.thread.assignedAt, unassigned.notified], [MARCUS, null, null, 0]);

  const toMe = await run(threadRow({ assignee_user_id: ME, version: 1 }), { assigneeUserId: ME, expectedVersion: 0 });
  assert.deepEqual([toMe.outcome.thread.assignee?.isMe, toMe.notified], [true, 0], "assigning yourself is not worth an email");

  const unchanged = await run(threadRow({ assignee_user_id: MARCUS, version: 2 }), { assigneeUserId: MARCUS, expectedVersion: 2 });
  assert.deepEqual([unchanged.outcome.change, unchanged.notified], [null, 0], "assigning the person who already holds it changes nothing");
});

test("assignment refuses what cannot be an item or a person before the SQL runs, and surfaces SQL refusals untouched", async () => {
  const backend = (handler: (sql: string) => PostgresRow[]) => { const db = new FakeDb(handler); return { db, backend: new PostgresReviewDiscussionBackend(() => db) }; };
  const known = (sql: string) => isActor(sql) ? [{ user_id: ME }] : isVisible(sql) ? [{ subject_fund_id: "fund-1" }] : [];

  const notUuid = backend(known);
  await assert.rejects(() => notUuid.backend.assign(identity(), observation, { assigneeUserId: "not-a-uuid", expectedVersion: 0 }, notUuid.db), refusal("assignee_not_eligible", 422));
  assert.ok(!notUuid.db.calls.some((call) => call.sql.includes("set_review_item_assignee")), "a malformed assignee never reaches the ::uuid cast");

  const invisible = backend((sql) => isActor(sql) ? [{ user_id: ME }] : []);
  await assert.rejects(() => invisible.backend.assign(identity(), observation, { assigneeUserId: PRIYA, expectedVersion: 0 }, invisible.db), refusal("review_item_not_found", 404));
  const malformed = backend(known);
  await assert.rejects(() => malformed.backend.assign(identity(), { subjectKind: "observation", subjectId: "obs-1" }, { assigneeUserId: PRIYA, expectedVersion: 0 }, malformed.db), refusal("review_item_not_found", 404));
  await assert.rejects(() => malformed.backend.assign(identity({ workspaceId: "workspace_demo" }), observation, { assigneeUserId: PRIYA, expectedVersion: 0 }, malformed.db), refusal("review_item_not_found", 404));
  const noPerson = backend(() => []);
  await assert.rejects(() => noPerson.backend.assign(identity(), observation, { assigneeUserId: PRIYA, expectedVersion: 0 }, noPerson.db), refusal("human_identity_required", 403));

  const emptyFunction = backend((sql) => isActor(sql) ? [{ user_id: ME }] : isVisible(sql) ? [{ subject_fund_id: "fund-1" }] : []);
  await assert.rejects(() => emptyFunction.backend.assign(identity(), observation, { assigneeUserId: PRIYA, expectedVersion: 0 }, emptyFunction.db), /review item thread was not returned/);

  const stale = backend((sql) => { if (sql.includes("set_review_item_assignee")) throw new Error("review item assignment changed"); return known(sql); });
  await assert.rejects(() => stale.backend.assign(identity(), observation, { assigneeUserId: PRIYA, expectedVersion: 0 }, stale.db), /review item assignment changed/);
});

test("a notification fault never blocks the assignment", async () => {
  const db = new FakeDb((sql) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (isVisible(sql)) return [{ subject_fund_id: "fund-1" }];
    if (sql.includes("set_review_item_assignee")) return [threadRow({ version: 1 })];
    if (isLabels(sql)) return labelRows([PRIYA, "priya.nair@example.test"]);
    return [];
  });
  db.failExecute = isOutbox;
  const outcome = await new PostgresReviewDiscussionBackend(() => db).assign(identity(), observation, { assigneeUserId: PRIYA, expectedVersion: 0 }, db);
  assert.equal(outcome.change?.fundId, "fund-1");
  assert.ok(db.executed.some((entry) => entry.sql.startsWith("rollback to savepoint")));
});

test("a comment is recorded once, notifies each mentioned teammate but not its author, and says nothing about its text in the notice", async () => {
  const db = new FakeDb((sql, parameters) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (isVisible(sql)) return [{ subject_fund_id: "fund-1" }];
    if (sql.includes("add_review_item_comment")) return [commentRow({ comment_id: parameters[6] as string, mentioned_user_ids: [PRIYA, ME, MARCUS] })];
    if (isThreadRead(sql)) return [threadRow({ assignee_user_id: PRIYA, comment_count: 1 })];
    if (isLabels(sql)) return labelRows([ME, "me@example.test"], [PRIYA, "priya.nair@example.test"], [MARCUS, "marcus.chen@example.test"]);
    return [];
  });
  const command: AddReviewCommentCommand = { idempotencyKey: "k-1", body: "Please check page 4.", mentionUserIds: [PRIYA, ME, MARCUS] };
  const outcome = await new PostgresReviewDiscussionBackend(() => db).comment(identity(), observation, command, db);
  assert.equal(outcome.created, true);
  assert.equal(outcome.fundId, "fund-1");
  assert.deepEqual(outcome.comment.author, { userId: ME, displayName: "me@example.test", isMe: true });
  assert.deepEqual(outcome.comment.mentions.map((mention) => mention.displayName), ["priya.nair@example.test", "me@example.test", "marcus.chen@example.test"]);
  assert.equal(outcome.comment.body, "Please check page 4.");
  assert.equal(outcome.comment.createdAt, "2026-10-01T11:00:00.123Z");
  assert.equal(outcome.thread.commentCount, 1);

  const call = db.calls.find((entry) => entry.sql.includes("add_review_item_comment"))!;
  assert.match(String(call.parameters[6]), /^[0-9a-f-]{36}$/, "the comment id is made by the application so a replay can be told from a new comment");
  assert.deepEqual([call.parameters[7], call.parameters[8], call.parameters[9]], ["oidc", "idp|me", "k-1"]);
  assert.equal(call.parameters[10], commentFingerprint(observation, command));
  assert.equal(call.parameters[11], "Please check page 4.");
  assert.equal(call.parameters[12], JSON.stringify([PRIYA, ME, MARCUS]));

  const outbox = db.executed.filter((entry) => isOutbox(entry.sql));
  assert.deepEqual(outbox.map((entry) => entry.parameters[2]), [PRIYA, MARCUS], "the author is not notified of their own mention");
  for (const entry of outbox) {
    assert.equal(entry.parameters[1], "review_discussion");
    assert.equal(entry.parameters[6], JSON.stringify({ event: "mentioned" }));
    assert.match(String(entry.parameters[7]), /^review_discussion:mention:[0-9a-f-]{36}:/);
    assert.ok(!entry.parameters.some((value) => typeof value === "string" && value.includes("Please check page 4")), "no comment text reaches the outbox");
  }
  assert.ok(!db.executed.some((entry) => entry.parameters.some((value) => typeof value === "string" && value.includes("Please check page 4"))), "no comment text is written anywhere but the comment");
});

test("a replayed comment answers with the original and notifies nobody again", async () => {
  const db = new FakeDb((sql) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (isVisible(sql)) return [{ subject_fund_id: "fund-1" }];
    if (sql.includes("add_review_item_comment")) return [commentRow()];
    if (isThreadRead(sql)) return [threadRow({ assignee_user_id: null, assignment_changed_at: null })];
    if (isLabels(sql)) return labelRows([ME, "me@example.test"], [PRIYA, "priya.nair@example.test"]);
    return [];
  });
  const outcome = await new PostgresReviewDiscussionBackend(() => db).comment(identity(), observation, { idempotencyKey: "k-1", body: "Please check page 4.", mentionUserIds: [PRIYA] }, db);
  assert.equal(outcome.created, false, "the function returned a comment this call did not make");
  assert.equal(outcome.comment.commentId, COMMENT);
  assert.equal(outcome.thread.assignee, null);
  assert.equal(db.executed.filter((entry) => isOutbox(entry.sql)).length, 0);
});

test("comments refuse what cannot be an item or a person, map the one benign race and surface everything else", async () => {
  const known = (sql: string): PostgresRow[] => isActor(sql) ? [{ user_id: ME }] : isVisible(sql) ? [{ subject_fund_id: "fund-1" }] : [];
  const command: AddReviewCommentCommand = { idempotencyKey: "k-1", body: "x", mentionUserIds: [] };
  const make = (handler: (sql: string) => PostgresRow[]) => { const db = new FakeDb(handler); return { db, backend: new PostgresReviewDiscussionBackend(() => db) }; };

  const badMention = make(known);
  await assert.rejects(() => badMention.backend.comment(identity(), observation, { ...command, mentionUserIds: ["not-a-uuid"] }, badMention.db), refusal("mention_not_eligible", 422));
  assert.ok(!badMention.db.calls.some((call) => call.sql.includes("add_review_item_comment")));
  const hidden = make((sql) => isActor(sql) ? [{ user_id: ME }] : []);
  await assert.rejects(() => hidden.backend.comment(identity(), observation, command, hidden.db), refusal("review_item_not_found", 404));

  const race = make((sql) => { if (sql.includes("add_review_item_comment")) throw Object.assign(new Error("duplicate key"), { code: "23505" }); return known(sql); });
  await assert.rejects(() => race.backend.comment(identity(), observation, command, race.db), refusal("review_comment_conflict", 409));
  const failing = make((sql) => { if (sql.includes("add_review_item_comment")) throw new Error("review mention not eligible"); return known(sql); });
  await assert.rejects(() => failing.backend.comment(identity(), observation, command, failing.db), /review mention not eligible/);
  const withoutCode = make((sql) => { if (sql.includes("add_review_item_comment")) throw null; return known(sql); });
  await assert.rejects(() => withoutCode.backend.comment(identity(), observation, command, withoutCode.db), (error) => error === null);

  const noRow = make(known);
  await assert.rejects(() => noRow.backend.comment(identity(), observation, command, noRow.db), /review comment was not recorded/);
  const noThread = make((sql) => sql.includes("add_review_item_comment") ? [commentRow()] : known(sql));
  await assert.rejects(() => noThread.backend.comment(identity(), observation, command, noThread.db), /review item thread was not found/);
});

test("a thread lists its assignee, comments oldest first and everyone who may be assigned, flagging the caller", async () => {
  const db = new FakeDb((sql) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (isVisible(sql)) return [{ subject_fund_id: "fund-1" }];
    if (isThreadRead(sql)) return [threadRow({ assignee_user_id: PRIYA, comment_count: 2, version: 4 })];
    if (sql.includes("from corvis_control.review_item_comment")) return [
      commentRow({ comment_id: COMMENT, mentioned_user_ids: [PRIYA] }),
      commentRow({ comment_id: "55555555-5555-4555-8555-555555555555", author_user_id: PRIYA, body: "Done.", mentioned_user_ids: [], created_at: "2026-10-01 12:00:00+00" }),
      commentRow({ comment_id: "44444444-4444-4444-8444-444444444445", author_user_id: "22222222-2222-4222-8222-222222222222", body: "Left the company.", mentioned_user_ids: null }),
    ];
    if (sql.includes("review_eligible_members")) return [
      { user_id: ME, member_label: "me@example.test", member_roles: ["reviewer"] },
      { user_id: PRIYA, member_label: "priya.nair@example.test", member_roles: ["accountadmin", "reviewer"] },
      { user_id: MARCUS, member_label: "marcus.chen@example.test", member_roles: ["tenant_admin"] },
    ];
    if (isLabels(sql)) return labelRows([ME, "me@example.test"], [PRIYA, "priya.nair@example.test"], ["22222222-2222-4222-8222-222222222222", null]);
    return [];
  });
  const thread = await new PostgresReviewDiscussionBackend(() => db).getThread(identity(), observation, db);
  assert.deepEqual([thread.version, thread.commentCount, thread.assignee?.displayName, thread.assignee?.isMe], [4, 2, "priya.nair@example.test", false]);
  assert.deepEqual(thread.comments.map((comment) => [comment.author.displayName, comment.author.isMe, comment.body, comment.mentions.length]), [
    ["me@example.test", true, "Please check page 4.", 1],
    ["priya.nair@example.test", false, "Done.", 0],
    ["Former member", false, "Left the company.", 0],
  ]);
  assert.deepEqual(thread.members, [
    { userId: ME, displayName: "me@example.test", isMe: true, roleLabel: "Review Analyst" },
    { userId: PRIYA, displayName: "priya.nair@example.test", isMe: false, roleLabel: "Workspace Admin" },
    { userId: MARCUS, displayName: "marcus.chen@example.test", isMe: false, roleLabel: "Organization Admin" },
  ]);
  const members = db.calls.find((call) => call.sql.includes("review_eligible_members"))!;
  assert.deepEqual(members.parameters, [TENANT, WORKSPACE, "fund-1"], "who is eligible is decided for the item's own fund");
});

test("a thread nobody has touched is empty, and an item the caller cannot read is a 404", async () => {
  const db = new FakeDb((sql) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (isVisible(sql)) return [{ subject_fund_id: "fund-1" }];
    return [];
  });
  const backend = new PostgresReviewDiscussionBackend(() => db);
  assert.deepEqual(await backend.getThread(identity(), observation, db), { ...observation, assignee: null, assignedAt: null, version: 0, commentCount: 0, lastCommentAt: null, comments: [], members: [] });
  assert.ok(!db.calls.some((call) => isLabels(call.sql)), "nobody to name, so no label lookup");
  const hidden = new FakeDb((sql) => isActor(sql) ? [{ user_id: ME }] : []);
  await assert.rejects(() => new PostgresReviewDiscussionBackend(() => hidden).getThread(identity(), observation, hidden), refusal("review_item_not_found", 404));
  await assert.rejects(() => backend.getThread(identity(), { subjectKind: "reconciliation_exception", subjectId: "not-a-uuid" }, db), refusal("review_item_not_found", 404));
  const stranger = new FakeDb(() => []);
  await assert.rejects(() => new PostgresReviewDiscussionBackend(() => stranger).getThread(identity({ authMethod: "demo" }), observation, stranger), refusal("human_identity_required", 403));
});

test("the thread index is keyset paged over items the caller can read, and a tampered cursor never reaches SQL", async () => {
  const rows = [
    threadRow({ subject_id: OBS }),
    threadRow({ subject_id: OBS_2, assignee_user_id: null, assignment_changed_at: null, comment_count: 3, version: 0 }),
    threadRow({ subject_kind: "reconciliation_exception", subject_id: EXC, assignee_user_id: ME }),
  ];
  const db = new FakeDb((sql) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (sql.includes("from corvis_control.review_item_thread t")) return rows;
    if (isLabels(sql)) return labelRows([PRIYA, "priya.nair@example.test"], [ME, "me@example.test"]);
    return [];
  });
  const backend = new PostgresReviewDiscussionBackend(() => db);
  const first = await backend.listThreads(identity(), { limit: 2 }, db);
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.items.map((item) => [item.subjectId, item.assignee?.displayName ?? null, item.commentCount]), [[OBS, "priya.nair@example.test", 1], [OBS_2, null, 3]]);
  assert.equal(decodeCursor(first.nextCursor!), `observation|${OBS_2}`);
  const query = db.calls.find((call) => call.sql.includes("from corvis_control.review_item_thread t"))!;
  assert.match(query.sql, /resolve_review_subject\(t\.tenant_id,t\.subject_kind,t\.subject_id/, "only items the caller can read are listed");
  assert.equal(query.sql.includes("> ($5"), false, "no keyset predicate on the first page");
  assert.deepEqual(query.parameters.slice(0, 2), [TENANT, WORKSPACE]);
  assert.equal(query.parameters[query.parameters.length - 1], 3, "one more than the page, to know whether there is a next page");

  const last = await backend.listThreads(identity(), { limit: 3, cursor: first.nextCursor }, db);
  assert.equal(last.nextCursor, null);
  const second = db.calls.filter((call) => call.sql.includes("from corvis_control.review_item_thread t")).at(-1)!;
  assert.match(second.sql, /\(t\.subject_kind,t\.subject_id\) > \(\$5::text,\$6::uuid\)/);
  assert.deepEqual(second.parameters.slice(4, 6), ["observation", OBS_2]);

  const before = db.calls.length;
  for (const cursor of ["!!!", encodeCursor("no-separator"), encodeCursor(`document|${OBS}`), encodeCursor(`observation|not-a-uuid`)]) {
    await assert.rejects(() => backend.listThreads(identity(), { limit: 2, cursor }, db), InvalidCursorError, cursor);
  }
  assert.equal(db.calls.length, before, "a tampered cursor is refused before any query");

  assert.deepEqual(await backend.listThreads(identity({ workspaceId: "workspace_demo" }), { limit: 2 }, db), { items: [], nextCursor: null });
  const empty = new FakeDb((sql) => isActor(sql) ? [{ user_id: ME }] : []);
  assert.deepEqual(await new PostgresReviewDiscussionBackend(() => empty).listThreads(identity(), { limit: 5 }, empty), { items: [], nextCursor: null });
  assert.ok(!empty.calls.some((call) => isLabels(call.sql)));
});

test("a person with no active identity cannot list threads", async () => {
  const db = new FakeDb(() => []);
  await assert.rejects(() => new PostgresReviewDiscussionBackend(() => db).listThreads(identity(), { limit: 2 }, db), refusal("human_identity_required", 403));
});

test("open assignments are the caller's own, with the attention wording, blocking exceptions first", async () => {
  const db = new FakeDb((sql) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (sql.includes("t.assignee_user_id=$3::uuid")) return [
      { subject_kind: "observation", subject_id: OBS, assignment_changed_at: "2026-10-02 10:00:00+00", company_name: "Northstar Health", metric_code: "fair_value", economic_period: "Q2 2026", fund_name: "Nordic Capital Fund V", period_snapshot_id: SNAPSHOT },
      { subject_kind: "observation", subject_id: OBS_2, assignment_changed_at: "2026-10-03 10:00:00+00", company_name: null, metric_code: null, economic_period: null, fund_name: null, period_snapshot_id: null },
      { subject_kind: "reconciliation_exception", subject_id: EXC, assignment_changed_at: "2026-10-01 10:00:00+00", summary: "Competing revenue values", exception_type: "source_authority", exception_period: "Q2 2026", fund_name: "EQT IX", exception_snapshot_id: SNAPSHOT },
    ];
    return [];
  });
  const items = await new PostgresReviewDiscussionBackend(() => db).assignedToMe(identity(), db);
  assert.deepEqual(items.map((item) => [item.subjectKind, item.severity, item.title]), [
    ["reconciliation_exception", "blocking", "Competing revenue values"],
    ["observation", "high", "Observation"],
    ["observation", "high", "Northstar Health · fair_value"],
  ]);
  assert.equal(items[0]!.snapshotId, SNAPSHOT);
  assert.equal(items[1]!.snapshotId, undefined);
  assert.equal(items[2]!.detail, "Nordic Capital Fund V · Q2 2026 · Assigned to you for review.");
  const query = db.calls.find((call) => call.sql.includes("t.assignee_user_id=$3::uuid"))!;
  assert.deepEqual(query.parameters.slice(0, 3), [TENANT, WORKSPACE, ME], "the assignee is the caller's own user id, never a client value");
  assert.match(query.sql, /lower\(o\.review_state\) not in \('approved','rejected'\)/, "decided observations are no longer attention");
  assert.match(query.sql, /e\.status='open'/, "resolved exceptions are no longer attention");
  assert.equal(await new PostgresReviewDiscussionBackend(() => db).assignedToMe(identity({ workspaceId: "workspace_demo" }), db).then((rows) => rows.length), 0);
});

test("timestamps that are not dates are passed through rather than crashing the read", async () => {
  const db = new FakeDb((sql) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (isVisible(sql)) return [{ subject_fund_id: "fund-1" }];
    if (isThreadRead(sql)) return [threadRow({ assignment_changed_at: "not a date", last_comment_at: null })];
    if (isLabels(sql)) return labelRows([PRIYA, "priya.nair@example.test"]);
    return [];
  });
  const thread = await new PostgresReviewDiscussionBackend(() => db).getThread(identity(), observation, db);
  assert.equal(thread.assignedAt, "not a date");
  assert.equal(thread.lastCommentAt, null);
});

test("the default connection is only used when none is passed", async () => {
  const db = new FakeDb((sql) => isActor(sql) ? [{ user_id: ME }] : []);
  const backend = new PostgresReviewDiscussionBackend(() => db);
  assert.equal(backend.demo, false);
  assert.deepEqual(await backend.listThreads(identity(), { limit: 1 }), { items: [], nextCursor: null });
  assert.deepEqual(await backend.assignedToMe(identity()), []);
});

test("an identity with no fund or document entitlement list fails closed: nothing is passed as entitled", async () => {
  const db = new FakeDb((sql, parameters) => {
    if (isActor(sql)) return [{ user_id: ME }];
    if (isVisible(sql)) return parameters[3] === "[]" && parameters[4] === "[]" ? [] : [{ subject_fund_id: "fund-1" }];
    return [];
  });
  const bare = identity({ entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false } });
  await assert.rejects(() => new PostgresReviewDiscussionBackend(() => db).getThread(bare, observation, db), refusal("review_item_not_found", 404));
  const call = db.calls.find((entry) => isVisible(entry.sql))!;
  assert.deepEqual(call.parameters.slice(3), ["[]", "[]"]);
});
