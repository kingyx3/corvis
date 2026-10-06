import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent } from "../../../shared/domain/enterprise.ts";
import { PostgresDriverError } from "../../../platform/database/postgres-native.ts";
import type { SqlApplicationError } from "../../../platform/database/sql-application-errors.ts";
import { trustedIdentityHeaders } from "../../../test-support/identity-assertion.ts";
import "../../../test-support/http-sql-driver.ts";

// Route handlers use the Next.js "@/..." alias; see src/platform/http/api/http.test.ts.
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

// The Postgres path: a non-demo identity through the trusted gateway, with an HTTP SQL test double that records every
// statement. Nothing here talks to a real database; db/postgres/tests/review-item-discussion.{sql,mjs} cover the SQL itself.
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const GATEWAY_SECRET = "review-discussion-gateway-secret";
const OBS = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const ME = "99999999-9999-4999-8999-999999999999";
const PRIYA = "88888888-8888-4888-8888-888888888888";
const COMMENT = "66666666-6666-4666-8666-666666666666";

process.env.CORVIS_DEMO_MODE = "";
process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = GATEWAY_SECRET;
process.env.CORVIS_DATABASE_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";
console.warn = console.info = console.error = () => undefined;

type Query = { sql: string; parameters: unknown[] };
const queries: Query[] = [];
let respond: (query: Query) => unknown[] = () => [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_DATABASE_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as Query;
  const query = { sql: sql.trim(), parameters };
  queries.push(query);
  return new Response(JSON.stringify({ rows: respond(query) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { GET: listGet } = await import("@/app/api/v1/review-items/route");
const { GET: assignedGet } = await import("@/app/api/v1/review-items/assigned/route");
const { GET: threadGet } = await import("@/app/api/v1/review-items/[subjectKind]/[subjectId]/route");
const { PUT: assigneePut } = await import("@/app/api/v1/review-items/[subjectKind]/[subjectId]/assignee/route");
const { POST: commentPost } = await import("@/app/api/v1/review-items/[subjectKind]/[subjectId]/comments/route");
const { reviewDiscussionService, postgresReviewDiscussionService, overrideReviewDiscussionService } = await import("./review-discussion-service.ts");

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: TENANT, workspace_id: WORKSPACE, subject_kind: "observation", subject_id: OBS, fund_id: "fund-1", report_period: "Q2 2026",
    assignee_user_id: PRIYA, previous_assignee_user_id: null, assignment_changed_by: "idp|me", assignment_changed_at: "2026-10-01 10:00:00+00",
    version: 1, comment_count: 0, last_comment_at: null, created_at: "2026-10-01 09:00:00+00", ...overrides,
  };
}
function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: TENANT, workspace_id: WORKSPACE, subject_kind: "observation", subject_id: OBS, comment_id: COMMENT, author_auth_method: "oidc", author_subject: "idp|me",
    author_user_id: ME, idempotency_key: "k-1", body: "A private comment.", mentioned_user_ids: [PRIYA], created_at: "2026-10-01 11:00:00+00", ...overrides,
  };
}

type Caller = { roles?: string; subject?: string; funds?: string[]; documents?: string[]; method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; authMethod?: string };
let sequence = 0;
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const method = caller.method ?? "GET";
  const hasBody = caller.body !== undefined || caller.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-correlation-id": `corr-review-discussion-${sequence}`,
      ...trustedIdentityHeaders(GATEWAY_SECRET, { subject: caller.subject ?? "idp|me", tenantId: TENANT, workspaceId: WORKSPACE, roles: caller.roles ?? "reviewer", fundIds: caller.funds ?? ["fund-1"], documentIds: caller.documents ?? ["doc-1"], ...(caller.authMethod ? { authMethod: caller.authMethod } : {}) }),
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...caller.headers,
    },
    body: hasBody ? (caller.rawBody ?? JSON.stringify(caller.body)) : undefined,
  });
}
const params = (subjectId: string, subjectKind = "observation") => ({ params: Promise.resolve({ subjectKind, subjectId }) });
type Body = { error?: string; replayed?: boolean; nextCursor?: string | null; data: Record<string, unknown> & Array<Record<string, unknown>>; thread?: Record<string, unknown> };
const body = async (response: Response) => (await response.json()) as Body;
const seed = (handler: (query: Query) => unknown[] = () => []) => { queries.length = 0; respond = handler; };
const isActor = (query: Query) => /from corvis_control\.identity_subject/.test(query.sql) && /limit 1/.test(query.sql) && /select user_id::text as user_id/.test(query.sql);
const isVisible = (query: Query) => /select subject_fund_id from corvis_control\.resolve_review_subject/.test(query.sql);
const isLabels = (query: Query) => /review_member_labels/.test(query.sql);
const isAudit = (query: Query) => /insert into corvis_control\.audit_event/.test(query.sql);
const isOutbox = (query: Query) => /insert into corvis_control\.email_outbox/.test(query.sql);
const base = (query: Query): unknown[] | undefined => isActor(query) ? [{ user_id: ME }] : isVisible(query) ? [{ subject_fund_id: "fund-1" }] : undefined;

