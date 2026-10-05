import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent, RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { MAX_REVIEW_COMMENTS_PER_THREAD, type ReviewSubjectRef } from "../domain/review-discussion.ts";
import { DEMO_EXCEPTIONS, DemoReviewDiscussionStore, demoMemberId, demoReviewDiscussionStore, demoSubjectResolver } from "../adapters/review-discussion-store.ts";
import { InvalidCursorError, encodeCursor } from "../../../platform/http/pagination.ts";
import { ReviewDiscussionRequestError } from "./review-discussion.ts";

// See src/modules/sources/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_DATABASE_DSN;

// Demo mode must never reach a database: any outbound request fails the test that made it.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`unexpected network call in demo mode: ${url}${init?.method ? ` ${init.method}` : ""}`);
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { GET: listGet } = await import("@/app/api/v1/review-items/route");
const { GET: assignedGet } = await import("@/app/api/v1/review-items/assigned/route");
const { GET: threadGet } = await import("@/app/api/v1/review-items/[subjectKind]/[subjectId]/route");
const { PUT: assigneePut } = await import("@/app/api/v1/review-items/[subjectKind]/[subjectId]/assignee/route");
const { POST: commentPost } = await import("@/app/api/v1/review-items/[subjectKind]/[subjectId]/comments/route");
const { POST: reviewPost } = await import("@/app/api/v1/review/route");
const { reviewDiscussionService, demoReviewDiscussionService, postgresReviewDiscussionService, overrideReviewDiscussionService, createReviewDiscussionService } = await import("./review-discussion-service.ts");
const { platform } = await import("../../../platform/data/platform.ts");
const { demoCustomerJourneyStore } = await import("../../../platform/demo/customer-journey-store.ts");

