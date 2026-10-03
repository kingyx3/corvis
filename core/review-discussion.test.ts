import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNMENT_FILTERS,
  ASSIGNMENT_FILTER_LABEL,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_MENTIONS,
  REVIEW_DISCUSSION_ERROR_MESSAGES,
  REVIEW_SUBJECT_KINDS,
  REVIEW_SUBJECT_KIND_LABEL,
  ReviewDiscussionValidationError,
  appendMention,
  assigneeLabel,
  assignedExceptionItem,
  assignedObservationItem,
  commentSegments,
  isAssignmentFilter,
  isReviewSubjectKind,
  matchesAssignmentFilter,
  mentionedUserIds,
  parseAssignCommand,
  parseCommentCommand,
  parseSubjectRef,
  reviewAssignmentAction,
  reviewItemKey,
  reviewRoleLabel,
  sortAssignedItems,
  type AssignedReviewItem,
} from "./review-discussion.ts";

const USER = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const refuses = (code: string) => (error: unknown) => error instanceof ReviewDiscussionValidationError && error.code === code && error.status === 400;
const me = { userId: "me", displayName: "me@example.test", isMe: true };
const priya = { userId: "priya", displayName: "priya.nair@example.test", isMe: false };

test("subject kinds, role labels and item keys", () => {
  assert.deepEqual([...REVIEW_SUBJECT_KINDS], ["observation", "reconciliation_exception"]);
  assert.equal(REVIEW_SUBJECT_KIND_LABEL.observation, "Observation");
  assert.equal(isReviewSubjectKind("observation"), true);
  assert.equal(isReviewSubjectKind("reconciliation_exception"), true);
  assert.equal(isReviewSubjectKind("document"), false);
  assert.equal(isReviewSubjectKind(undefined), false);
  assert.equal(reviewItemKey({ subjectKind: "observation", subjectId: "obs-1" }), "observation:obs-1");
  assert.equal(reviewRoleLabel(["reviewer"]), "Review Analyst");
  assert.equal(reviewRoleLabel(["reviewer", "accountadmin"]), "Workspace Admin");
  assert.equal(reviewRoleLabel(["reviewer", "tenant_admin", "accountadmin"]), "Organization Admin");
  assert.equal(reviewRoleLabel([]), "Review access");
});

test("audit actions name what changed", () => {
  assert.equal(reviewAssignmentAction(null, "a"), "assign");
  assert.equal(reviewAssignmentAction("a", "b"), "reassign");
  assert.equal(reviewAssignmentAction("a", null), "unassign");
  assert.equal(reviewAssignmentAction(null, null), "unassign");
});

test("a route path names a kind and a bounded id, and nothing else", () => {
  assert.deepEqual(parseSubjectRef("observation", USER), { subjectKind: "observation", subjectId: USER });
  assert.deepEqual(parseSubjectRef("reconciliation_exception", "obs-1"), { subjectKind: "reconciliation_exception", subjectId: "obs-1" });
  assert.throws(() => parseSubjectRef("document", USER), refuses("invalid_subject_kind"));
  for (const bad of ["", " ", "a b", "../x", "x/y", "a".repeat(129), "-leading", "é"]) {
    assert.throws(() => parseSubjectRef("observation", bad), refuses("invalid_subject_id"), JSON.stringify(bad));
  }
});