test("the Postgres service is selected outside demo mode", () => {
  assert.equal(reviewDiscussionService(), postgresReviewDiscussionService);
});

test("assigning calls the one SQL function with the caller's own entitlements, then audits and notifies in the same transaction", async () => {
  seed((query) => base(query)
    ?? (/set_review_item_assignee/.test(query.sql) ? [thread()] : isLabels(query) ? [{ user_id: PRIYA, member_label: "priya.nair@example.test" }] : []));
  const response = await assigneePut(request(`/review-items/observation/${OBS}/assignee`, { method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params(OBS));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.deepEqual([payload.data.version, (payload.data.assignee as { displayName: string }).displayName], [1, "priya.nair@example.test"]);

  const call = queries.find((query) => /set_review_item_assignee/.test(query.sql))!;
  assert.deepEqual(call.parameters.slice(0, 4), [TENANT, WORKSPACE, "observation", OBS], "tenant and workspace come from the authenticated identity, never the body");
  assert.equal(call.parameters[4], JSON.stringify(["fund-1"]));
  assert.equal(call.parameters[5], JSON.stringify(["doc-1"]));
  assert.deepEqual(call.parameters.slice(6), ["oidc", "idp|me", PRIYA, 0]);

  assert.deepEqual(queries.filter((query) => isAudit(query) || isOutbox(query)).map((query) => isAudit(query) ? `audit:${query.parameters[5]}` : "notice"), ["notice", "audit:review_item.assign"]);
  const audit = queries.find(isAudit)!;
  assert.equal(audit.parameters[6], "review_item");
  assert.equal(audit.parameters[7], `observation:${OBS}`);
  const notice = queries.find(isOutbox)!;
  assert.ok(notice.parameters.includes("review_discussion") && notice.parameters.includes(PRIYA));
  for (const query of queries) {
    assert.doesNotMatch(query.sql, /corvis_facts\.(observation|review_event)|reconciliation_resolution_event|fund_period_snapshot|snapshot_publication_event|data_correction_incident|processing_job/i,
      `assigning must not read or write review decisions, publication or processing state: ${query.sql.slice(0, 80)}`);
  }
});

test("an assignment that changes nothing is neither audited nor notified", async () => {
  seed((query) => base(query) ?? (/set_review_item_assignee/.test(query.sql) ? [thread({ version: 2 })] : isLabels(query) ? [{ user_id: PRIYA, member_label: "priya.nair@example.test" }] : []));
  const response = await assigneePut(request(`/review-items/observation/${OBS}/assignee`, { method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 2 } }), params(OBS));
  assert.equal(response.status, 200);
  assert.equal(queries.filter((query) => isAudit(query) || isOutbox(query)).length, 0);
});

test("a comment is one SQL call, one audit event without its text and a notice without its text", async () => {
  seed((query) => base(query)
    ?? (/add_review_item_comment/.test(query.sql) ? [comment({ comment_id: query.parameters[6] })]
      : /from corvis_control\.review_item_thread t\s+where t\.tenant_id=\$1::uuid and t\.workspace_id=\$2::uuid and t\.subject_kind=\$3/.test(query.sql) ? [thread({ comment_count: 1 })]
      : isLabels(query) ? [{ user_id: ME, member_label: "me@example.test" }, { user_id: PRIYA, member_label: "priya.nair@example.test" }] : []));
  const response = await commentPost(request(`/review-items/observation/${OBS}/comments`, { method: "POST", body: { idempotencyKey: "k-1", body: "A private comment.", mentionUserIds: [PRIYA] } }), params(OBS));
  assert.equal(response.status, 201);
  const payload = await body(response);
  assert.deepEqual([payload.replayed, payload.data.body, payload.thread?.commentCount], [false, "A private comment.", 1]);
  const audit = queries.find(isAudit)!;
  assert.ok(audit.parameters.includes("review_item.comment"));
  assert.ok(!audit.parameters.some((value) => typeof value === "string" && value.includes("private")), "the comment text is not audited");
  const notice = queries.find(isOutbox)!;
  assert.ok(notice.parameters.includes(PRIYA));
  assert.ok(!notice.parameters.some((value) => typeof value === "string" && value.includes("private")), "the comment text is not queued for email");
  const written = queries.filter((query) => /insert into|update corvis|delete from/i.test(query.sql)).map((query) => /audit_event/.test(query.sql) ? "audit" : /email_outbox/.test(query.sql) ? "notice" : /savepoint/.test(query.sql) ? "savepoint" : "other");
  assert.ok(!written.includes("other"), "a comment writes only through the SQL function, the audit log and the outbox");
});

test("a replayed comment is a 200 and writes no second audit event or notice", async () => {
  seed((query) => base(query)
    ?? (/add_review_item_comment/.test(query.sql) ? [comment()]
      : /from corvis_control\.review_item_thread t\s+where t\.tenant_id=\$1::uuid and t\.workspace_id=\$2::uuid and t\.subject_kind=\$3/.test(query.sql) ? [thread({ comment_count: 1 })]
      : isLabels(query) ? [{ user_id: ME, member_label: "me@example.test" }] : []));
  const response = await commentPost(request(`/review-items/observation/${OBS}/comments`, { method: "POST", body: { body: "A private comment.", mentionUserIds: [] }, headers: { "idempotency-key": "k-1" } }), params(OBS));
  assert.equal(response.status, 200);
  assert.equal((await body(response)).replayed, true);
  assert.equal(queries.filter((query) => isAudit(query) || isOutbox(query)).length, 0);
});

test("reading a thread, the index and the open assignments is bound to the caller's entitlements and workspace", async () => {
  seed((query) => base(query) ?? (/from corvis_control\.review_item_thread t\s+where t\.tenant_id=\$1::uuid and t\.workspace_id=\$2::uuid and t\.subject_kind=\$3/.test(query.sql) ? [thread()] : []));
  const found = await threadGet(request(`/review-items/observation/${OBS}`), params(OBS));
  assert.equal(found.status, 200);
  const lookup = queries.find(isVisible)!;
  assert.deepEqual(lookup.parameters, [TENANT, "observation", OBS, JSON.stringify(["fund-1"]), JSON.stringify(["doc-1"])]);

  seed((query) => isActor(query) ? [{ user_id: ME }] : []);
  const hidden = await threadGet(request(`/review-items/observation/${OBS}`), params(OBS));
  assert.equal(hidden.status, 404);
  assert.equal((await body(hidden)).error, "review_item_not_found");
  seed((query) => isActor(query) ? [{ user_id: ME }] : []);
  assert.equal((await threadGet(request("/review-items/observation/not-a-uuid"), params("not-a-uuid"))).status, 404);
  assert.ok(!queries.some(isVisible), "a malformed id never reaches the uuid cast");

  seed((query) => isActor(query) ? [{ user_id: ME }] : /review_item_thread t/.test(query.sql) ? [thread()] : isLabels(query) ? [{ user_id: PRIYA, member_label: "priya.nair@example.test" }] : []);
  const list = await listGet(request("/review-items?limit=5"));
  assert.equal(list.status, 200);
  assert.equal((await body(list)).data.length, 1);
  const index = queries.find((query) => /from corvis_control\.review_item_thread t/.test(query.sql) && /resolve_review_subject/.test(query.sql))!;
  assert.deepEqual(index.parameters.slice(0, 4), [TENANT, WORKSPACE, JSON.stringify(["fund-1"]), JSON.stringify(["doc-1"])]);

  seed((query) => isActor(query) ? [{ user_id: ME }] : []);
  const assigned = await assignedGet(request("/review-items/assigned"));
  assert.equal(assigned.status, 200);
  assert.deepEqual((await body(assigned)).data, []);
  assert.equal(queries.find((query) => /t\.assignee_user_id=\$3::uuid/.test(query.sql))!.parameters[2], ME);
});

test("a service identity and a person without an active identity are refused before any thread is read or written", async () => {
  seed();
  const machine = await assigneePut(request(`/review-items/observation/${OBS}/assignee`, { method: "PUT", authMethod: "service_account", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params(OBS));
  assert.equal(machine.status, 403);
  assert.equal((await body(machine)).error, "human_identity_required");
  assert.equal(queries.length, 0);
  seed();
  const stranger = await listGet(request("/review-items"));
  assert.equal(stranger.status, 403);
  assert.equal((await body(stranger)).error, "human_identity_required");
  assert.ok(!queries.some((query) => /review_item_thread/.test(query.sql)));
});

test("an analyst, who cannot review, never reaches the database", async () => {
  seed();
  const response = await assigneePut(request(`/review-items/observation/${OBS}/assignee`, { method: "PUT", roles: "analyst", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params(OBS));
  assert.equal(response.status, 403);
  assert.equal(queries.length, 0);
});

test("SQL refusals reach the client as stable codes", async () => {
  const cases: Array<[SqlApplicationError, number, string]> = [
    ["review item not found", 404, "review_item_not_found"],
    ["review item actor not found", 403, "human_identity_required"],
    ["review assignee not eligible", 422, "assignee_not_eligible"],
    ["review mention not eligible", 422, "mention_not_eligible"],
    ["review item assignment changed", 409, "assignment_changed"],
    ["review comment limit reached", 409, "review_comment_limit_reached"],
    ["idempotency key reused with different review comment", 409, "idempotency_key_reused"],
  ];
  for (const [fragment, status, code] of cases) {
    overrideReviewDiscussionService({
      ...postgresReviewDiscussionService,
      assign: async () => { throw new PostgresDriverError("query", "P0001", fragment); },
      comment: async () => { throw new PostgresDriverError("query", "P0001", fragment); },
    });
    try {
      const assigned = await assigneePut(request(`/review-items/observation/${OBS}/assignee`, { method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params(OBS));
      assert.deepEqual([assigned.status, (await body(assigned)).error], [status, code]);
      const commented = await commentPost(request(`/review-items/observation/${OBS}/comments`, { method: "POST", body: { idempotencyKey: "k", body: "x" } }), params(OBS));
      assert.deepEqual([commented.status, (await body(commented)).error], [status, code]);
    } finally {
      overrideReviewDiscussionService();
    }
  }
  overrideReviewDiscussionService({ ...postgresReviewDiscussionService, assign: async () => { throw new Error("database exploded"); } });
  try {
    const failed = await assigneePut(request(`/review-items/observation/${OBS}/assignee`, { method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params(OBS));
    assert.equal(failed.status, 500);
    assert.equal((await body(failed)).error, "internal_error");
  } finally {
    overrideReviewDiscussionService();
  }
});

test("audit events written for assignments and comments are structured and carry no free text", async () => {
  const events: AuditEvent[] = [];
  seed((query) => {
    if (isAudit(query)) events.push({ action: String(query.parameters[5]), targetType: String(query.parameters[6]), targetId: String(query.parameters[7]), metadata: JSON.parse(String(query.parameters[10])) } as unknown as AuditEvent);
    return base(query)
      ?? (/set_review_item_assignee/.test(query.sql) ? [thread({ version: 1 })]
        : /add_review_item_comment/.test(query.sql) ? [comment({ comment_id: query.parameters[6] })]
        : /review_item_thread t\s+where/.test(query.sql) ? [thread({ comment_count: 1 })]
        : isLabels(query) ? [{ user_id: ME, member_label: "me@example.test" }, { user_id: PRIYA, member_label: "priya.nair@example.test" }] : []);
  });
  await assigneePut(request(`/review-items/observation/${OBS}/assignee`, { method: "PUT", body: { assigneeUserId: PRIYA, expectedVersion: 0 } }), params(OBS));
  await commentPost(request(`/review-items/observation/${OBS}/comments`, { method: "POST", body: { idempotencyKey: "k-audit", body: "A private comment.", mentionUserIds: [PRIYA] } }), params(OBS));
  assert.deepEqual(events.map((event) => event.action), ["review_item.assign", "review_item.comment"]);
  assert.ok(events.every((event) => event.targetType === "review_item" && event.targetId === `observation:${OBS}`));
  assert.ok(!JSON.stringify(events).includes("private") && !JSON.stringify(events).includes("Private"));
});