const NOW = new Date("2026-10-02T12:00:00.000Z");
const refusal = (code: string, status: number) => (error: unknown) => error instanceof ReviewDiscussionRequestError && error.code === code && error.status === status;
const obs = (subjectId: string): ReviewSubjectRef => ({ subjectKind: "observation", subjectId });
const exception: ReviewSubjectRef = { subjectKind: "reconciliation_exception", subjectId: "demo-source-authority" };
const PRIYA = "demo-member-priya";
const MARCUS = "demo-member-marcus";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "demo-user", tenantId: "tenant-store", workspaceId: "workspace-store", roles: ["reviewer"], authMethod: "demo", sessionId: "s",
    entitlements: { workspaceIds: ["workspace-store"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const store = () => new DemoReviewDiscussionStore(() => NOW);
const me = () => demoMemberId("demo-user");

test("the demo's people are the signed-in person and two review teammates, and a teammate who signs in is themselves", async () => {
  const demo = store();
  const thread = await demo.getThread(identity(), obs("obs-4"));
  assert.deepEqual(thread.members.map((member) => [member.userId, member.displayName, member.roleLabel, member.isMe]), [
    [me(), "demo-user", "Review Analyst", true],
    [PRIYA, "priya.nair@example.test", "Review Analyst", false],
    [MARCUS, "marcus.chen@example.test", "Review Analyst", false],
  ]);
  const admin = await demo.getThread(identity({ roles: ["admin"], isTenantAdmin: true, authenticatedEmail: "boss@example.test" }), obs("obs-4"));
  assert.deepEqual([admin.members[0]!.displayName, admin.members[0]!.roleLabel], ["boss@example.test", "Organization Admin"]);
  assert.equal((await demo.getThread(identity({ roles: ["admin"] }), obs("obs-4"))).members[0]!.roleLabel, "Workspace Admin");
  const priya = await demo.getThread(identity({ subject: "priya.nair@example.test" }), obs("obs-4"));
  assert.deepEqual(priya.members.map((member) => [member.displayName, member.isMe]), [["priya.nair@example.test", true], ["marcus.chen@example.test", false]], "a teammate is not listed twice");
  assert.equal(demoMemberId("priya.nair@example.test"), PRIYA);
  assert.equal(demoMemberId("a b|c@x"), "demo-self-a_b_c_x");
  assert.equal(demoMemberId("x".repeat(300)).length, "demo-self-".length + 100);
  assert.strictEqual(demoReviewDiscussionStore(), demoReviewDiscussionStore());
});

test("an item is resolved from what the demo shows: observations, uploads and the demo exception, nothing else", () => {
  assert.deepEqual(demoSubjectResolver(obs("obs-4")), {
    fundId: "fund-nordic-v", fundLabel: "Nordic Capital Fund V", period: "30 Jun 2026", snapshotId: "seed-snapshot-2", company: "Northstar Health", metric: "Fair value", open: true,
  });
  assert.equal(demoSubjectResolver(obs("obs-1"))?.open, false, "an approved observation is not open work");
  assert.equal(demoSubjectResolver(obs("obs_0a1b2c3d"))?.open, true);
  assert.equal(demoSubjectResolver(obs("obs_nothex")), undefined);
  assert.equal(demoSubjectResolver(obs("obs-99")), undefined);
  assert.equal(demoSubjectResolver(exception)?.snapshotId, "seed-snapshot-2");
  assert.equal(demoSubjectResolver({ subjectKind: "reconciliation_exception", subjectId: "nope" }), undefined);
  assert.equal(demoSubjectResolver({ subjectKind: "reconciliation_exception", subjectId: "toString" }), undefined, "an id is looked up as data, never as a property");
});

test("the demo exception matches the one the customer demo shows, so a thread can be opened on what the person sees", () => {
  const shown = demoCustomerJourneyStore.listReconciliationExceptions("seed-snapshot-2", 1);
  assert.equal(shown.length, 1);
  const known = DEMO_EXCEPTIONS.get(shown[0]!.exceptionId)!;
  assert.ok(known, "the exception id the UI shows is one the discussion store knows");
  assert.deepEqual([known.fundId, known.period, known.snapshotId, known.summary, known.type], [shown[0]!.fundId, shown[0]!.reportPeriod, shown[0]!.snapshotId, shown[0]!.summary, shown[0]!.type]);
});

test("an observation is assigned, reassigned and unassigned, and only the current version may change it", async () => {
  const demo = store();
  const first = await demo.assign(identity(), obs("obs-4"), { assigneeUserId: PRIYA, expectedVersion: 0 });
  assert.deepEqual([first.thread.assignee?.userId, first.thread.assignee?.isMe, first.thread.version, first.thread.assignedAt, first.change], [PRIYA, false, 1, NOW.toISOString(), { previousAssigneeUserId: null, fundId: "fund-nordic-v" }]);
  const same = await demo.assign(identity(), obs("obs-4"), { assigneeUserId: PRIYA, expectedVersion: 1 });
  assert.deepEqual([same.change, same.thread.version], [null, 1], "assigning the person who holds it changes nothing");
  await assert.rejects(() => demo.assign(identity(), obs("obs-4"), { assigneeUserId: MARCUS, expectedVersion: 0 }), refusal("assignment_changed", 409));
  const reassigned = await demo.assign(identity(), obs("obs-4"), { assigneeUserId: me(), expectedVersion: 1 });
  assert.deepEqual([reassigned.thread.assignee?.isMe, reassigned.thread.version, reassigned.change?.previousAssigneeUserId], [true, 2, PRIYA]);
  const cleared = await demo.assign(identity(), obs("obs-4"), { assigneeUserId: null, expectedVersion: 2 });
  assert.deepEqual([cleared.thread.assignee, cleared.thread.assignedAt, cleared.thread.version, cleared.change?.previousAssigneeUserId], [null, null, 3, me()]);
  assert.equal((await demo.assign(identity(), obs("obs-4"), { assigneeUserId: null, expectedVersion: 3 })).change, null, "unassigning an unassigned item changes nothing");
  assert.equal((await demo.assign(identity(), obs("obs-5"), { assigneeUserId: null, expectedVersion: 0 })).thread.version, 0, "an item nobody touched stays at version 0");
});

test("only people with review access can be assigned, and only items the demo knows can be opened", async () => {
  const demo = store();
  for (const assigneeUserId of ["demo-member-jordan", "someone-else", "00000000-0000-4000-8000-000000000002"]) {
    await assert.rejects(() => demo.assign(identity(), obs("obs-4"), { assigneeUserId, expectedVersion: 0 }), refusal("assignee_not_eligible", 422), assigneeUserId);
  }
  await assert.rejects(() => demo.assign(identity(), obs("obs-99"), { assigneeUserId: PRIYA, expectedVersion: 0 }), refusal("review_item_not_found", 404));
  await assert.rejects(() => demo.getThread(identity(), obs("obs-99")), refusal("review_item_not_found", 404));
  await assert.rejects(() => demo.comment(identity(), obs("obs-99"), { idempotencyKey: "k", body: "x", mentionUserIds: [] }), refusal("review_item_not_found", 404));
  assert.equal((await demo.getThread(identity(), obs("obs-4"))).version, 0, "refusals created no thread");
  assert.equal((await demo.listThreads(identity(), { limit: 10 })).items.length, 0);
});

test("a comment is appended once, keyed per author, with only eligible people mentioned", async () => {
  const demo = store();
  const command = { idempotencyKey: "k-1", body: "Please check page 52.", mentionUserIds: [PRIYA] };
  const first = await demo.comment(identity(), obs("obs-4"), command);
  assert.equal(first.created, true);
  assert.equal(first.fundId, "fund-nordic-v");
  assert.deepEqual([first.comment.author.isMe, first.comment.mentions.map((mention) => mention.displayName), first.comment.createdAt], [true, ["priya.nair@example.test"], NOW.toISOString()]);
  assert.deepEqual([first.thread.commentCount, first.thread.lastCommentAt, first.thread.version], [1, NOW.toISOString(), 0], "a comment moves no assignment version");

  const again = await demo.comment(identity(), obs("obs-4"), command);
  assert.deepEqual([again.created, again.comment.commentId, again.thread.commentCount], [false, first.comment.commentId, 1]);
  await assert.rejects(() => demo.comment(identity(), obs("obs-4"), { ...command, body: "different" }), refusal("idempotency_key_reused", 409));
  await assert.rejects(() => demo.comment(identity(), obs("obs-5"), command), refusal("idempotency_key_reused", 409), "a key is the author's across items");
  const colleague = await demo.comment(identity({ subject: "priya.nair@example.test" }), obs("obs-4"), command);
  assert.equal(colleague.created, true, "keys are per author");
  assert.equal(colleague.comment.author.userId, PRIYA);
  assert.equal(colleague.comment.author.isMe, true);

  await assert.rejects(() => demo.comment(identity(), obs("obs-4"), { idempotencyKey: "k-2", body: "hi", mentionUserIds: ["demo-member-jordan"] }), refusal("mention_not_eligible", 422));
  assert.equal((await demo.getThread(identity(), obs("obs-4"))).commentCount, 2, "a refused comment is not recorded");

  const thread = await demo.getThread(identity(), obs("obs-4"));
  assert.deepEqual(thread.comments.map((comment) => comment.body), ["Please check page 52.", "Please check page 52."]);
  assert.equal(thread.comments[0]!.author.isMe, true);
  assert.equal(thread.comments[1]!.author.isMe, false, "who is 'me' is decided per viewer");
  const viewedByPriya = await demo.getThread(identity({ subject: "priya.nair@example.test" }), obs("obs-4"));
  assert.deepEqual(viewedByPriya.comments.map((comment) => comment.author.isMe), [false, true]);
});

test("a thread holds at most 200 comments", async () => {
  const demo = store();
  for (let index = 0; index < MAX_REVIEW_COMMENTS_PER_THREAD; index += 1) await demo.comment(identity(), obs("obs-4"), { idempotencyKey: `bulk-${index}`, body: `Comment ${index}`, mentionUserIds: [] });
  await assert.rejects(() => demo.comment(identity(), obs("obs-4"), { idempotencyKey: "one-too-many", body: "x", mentionUserIds: [] }), refusal("review_comment_limit_reached", 409));
  assert.equal((await demo.getThread(identity(), obs("obs-4"))).commentCount, MAX_REVIEW_COMMENTS_PER_THREAD);
  assert.equal((await demo.comment(identity(), obs("obs-4"), { idempotencyKey: "bulk-0", body: "Comment 0", mentionUserIds: [] })).created, false, "a replay is still answered at the limit");
});

test("threads are per tenant and workspace, listed in a stable order and paged by an opaque cursor", async () => {
  const demo = store();
  await demo.assign(identity(), obs("obs-5"), { assigneeUserId: PRIYA, expectedVersion: 0 });
  await demo.comment(identity(), obs("obs-4"), { idempotencyKey: "k", body: "x", mentionUserIds: [] });
  await demo.comment(identity(), exception, { idempotencyKey: "k-exc", body: "x", mentionUserIds: [] });
  await demo.assign(identity(), obs("obs-1"), { assigneeUserId: null, expectedVersion: 0 });
  const all = await demo.listThreads(identity(), { limit: 10 });
  assert.deepEqual(all.items.map((item) => item.subjectId), ["obs-4", "obs-5", "demo-source-authority"], "observations first, in id order, then exceptions; an untouched item is not listed");
  assert.equal(all.nextCursor, null);
  const first = await demo.listThreads(identity(), { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const rest = await demo.listThreads(identity(), { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(rest.items.map((item) => item.subjectId), ["demo-source-authority"]);
  assert.equal(rest.nextCursor, null);
  for (const cursor of ["!!!", encodeCursor("document:x")]) await assert.rejects(() => demo.listThreads(identity(), { limit: 2, cursor }), InvalidCursorError);
  assert.equal((await demo.listThreads(identity({ tenantId: "tenant-other" }), { limit: 10 })).items.length, 0);
  assert.equal((await demo.listThreads(identity({ workspaceId: "workspace-other" }), { limit: 10 })).items.length, 0);
});

test("a thread whose item the demo no longer knows is not listed", async () => {
  let known = true;
  const demo = new DemoReviewDiscussionStore(() => NOW, (ref) => known ? demoSubjectResolver(ref) : undefined);
  await demo.assign(identity(), obs("obs-4"), { assigneeUserId: PRIYA, expectedVersion: 0 });
  assert.equal((await demo.listThreads(identity(), { limit: 10 })).items.length, 1);
  known = false;
  assert.equal((await demo.listThreads(identity(), { limit: 10 })).items.length, 0);
});

test("the caller's open assignments name the work, blocking exceptions first, and skip what is decided", async () => {
  const demo = store();
  await demo.assign(identity(), obs("obs-4"), { assigneeUserId: me(), expectedVersion: 0 });
  await demo.assign(identity(), obs("obs-1"), { assigneeUserId: me(), expectedVersion: 0 });
  await demo.assign(identity(), obs("obs-5"), { assigneeUserId: PRIYA, expectedVersion: 0 });
  await demo.assign(identity(), exception, { assigneeUserId: me(), expectedVersion: 0 });
  await demo.comment(identity(), obs("obs-3"), { idempotencyKey: "k", body: "commented, not assigned", mentionUserIds: [] });
  const items = await demo.assignedToMe(identity());
  assert.deepEqual(items.map((item) => [item.subjectKind, item.subjectId, item.severity, item.snapshotId]), [
    ["reconciliation_exception", "demo-source-authority", "blocking", "seed-snapshot-2"],
    ["observation", "obs-4", "high", "seed-snapshot-2"],
  ], "approved obs-1, someone else's obs-5 and the merely-commented obs-3 are not mine to act on");
  assert.equal(items[1]!.title, "Northstar Health · Fair value");
  assert.deepEqual((await demo.assignedToMe(identity({ subject: "priya.nair@example.test" }))).map((item) => item.subjectId), ["obs-5"]);
  assert.deepEqual(await demo.assignedToMe(identity({ subject: "nobody" })), []);
});

// ---------------------------------------------------------------------------------------------------------- routes

type Options = { tenant?: string; subject?: string; roles?: string; method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> };
function request(path: string, options: Options = {}): Request {
  const method = options.method ?? "GET";
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-corvis-demo-tenant": options.tenant ?? "tenant-routes",
      "x-corvis-demo-subject": options.subject ?? "route-user",
      "x-corvis-demo-roles": options.roles ?? "reviewer",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: hasBody ? (options.rawBody ?? JSON.stringify(options.body)) : undefined,
  });
}
const params = (subjectKind: string, subjectId: string) => ({ params: Promise.resolve({ subjectKind, subjectId }) });
type Person = { userId: string; displayName: string; isMe: boolean };
type ThreadJson = { subjectKind: string; subjectId: string; assignee: Person | null; assignedAt: string | null; version: number; commentCount: number; comments: Array<{ commentId: string; body: string; author: Person; mentions: Person[] }>; members: Array<Person & { roleLabel: string }> };
type Body = { error?: string; replayed?: boolean; correlationId?: string; nextCursor?: string | null; data: ThreadJson & Array<ThreadJson & { title: string; severity: string }> & { commentId: string; body: string; mentions: Person[] }; thread?: ThreadJson };
const body = async (response: Response) => (await response.json()) as Body;
const recordAudit = () => {
  const events: AuditEvent[] = [];
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  return { events, restore: () => { port.audit = original; } };
};

test("the demo composition is selected in demo mode and the Postgres one is a separate service", () => {
  assert.equal(reviewDiscussionService(), demoReviewDiscussionService);
  assert.notEqual(demoReviewDiscussionService, postgresReviewDiscussionService);
  const pinned = createReviewDiscussionService(demoReviewDiscussionStore());
  overrideReviewDiscussionService(pinned);
  assert.equal(reviewDiscussionService(), pinned);
  overrideReviewDiscussionService();
  assert.equal(reviewDiscussionService(), demoReviewDiscussionService);
});

test("assigning over the API is audited with identifiers only, and an unchanged assignment is not", async () => {
  const tenant = "tenant-assign";
  const audit = recordAudit();
  try {
    const self = demoMemberId("route-user");
    const read = await body(await threadGet(request("/review-items/observation/obs-4", { tenant }), params("observation", "obs-4")));
    assert.deepEqual([read.data.version, read.data.assignee, read.data.comments, read.data.members.length], [0, null, [], 3]);

    const assign = await assigneePut(request("/review-items/observation/obs-4/assignee", { tenant, method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params("observation", "obs-4"));
    assert.equal(assign.status, 200);
    const assigned = await body(assign);
    assert.deepEqual([assigned.data.assignee?.displayName, assigned.data.version], ["priya.nair@example.test", 1]);

    const unchanged = await assigneePut(request("/review-items/observation/obs-4/assignee", { tenant, method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 1 } }), params("observation", "obs-4"));
    assert.equal(unchanged.status, 200);
    const stale = await assigneePut(request("/review-items/observation/obs-4/assignee", { tenant, method: "PUT", body: { assigneeUserId: self, expectedVersion: 0 } }), params("observation", "obs-4"));
    assert.equal(stale.status, 409);
    assert.equal((await body(stale)).error, "assignment_changed");
    const ineligible = await assigneePut(request("/review-items/observation/obs-4/assignee", { tenant, method: "PUT", body: { assigneeUserId: "nobody", expectedVersion: 1 } }), params("observation", "obs-4"));
    assert.equal(ineligible.status, 422);
    assert.equal((await body(ineligible)).error, "assignee_not_eligible");
    await assigneePut(request("/review-items/observation/obs-4/assignee", { tenant, method: "PUT", body: { assigneeUserId: self, expectedVersion: 1 } }), params("observation", "obs-4"));
    await assigneePut(request("/review-items/observation/obs-4/assignee", { tenant, method: "PUT", body: { assigneeUserId: null, expectedVersion: 2 } }), params("observation", "obs-4"));

    assert.deepEqual(audit.events.map((event) => event.action), ["review_item.assign", "review_item.reassign", "review_item.unassign"], "only real changes are audited");
    assert.deepEqual(audit.events.map((event) => event.targetType), ["review_item", "review_item", "review_item"]);
    assert.equal(audit.events[0]!.targetId, "observation:obs-4");
    assert.deepEqual(audit.events[1]!.metadata, { subjectKind: "observation", subjectId: "obs-4", fundId: "fund-nordic-v", assigneeUserId: self, previousAssigneeUserId: PRIYA, version: 2 });
    assert.equal(audit.events[2]!.metadata?.assigneeUserId, null);
  } finally { audit.restore(); }
});

test("assignment requests are validated before anything happens", async () => {
  const tenant = "tenant-assign-validation";
  const put = (path: string, bodyValue: unknown, kind = "observation", id = "obs-4", rawBody?: string) =>
    assigneePut(request(path, { tenant, method: "PUT", body: rawBody === undefined ? bodyValue : undefined, rawBody }), params(kind, id));
  for (const [bodyValue, error] of [
    [{ expectedVersion: 0 }, "invalid_assignee"], [{ assigneeUserId: 5, expectedVersion: 0 }, "invalid_assignee"],
    [{ assigneeUserId: PRIYA }, "invalid_expected_version"], [{ assigneeUserId: PRIYA, expectedVersion: -1 }, "invalid_expected_version"],
  ] as const) {
    const response = await put("/review-items/observation/obs-4/assignee", bodyValue);
    assert.equal(response.status, 400);
    assert.equal((await body(response)).error, error);
  }
  for (const rawBody of ["not json", "null", "[]"]) {
    const response = await put("/review-items/observation/obs-4/assignee", undefined, "observation", "obs-4", rawBody);
    assert.equal(response.status, 400, rawBody);
    assert.equal((await body(response)).error, "invalid_request");
  }
  assert.equal((await body(await put("/review-items/document/x/assignee", { assigneeUserId: PRIYA, expectedVersion: 0 }, "document", "x"))).error, "invalid_subject_kind");
  assert.equal((await body(await put("/review-items/observation/..%2Fx/assignee", { assigneeUserId: PRIYA, expectedVersion: 0 }, "observation", "../x"))).error, "invalid_subject_id");
  const missing = await put("/review-items/observation/obs-99/assignee", { assigneeUserId: PRIYA, expectedVersion: 0 }, "observation", "obs-99");
  assert.equal(missing.status, 404);
  assert.equal((await body(missing)).error, "review_item_not_found");
});

test("a comment over the API is created once, replayed as 200, audited without its text and mentions only eligible people", async () => {
  const tenant = "tenant-comments";
  const text = "Please confirm which source is authoritative for this value.";
  const audit = recordAudit();
  try {
    const post = (bodyValue: unknown, headers?: Record<string, string>, kind = "observation", id = "obs-4") =>
      commentPost(request(`/review-items/${kind}/${id}/comments`, { tenant, method: "POST", body: bodyValue, headers }), params(kind, id));
    const created = await post({ idempotencyKey: "c-1", body: text, mentionUserIds: [PRIYA] });
    assert.equal(created.status, 201);
    const payload = await body(created);
    assert.equal(payload.replayed, false);
    assert.deepEqual([payload.data.body, payload.data.mentions[0]?.displayName, payload.thread?.commentCount, payload.thread?.version], [text, "priya.nair@example.test", 1, 0]);

    const replay = await post({ body: text, mentionUserIds: [PRIYA] }, { "idempotency-key": "c-1" });
    assert.equal(replay.status, 200);
    const replayed = await body(replay);
    assert.deepEqual([replayed.replayed, replayed.data.commentId], [true, payload.data.commentId]);
    const reused = await post({ idempotencyKey: "c-1", body: "different" });
    assert.equal(reused.status, 409);
    assert.equal((await body(reused)).error, "idempotency_key_reused");
    const ineligible = await post({ idempotencyKey: "c-2", body: text, mentionUserIds: ["demo-member-jordan"] });
    assert.equal(ineligible.status, 422);
    assert.equal((await body(ineligible)).error, "mention_not_eligible");
    assert.equal((await post({ idempotencyKey: "c-3", body: "On the exception." }, undefined, "reconciliation_exception", "demo-source-authority")).status, 201);

    assert.deepEqual(audit.events.map((event) => event.action), ["review_item.comment", "review_item.comment"], "the replay and the refusal were not audited");
    assert.deepEqual(audit.events[0]!.metadata, { subjectKind: "observation", subjectId: "obs-4", fundId: "fund-nordic-v", commentId: payload.data.commentId, mentionedUserIds: [PRIYA], commentLength: text.length });
    for (const event of audit.events) assert.ok(!JSON.stringify(event).includes("authoritative") && !JSON.stringify(event).includes("exception."), "the comment text is never audited");

    const thread = await body(await threadGet(request("/review-items/observation/obs-4", { tenant }), params("observation", "obs-4")));
    assert.deepEqual(thread.data.comments.map((comment) => comment.body), [text]);
    assert.equal(thread.data.comments[0]!.author.isMe, true);
  } finally { audit.restore(); }
});

test("comment requests are validated before anything happens", async () => {
  const tenant = "tenant-comment-validation";
  const post = (bodyValue: unknown, rawBody?: string, headers?: Record<string, string>) =>
    commentPost(request("/review-items/observation/obs-4/comments", { tenant, method: "POST", body: rawBody === undefined ? bodyValue : undefined, rawBody, headers }), params("observation", "obs-4"));
  for (const [bodyValue, error] of [
    [{ body: "x" }, "idempotency_key_required"], [{ idempotencyKey: "k", body: "   " }, "invalid_comment"], [{ idempotencyKey: "k", body: "x".repeat(2001) }, "invalid_comment"],
    [{ idempotencyKey: "k", body: "x", mentionUserIds: "p" }, "invalid_mentions"],
  ] as const) {
    const response = await post(bodyValue);
    assert.equal(response.status, 400);
    assert.equal((await body(response)).error, error);
  }
  assert.equal((await post({ idempotencyKey: "a", body: "x" }, undefined, { "idempotency-key": "b" })).status, 400);
  for (const rawBody of ["not json", "null", "[]"]) assert.equal((await post(undefined, rawBody)).status, 400, rawBody);
});

test("the thread index and the caller's open assignments follow the caller, and the index pages", async () => {
  const tenant = "tenant-index";
  const put = (id: string, assigneeUserId: string | null, expectedVersion: number, subject = "route-user", kind = "observation") =>
    assigneePut(request(`/review-items/${kind}/${id}/assignee`, { tenant, subject, method: "PUT", body: { assigneeUserId, expectedVersion } }), params(kind, id));
  await put("obs-4", demoMemberId("route-user"), 0);
  await put("obs-5", PRIYA, 0);
  await put("demo-source-authority", demoMemberId("route-user"), 0, "route-user", "reconciliation_exception");

  const list = await body(await listGet(request("/review-items", { tenant })));
  assert.deepEqual(list.data.map((item) => [item.subjectId, item.assignee?.isMe]), [["obs-4", true], ["obs-5", false], ["demo-source-authority", true]]);
  assert.equal(list.nextCursor, null);
  const paged = await body(await listGet(request("/review-items?limit=2", { tenant })));
  assert.equal(paged.data.length, 2);
  assert.ok(paged.nextCursor);
  const rest = await body(await listGet(request(`/review-items?limit=2&cursor=${encodeURIComponent(paged.nextCursor)}`, { tenant })));
  assert.deepEqual(rest.data.map((item) => item.subjectId), ["demo-source-authority"]);
  for (const [query, error] of [["limit=0", "invalid_limit"], ["cursor=!!!", "invalid_cursor"]]) {
    const response = await listGet(request(`/review-items?${query}`, { tenant }));
    assert.equal(response.status, 400, query);
    assert.equal((await body(response)).error, error, query);
  }

  const mine = await body(await assignedGet(request("/review-items/assigned", { tenant })));
  assert.deepEqual(mine.data.map((item) => [item.subjectKind, item.severity]), [["reconciliation_exception", "blocking"], ["observation", "high"]]);
  const priyas = await body(await assignedGet(request("/review-items/assigned", { tenant, subject: "priya.nair@example.test" })));
  assert.deepEqual(priyas.data.map((item) => item.subjectId), ["obs-5"]);
  assert.deepEqual((await body(await assignedGet(request("/review-items/assigned", { tenant: "tenant-empty" })))).data, []);
});

test("only review access reaches the routes, and a service identity is refused", async () => {
  for (const roles of ["analyst", "read_only", "api_client"]) {
    for (const response of [
      await listGet(request("/review-items", { roles })),
      await assignedGet(request("/review-items/assigned", { roles })),
      await threadGet(request("/review-items/observation/obs-4", { roles }), params("observation", "obs-4")),
      await assigneePut(request("/review-items/observation/obs-4/assignee", { roles, method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params("observation", "obs-4")),
      await commentPost(request("/review-items/observation/obs-4/comments", { roles, method: "POST", body: { idempotencyKey: "k", body: "x" } }), params("observation", "obs-4")),
    ]) {
      assert.equal(response.status, 403, roles);
      assert.equal((await body(response)).error, "forbidden");
    }
  }
  const service = createReviewDiscussionService(store());
  const machine = identity({ authMethod: "service_account" });
  await assert.rejects(() => service.listThreads(machine, { limit: 1 }), refusal("human_identity_required", 403));
  await assert.rejects(() => service.getThread(machine, obs("obs-4")), refusal("human_identity_required", 403));
  await assert.rejects(() => service.assign(machine, obs("obs-4"), { assigneeUserId: PRIYA, expectedVersion: 0 }, "c"), refusal("human_identity_required", 403));
  await assert.rejects(() => service.comment(machine, obs("obs-4"), { idempotencyKey: "k", body: "x", mentionUserIds: [] }, "c"), refusal("human_identity_required", 403));
  await assert.rejects(() => service.assignedToMe(machine), refusal("human_identity_required", 403));
});

test("discussion never changes what is reviewed or published: no decision is recorded and no data moves", async () => {
  const tenant = "tenant-inert";
  const port = platform();
  const reviewed: unknown[] = [];
  const originalReview = port.review.bind(port);
  port.review = async (who, decision) => { reviewed.push(decision); return originalReview(who, decision); };
  const who = identity({ tenantId: tenant });
  const before = JSON.stringify([await port.listSnapshots(who), await port.listObservations(who), await port.listReconciliationExceptions(who, "seed-snapshot-2", 1)]);
  try {
    await assigneePut(request("/review-items/observation/obs-4/assignee", { tenant, method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params("observation", "obs-4"));
    await commentPost(request("/review-items/observation/obs-4/comments", { tenant, method: "POST", body: { idempotencyKey: "k", body: "I approve this value.", mentionUserIds: [PRIYA] } }), params("observation", "obs-4"));
    await commentPost(request("/review-items/reconciliation_exception/demo-source-authority/comments", { tenant, method: "POST", body: { idempotencyKey: "k2", body: "Resolve as immaterial." } }), params("reconciliation_exception", "demo-source-authority"));
  } finally { port.review = originalReview; }
  assert.deepEqual(reviewed, [], "a comment is not a review decision, so it cannot count toward dual control");
  assert.equal(JSON.stringify([await port.listSnapshots(who), await port.listObservations(who), await port.listReconciliationExceptions(who, "seed-snapshot-2", 1)]), before, "no observation, snapshot or exception changed");
  // The existing review route is still the only way to decide, and discussion left it working.
  const decision = await reviewPost(request("/review", { tenant, roles: "reviewer", method: "POST", body: { observationId: "obs-4", decision: "approve", reasonCode: "reviewer_verified", expectedVersion: 1 } }));
  assert.equal(decision.status, 202);
  assert.equal(reviewed.length, 0, "the stub above was restored; the decision went to the real platform");
});