test("an assignment names an assignee or null, and the version the person saw", () => {
  assert.deepEqual(parseAssignCommand({ assigneeUserId: USER, expectedVersion: 0 }), { assigneeUserId: USER, expectedVersion: 0 });
  assert.deepEqual(parseAssignCommand({ assigneeUserId: null, expectedVersion: 3 }), { assigneeUserId: null, expectedVersion: 3 });
  assert.throws(() => parseAssignCommand(null), refuses("invalid_request"));
  assert.throws(() => parseAssignCommand([]), refuses("invalid_request"));
  assert.throws(() => parseAssignCommand("x"), refuses("invalid_request"));
  assert.throws(() => parseAssignCommand({ expectedVersion: 0 }), refuses("invalid_assignee"), "unassigning must be explicit (null), not an omission");
  for (const bad of [7, "", "has space", "x".repeat(129), {}]) {
    assert.throws(() => parseAssignCommand({ assigneeUserId: bad, expectedVersion: 0 }), refuses("invalid_assignee"), JSON.stringify(bad));
  }
  for (const bad of [undefined, -1, 1.5, "1", 1_000_001, null, Number.NaN]) {
    assert.throws(() => parseAssignCommand({ assigneeUserId: USER, expectedVersion: bad }), refuses("invalid_expected_version"), String(bad));
  }
});

test("a comment needs a key, text within bounds and at most ten distinct valid mentions", () => {
  const ok = parseCommentCommand({ idempotencyKey: " k-1 ", body: "  Please check page 4.  ", mentionUserIds: [USER, USER, "u-2"] });
  assert.deepEqual(ok, { idempotencyKey: "k-1", body: "Please check page 4.", mentionUserIds: [USER, "u-2"] });
  assert.deepEqual(parseCommentCommand({ body: "hello\nworld\ttabbed" }, "header-key"), { idempotencyKey: "header-key", body: "hello\nworld\ttabbed", mentionUserIds: [] });
  assert.deepEqual(parseCommentCommand({ idempotencyKey: "same", body: "x", mentionUserIds: null }, "same").mentionUserIds, []);
  assert.deepEqual(parseCommentCommand({ idempotencyKey: "k", body: "x".repeat(MAX_REVIEW_COMMENT_LENGTH) }).body.length, MAX_REVIEW_COMMENT_LENGTH);

  assert.throws(() => parseCommentCommand(undefined), refuses("invalid_request"));
  assert.throws(() => parseCommentCommand([]), refuses("invalid_request"));
  assert.throws(() => parseCommentCommand({ body: "x" }), refuses("idempotency_key_required"));
  assert.throws(() => parseCommentCommand({ idempotencyKey: "a", body: "x" }, "b"), refuses("invalid_idempotency_key"), "one namespace: two different keys are refused");
  for (const bad of [5, "", "   ", "x".repeat(257), "line\nbreak"]) {
    assert.throws(() => parseCommentCommand({ idempotencyKey: bad, body: "x" }), refuses("invalid_idempotency_key"), JSON.stringify(bad));
  }
  assert.throws(() => parseCommentCommand({ body: "x" }, "x".repeat(257)), refuses("invalid_idempotency_key"));
  for (const bad of [undefined, 5, "", "   ", "x".repeat(MAX_REVIEW_COMMENT_LENGTH + 1), "nul\u0000byte", "bell\u0007", "sep arator"]) {
    assert.throws(() => parseCommentCommand({ idempotencyKey: "k", body: bad }), refuses("invalid_comment"), JSON.stringify(bad));
  }
  assert.throws(() => parseCommentCommand({ idempotencyKey: "k", body: "x", mentionUserIds: "u" }), refuses("invalid_mentions"));
  assert.throws(() => parseCommentCommand({ idempotencyKey: "k", body: "x", mentionUserIds: Array.from({ length: MAX_REVIEW_MENTIONS + 1 }, (_, index) => `u-${index}`) }), refuses("invalid_mentions"));
  assert.throws(() => parseCommentCommand({ idempotencyKey: "k", body: "x", mentionUserIds: [7] }), refuses("invalid_mentions"));
  assert.throws(() => parseCommentCommand({ idempotencyKey: "k", body: "x", mentionUserIds: ["bad id"] }), refuses("invalid_mentions"));
});

test("assignment filters", () => {
  assert.deepEqual([...ASSIGNMENT_FILTERS], ["all", "mine", "unassigned"]);
  assert.equal(ASSIGNMENT_FILTER_LABEL.mine, "Assigned to me");
  assert.equal(ASSIGNMENT_FILTER_LABEL.unassigned, "Unassigned");
  assert.equal(isAssignmentFilter("mine"), true);
  assert.equal(isAssignmentFilter("everyone"), false);
  for (const assignee of [me, priya, null, undefined]) assert.equal(matchesAssignmentFilter("all", assignee), true);
  assert.equal(matchesAssignmentFilter("mine", me), true);
  assert.equal(matchesAssignmentFilter("mine", priya), false);
  assert.equal(matchesAssignmentFilter("mine", null), false);
  assert.equal(matchesAssignmentFilter("mine", undefined), false);
  assert.equal(matchesAssignmentFilter("unassigned", null), true);
  assert.equal(matchesAssignmentFilter("unassigned", undefined), true);
  assert.equal(matchesAssignmentFilter("unassigned", me), false);
  assert.equal(assigneeLabel(null), "Unassigned");
  assert.equal(assigneeLabel(undefined), "Unassigned");
  assert.equal(assigneeLabel(me), "Assigned to you");
  assert.equal(assigneeLabel(priya), "Assigned to priya.nair@example.test");
});

test("mentions are found by the exact @name, never inside a word, and the longest name wins", () => {
  const members = [
    { userId: "u-sam", displayName: "sam@x.test" },
    { userId: "u-sam-au", displayName: "sam@x.test.au" },
    { userId: "u-priya", displayName: "priya.nair@example.test" },
    { userId: "u-empty", displayName: "" },
  ];
  assert.deepEqual(mentionedUserIds("Please look @priya.nair@example.test.", members), ["u-priya"], "a sentence-ending full stop does not cancel the mention");
  assert.deepEqual(mentionedUserIds("@sam@x.test.au and @sam@x.test, thanks", members).sort(), ["u-sam", "u-sam-au"]);
  assert.deepEqual(mentionedUserIds("@sam@x.test.au only", members), ["u-sam-au"], "the shorter name is not found inside the longer one");
  assert.deepEqual(mentionedUserIds("mail me at foo@sam@x.test please", members), [], "a name glued to a word is an address, not a mention");
  assert.deepEqual(mentionedUserIds("@sam@x.testing", members), [], "nor is a name that continues");
  assert.deepEqual(mentionedUserIds("priya.nair@example.test without the at sign", members), []);
  assert.deepEqual(mentionedUserIds("@priya.nair@example.test @priya.nair@example.test twice", members), ["u-priya"], "each person once");
  assert.deepEqual(mentionedUserIds("", members), []);
  const many = Array.from({ length: 15 }, (_, index) => ({ userId: `u-${index}`, displayName: `p${index}@x.test` }));
  assert.equal(mentionedUserIds(many.map((member) => `@${member.displayName}`).join(" "), many).length, MAX_REVIEW_MENTIONS, "never more than the API accepts");
  assert.equal(mentionedUserIds("@a@x.test", [{ userId: "u", displayName: "a@x.test" }, { userId: "v", displayName: "a@x.test" }]).length, 1, "duplicate names collapse");
});

test("appending a mention keeps the text readable", () => {
  assert.equal(appendMention("", priya), "@priya.nair@example.test ");
  assert.equal(appendMention("Please look", priya), "Please look @priya.nair@example.test ");
  assert.equal(appendMention("Please look ", priya), "Please look @priya.nair@example.test ");
  assert.equal(appendMention("line\n", priya), "line\n@priya.nair@example.test ");
});

test("a comment is split so mentions can be shown as such and everything else stays plain text", () => {
  assert.deepEqual(commentSegments("Hi @priya.nair@example.test, please check <b>page 4</b>.", ["priya.nair@example.test"]), [
    { text: "Hi ", mention: false },
    { text: "@priya.nair@example.test", mention: true },
    { text: ", please check <b>page 4</b>.", mention: false },
  ]);
  assert.deepEqual(commentSegments("@a@x.test @a@x.test", ["a@x.test"]), [
    { text: "@a@x.test", mention: true }, { text: " ", mention: false }, { text: "@a@x.test", mention: true },
  ]);
  assert.deepEqual(commentSegments("plain", ["a@x.test"]), [{ text: "plain", mention: false }]);
  assert.deepEqual(commentSegments("", []), []);
});

test("error messages are plain language for each stable code", () => {
  for (const code of ["review_item_not_found", "assignee_not_eligible", "mention_not_eligible", "assignment_changed", "idempotency_key_reused", "review_comment_limit_reached", "human_identity_required", "invalid_comment", "invalid_mentions"]) {
    assert.ok((REVIEW_DISCUSSION_ERROR_MESSAGES[code] ?? "").length > 20, code);
  }
});

test("assigned observations and exceptions become attention rows", () => {
  assert.deepEqual(assignedObservationItem({ subjectId: "obs-4", assignedAt: "2026-10-01T10:00:00.000Z", snapshotId: "snap-2" }, { company: "Northstar Health", metric: "Fair value", fund: "Nordic Capital Fund V", period: "30 Jun 2026" }), {
    subjectKind: "observation", subjectId: "obs-4", title: "Northstar Health · Fair value", detail: "Nordic Capital Fund V · 30 Jun 2026 · Assigned to you for review.",
    severity: "high", assignedAt: "2026-10-01T10:00:00.000Z", snapshotId: "snap-2",
  });
  const bare = assignedObservationItem({ subjectId: "obs-9", assignedAt: null }, {});
  assert.deepEqual([bare.title, bare.detail, "snapshotId" in bare], ["Observation", "Assigned to you for review.", false]);
  assert.equal(assignedObservationItem({ subjectId: "o", assignedAt: null, snapshotId: null }, { company: null, metric: "Revenue", fund: "F", period: null }).title, "Observation · Revenue");

  assert.deepEqual(assignedExceptionItem({ subjectId: "exc-1", assignedAt: "2026-10-02T10:00:00.000Z", snapshotId: "snap-1" }, { summary: "  Competing revenue values  ", type: "source_authority", fund: "EQT IX", period: "Q2 2026" }), {
    subjectKind: "reconciliation_exception", subjectId: "exc-1", title: "Competing revenue values", detail: "EQT IX · Q2 2026 · Blocks publication until resolved.",
    severity: "blocking", assignedAt: "2026-10-02T10:00:00.000Z", snapshotId: "snap-1",
  });
  const typed = assignedExceptionItem({ subjectId: "exc-2", assignedAt: null }, { summary: "  ", type: "reconciliation_conflict" });
  assert.deepEqual([typed.title, typed.detail, "snapshotId" in typed], ["reconciliation conflict exception", "Blocks publication until resolved.", false]);
  assert.equal(assignedExceptionItem({ subjectId: "exc-3", assignedAt: null }, {}).title, "reconciliation exception");
});

test("assigned items list blocking exceptions first, then the newest assignment", () => {
  const item = (subjectId: string, severity: AssignedReviewItem["severity"], assignedAt: string | null): AssignedReviewItem => ({
    subjectKind: severity === "blocking" ? "reconciliation_exception" : "observation", subjectId, title: subjectId, detail: "", severity, assignedAt,
  });
  const sorted = sortAssignedItems([item("a", "high", "2026-10-01"), item("b", "blocking", "2026-09-01"), item("c", "high", "2026-10-02"), item("d", "high", null), item("e", "high", "2026-10-02"), item("f", "high", null), item("g", "high", null)]);
  assert.deepEqual(sorted.map((entry) => entry.subjectId), ["b", "c", "e", "a", "d", "f", "g"]);
  const input = [item("z", "high", null), item("y", "blocking", null)];
  sortAssignedItems(input);
  assert.deepEqual(input.map((entry) => entry.subjectId), ["z", "y"], "the input is not reordered");
});
