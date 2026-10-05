import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent, RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { DeletionRequestView } from "../domain/data-retention.ts";

// See src/modules/sources/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_POSTGRES_DSN;

// Demo mode must never reach a database: any outbound request fails the test that made it.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`unexpected network call in demo mode: ${url}${init?.method ? ` ${init.method}` : ""}`);
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { DemoCustomerDeletionStore } = await import("../adapters/customer-deletion-store.ts");
const { DemoRetentionStore } = await import("../adapters/data-retention-store.ts");
const { DataGovernanceError } = await import("./data-governance.ts");
const { GET: retentionGet } = await import("@/app/api/v1/access/retention/route");
const { POST: requestPost } = await import("@/app/api/v1/access/deletion-requests/route");
const { POST: decidePost } = await import("@/app/api/v1/access/deletion-requests/[requestId]/route");
const { createCustomerDeletionService, customerDeletionService, demoCustomerDeletionService, overrideCustomerDeletionService, postgresCustomerDeletionService } = await import("./customer-deletion.ts");
const { platform } = await import("../../../platform/platform.ts");

const HOUR = 60 * 60 * 1000;
const refusal = (code: string, status: number) => (error: unknown) => error instanceof DataGovernanceError && error.code === code && error.status === status;

let clock = new Date("2026-10-02T12:00:00.000Z");
const store = () => new DemoCustomerDeletionStore(() => clock);
function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "demo-admin", tenantId: "tenant-deletion", workspaceId: "workspace-deletion", roles: ["admin"], isTenantAdmin: true, authMethod: "demo", sessionId: "s",
    entitlements: { workspaceIds: ["workspace-deletion"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const second = (overrides: Partial<RequestIdentity> = {}) => identity({ subject: "second-admin", ...overrides });
const REASON = "Contract ends this quarter";

async function colleaguesRequest(demo: InstanceType<typeof DemoCustomerDeletionStore>, who = identity()): Promise<DeletionRequestView> {
  return (await demo.list(who)).find((item) => item.status === "pending_approval")!;
}

// ------------------------------------------------------------------ store
test("each demo tenant is seeded once: a deletion carried out, one blocked by the legal hold, and a colleague's request awaiting this admin", async () => {
  const demo = store();
  const items = await demo.list(identity());
  assert.deepEqual(items.map((item) => [item.origin, item.status, item.scopeLabel, item.legalHoldBlocks]), [
    ["customer", "pending_approval", "Published data", false],
    ["corvis", "blocked", "Source documents", true],
    ["corvis", "completed", "Audit records", false],
  ], "newest first");
  const [pending, blocked, completed] = items as [DeletionRequestView, DeletionRequestView, DeletionRequestView];
  assert.deepEqual([pending.requestedByMe, pending.requestedBy, pending.actions], [false, "morgan.lee@meridian.example", { canApprove: true, canReject: true, canCancel: false }]);
  assert.equal(pending.reason, "Contract ends this quarter: remove the published data we no longer need.");
  assert.ok(Date.parse(pending.approvalExpiresAt!) > clock.getTime());
  assert.deepEqual(completed.executedAt === null || completed.decidedAt === null, false, "a completed deletion has its decided and executed dates");
  assert.equal(blocked.executedAt, null);
  assert.equal(blocked.decidedAt, null);
  assert.equal((await demo.list(identity())).length, 3, "listing again does not seed again");
  assert.equal((await demo.list(identity({ tenantId: "tenant-other" }))).length, 3, "another tenant gets its own seeds");
});

test("a request Corvis operations made never shows who made or ran it, why, a note, or an approval window, and can never be decided here", async () => {
  const demo = store();
  const [, blocked, completed] = await demo.list(identity()) as [DeletionRequestView, DeletionRequestView, DeletionRequestView];
  for (const item of [blocked, completed]) {
    assert.deepEqual([item.reason, item.requestedBy, item.approvalExpiresAt, item.decidedBy, item.decisionNote, item.requestedByMe], [null, null, null, null, null, false], item.requestId);
    assert.deepEqual(item.actions, { canApprove: false, canReject: false, canCancel: false });
    for (const action of ["approve", "reject", "cancel"] as const) {
      await assert.rejects(() => demo.decide(identity(), item.requestId, action === "reject" ? { action, note: "No" } : { action }), refusal("deletion_request_not_found", 404), `${action} ${item.status}`);
    }
  }
  await assert.rejects(() => demo.decide(identity(), "00000000-0000-4000-8000-000000000000", { action: "approve" }), refusal("deletion_request_not_found", 404));
});

test("a request needs the pending one decided first, names classes the organization has a policy for, and is refused under a legal hold", async () => {
  const demo = store();
  await assert.rejects(() => demo.request(identity(), { dataClasses: ["financials"], reason: REASON }), refusal("deletion_request_already_pending", 409));
  await demo.decide(identity(), (await colleaguesRequest(demo)).requestId, { action: "reject", note: "Not now" });
  await assert.rejects(() => demo.request(identity(), { dataClasses: ["no_such_class"], reason: REASON }), refusal("invalid_data_classes", 400));
  await assert.rejects(() => demo.request(identity(), { dataClasses: ["financials", "no_such_class"], reason: REASON }), refusal("invalid_data_classes", 400));
  await assert.rejects(() => demo.request(identity(), { dataClasses: ["financials", "source_documents"], reason: REASON }), refusal("deletion_blocked_by_legal_hold", 409), "the demo hold covers source documents");
  const mine = await demo.request(identity(), { dataClasses: ["financials", "audit"], reason: REASON });
  assert.deepEqual([mine.status, mine.origin, mine.requestedByMe, mine.reason, mine.dataClasses, mine.scopeLabel], ["pending_approval", "customer", true, REASON, ["audit", "financials"], "Audit records, financial data"]);
  assert.deepEqual(mine.actions, { canApprove: false, canReject: false, canCancel: true });
  assert.equal(new Date(mine.approvalExpiresAt!).getTime() - clock.getTime(), 168 * HOUR, "the second admin has a week");
  assert.equal(mine.decidedAt, null);
  assert.equal(mine.executedAt, null);
  assert.equal((await demo.list(identity()))[0]!.requestId, mine.requestId, "newest first");
  await assert.rejects(() => demo.request(identity(), { dataClasses: ["published_data"], reason: REASON }), refusal("deletion_request_already_pending", 409));
});

test("the requester can neither approve nor reject their own request, only a different admin can, and only the requester can withdraw", async () => {
  const demo = store();
  await demo.decide(identity(), (await colleaguesRequest(demo)).requestId, { action: "reject", note: "Not now" });
  const mine = await demo.request(identity(), { dataClasses: ["financials"], reason: REASON });
  await assert.rejects(() => demo.decide(identity(), mine.requestId, { action: "approve" }), refusal("deletion_independent_approver_required", 403));
  await assert.rejects(() => demo.decide(identity(), mine.requestId, { action: "reject", note: "Changed my mind" }), refusal("deletion_independent_approver_required", 403));
  await assert.rejects(() => demo.decide(second(), mine.requestId, { action: "cancel" }), refusal("deletion_cancel_requester_only", 403));
  await demo.decide(second(), mine.requestId, { action: "approve", expectedStatus: "pending_approval" });
  await assert.rejects(() => demo.decide(second(), mine.requestId, { action: "approve", expectedStatus: "pending_approval" }), refusal("deletion_status_changed", 409), "an approval that no longer finds the request pending says it changed");
  const decided = (await demo.list(identity())).find((item) => item.requestId === mine.requestId)!;
  assert.deepEqual([decided.status, decided.decidedBy, decided.decisionNote, decided.actions], ["approved", "second-admin", null, { canApprove: false, canReject: false, canCancel: false }]);
  assert.ok(decided.decidedAt, "an approval is dated");
  assert.equal(decided.executedAt, null, "approving deletes nothing: Corvis operations carry it out");
  await assert.rejects(() => demo.decide(second(), mine.requestId, { action: "approve" }), refusal("deletion_transition_not_allowed", 409));
  await assert.rejects(() => demo.decide(identity(), mine.requestId, { action: "cancel" }), refusal("deletion_transition_not_allowed", 409), "an approved request can no longer be withdrawn");
});

test("a rejection keeps its note and decider; a withdrawal is not a decision, and either frees the tenant for a new request", async () => {
  const demo = store();
  const seeded = await colleaguesRequest(demo);
  const rejected = await demo.decide(identity(), seeded.requestId, { action: "reject", note: "Please scope this first" });
  assert.deepEqual([rejected.status, rejected.decidedBy, rejected.decisionNote, rejected.actions.canApprove], ["rejected", "demo-admin", "Please scope this first", false]);
  const mine = await demo.request(identity(), { dataClasses: ["audit"], reason: REASON });
  const withdrawn = await demo.decide(identity(), mine.requestId, { action: "cancel" });
  assert.deepEqual([withdrawn.status, withdrawn.decidedBy, withdrawn.decidedAt], ["cancelled", null, null]);
  await demo.request(second(), { dataClasses: ["audit"], reason: REASON });
});

test("an approval window that passes lapses the request: it can no longer be decided and does not block a new one", async () => {
  const demo = store();
  const seeded = await colleaguesRequest(demo);
  try {
    clock = new Date(clock.getTime() + 169 * HOUR);
    const lapsed = (await demo.list(identity())).find((item) => item.requestId === seeded.requestId)!;
    assert.equal(lapsed.status, "expired");
    assert.deepEqual(lapsed.actions, { canApprove: false, canReject: false, canCancel: false });
    await assert.rejects(() => demo.decide(identity(), seeded.requestId, { action: "approve" }), refusal("deletion_approval_expired", 409));
    await assert.rejects(() => demo.decide(identity(), seeded.requestId, { action: "reject", note: "No" }), refusal("deletion_approval_expired", 409));
    const fresh = await demo.request(identity(), { dataClasses: ["financials"], reason: REASON });
    assert.equal(fresh.status, "pending_approval");
    await assert.rejects(() => demo.decide(identity(), seeded.requestId, { action: "approve" }), refusal("deletion_transition_not_allowed", 409), "once lapsed for good it is simply not pending");
  } finally {
    clock = new Date("2026-10-02T12:00:00.000Z");
  }
});

test("a hold placed after the request stops its approval, while rejecting stays possible", async () => {
  // The demo's hold is fixed, so reach the state the SQL guards against by making the request pending on held data directly in the store.
  const demo = store();
  const seeded = await colleaguesRequest(demo);
  const internals = demo as unknown as { tenants: Map<string, Array<{ requestId: string; dataClasses: string[] }>> };
  internals.tenants.get("tenant-deletion")!.find((entry) => entry.requestId === seeded.requestId)!.dataClasses = ["financials", "source_documents"];
  const held = (await demo.list(identity())).find((item) => item.requestId === seeded.requestId)!;
  assert.equal(held.legalHoldBlocks, true, "the list says a hold applies");
  await assert.rejects(() => demo.decide(identity(), seeded.requestId, { action: "approve" }), refusal("deletion_blocked_by_legal_hold", 409));
  assert.equal((await demo.decide(identity(), seeded.requestId, { action: "reject", note: "A hold now applies" })).status, "rejected");
});

test("the retention view carries the deletion requests of the caller's tenant", async () => {
  const view = await new DemoRetentionStore().view(identity({ tenantId: "tenant-view" }));
  assert.equal(view.deletionRequests.length, 3);
  assert.equal((await new DemoRetentionStore().view(identity({ tenantId: "tenant-view" }))).deletionRequests.length, 3);
});

// ------------------------------------------------------------------ service
test("the service lets only Organization Admins act and audits exactly what changed, with identifiers, status and scope", async () => {
  const events: AuditEvent[] = [];
  const backend = store();
  const service = createCustomerDeletionService(backend);
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  try {
    const colleague = identity({ subject: "member", roles: ["analyst"], isTenantAdmin: false });
    const accountAdmin = identity({ subject: "workspace-admin", isTenantAdmin: false });
    for (const who of [colleague, accountAdmin, identity({ isTenantAdmin: undefined })]) {
      await assert.rejects(() => service.request(who, { dataClasses: ["audit"], reason: REASON }, "c"), refusal("tenant_admin_required", 403));
      await assert.rejects(() => service.decide(who, "x", { action: "approve" }, "c"), refusal("tenant_admin_required", 403));
    }
    assert.equal(events.length, 0, "a refused command is not audited");

    const seeded = (await backend.list(identity())).find((item) => item.status === "pending_approval")!;
    await assert.rejects(() => service.request(identity(), { dataClasses: ["audit"], reason: REASON }, "corr-0"), refusal("deletion_request_already_pending", 409));
    await service.decide(second(), seeded.requestId, { action: "reject", note: "Not now" }, "corr-1");
    const mine = await service.request(identity(), { dataClasses: ["financials", "audit"], reason: REASON }, "corr-2");
    await assert.rejects(() => service.decide(identity(), mine.requestId, { action: "approve" }, "corr-3"), refusal("deletion_independent_approver_required", 403));
    assert.deepEqual(events.map((event) => [event.action, event.actorSubject, event.targetType, event.correlationId, event.metadata?.status, event.metadata?.dataClasses]), [
      ["deletion_request.customer_rejected", "second-admin", "deletion_request", "corr-1", "rejected", "published_data"],
      ["deletion_request.customer_requested", "demo-admin", "deletion_request", "corr-2", "pending_approval", "audit,financials"],
    ], "the refused approval of one's own request left no success audit");
    assert.equal(events[0]!.metadata?.note, "Not now");
    assert.equal(events[1]!.metadata?.reason, REASON);

    const approved = await service.decide(second(), mine.requestId, { action: "approve" }, "corr-4");
    assert.equal(approved.status, "approved");
    assert.equal(events.at(-1)!.action, "deletion_request.customer_approved");
    assert.equal(events.at(-1)!.metadata?.note, undefined, "no note, none recorded");

    const other = await service.request(second(), { dataClasses: ["audit"], reason: REASON }, "corr-5");
    await service.decide(second(), other.requestId, { action: "cancel" }, "corr-6");
    assert.equal(events.at(-1)!.action, "deletion_request.customer_cancelled");
  } finally {
    port.audit = original;
  }
});

test("the service is selected by mode and can be pinned by a test", () => {
  assert.equal(customerDeletionService(), demoCustomerDeletionService);
  assert.notEqual(demoCustomerDeletionService, postgresCustomerDeletionService);
  const pinned = createCustomerDeletionService(store());
  overrideCustomerDeletionService(pinned);
  try { assert.equal(customerDeletionService(), pinned); } finally { overrideCustomerDeletionService(); }
  assert.equal(customerDeletionService(), demoCustomerDeletionService);
});

// ------------------------------------------------------------------ routes
type Options = { method?: string; tenant?: string; subject?: string; roles?: string; body?: unknown; rawBody?: string };
function request(path: string, options: Options = {}): Request {
  const method = options.method ?? "GET";
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-corvis-demo-tenant": options.tenant ?? "tenant-deletion-routes",
      "x-corvis-demo-subject": options.subject ?? "route-admin",
      "x-corvis-demo-roles": options.roles ?? "admin",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? (options.rawBody ?? JSON.stringify(options.body)) : undefined,
  });
}
const params = (requestId: string) => ({ params: Promise.resolve({ requestId }) });
type Json = { error?: string; data: DeletionRequestView & { deletionRequests: DeletionRequestView[] } };
const body = async (response: Response) => (await response.json()) as Json;

test("the whole flow runs through the routes: list, request, a refused self-approval, approval by a second admin, and a legal hold", async () => {
  const tenant = "tenant-deletion-flow";
  const view = (await body(await retentionGet(request("/access/retention", { tenant })))).data.deletionRequests;
  assert.deepEqual(view.map((item) => item.status), ["pending_approval", "blocked", "completed"]);
  assert.equal(JSON.stringify(view.filter((item) => item.origin === "corvis")).includes("morgan"), false, "nothing of a colleague or an operator in the requests Corvis made");

  const blocked = await requestPost(request("/access/deletion-requests", { method: "POST", tenant, body: { dataClasses: ["financials"], reason: REASON } }));
  assert.equal(blocked.status, 409);
  assert.equal((await body(blocked)).error, "deletion_request_already_pending");
  const rejected = await decidePost(request(`/access/deletion-requests/${view[0]!.requestId}`, { method: "POST", tenant, body: { action: "reject", note: "Superseded" } }), params(view[0]!.requestId));
  assert.equal(rejected.status, 200);
  assert.equal((await body(rejected)).data.status, "rejected");

  const held = await requestPost(request("/access/deletion-requests", { method: "POST", tenant, body: { dataClasses: ["source_documents"], reason: REASON } }));
  assert.equal(held.status, 409);
  assert.equal((await body(held)).error, "deletion_blocked_by_legal_hold");
  const unknown = await requestPost(request("/access/deletion-requests", { method: "POST", tenant, body: { dataClasses: ["nope"], reason: REASON } }));
  assert.equal(unknown.status, 400);
  assert.equal((await body(unknown)).error, "invalid_data_classes");

  const created = await requestPost(request("/access/deletion-requests", { method: "POST", tenant, body: { dataClasses: ["financials"], reason: `  ${REASON}  `, tenantId: "someone-else" } }));
  assert.equal(created.status, 201);
  const mine = (await body(created)).data;
  assert.deepEqual([mine.status, mine.reason, mine.requestedByMe], ["pending_approval", REASON, true]);

  const self = await decidePost(request(`/access/deletion-requests/${mine.requestId}`, { method: "POST", tenant, body: { action: "approve" } }), params(mine.requestId));
  assert.equal(self.status, 403);
  assert.equal((await body(self)).error, "deletion_independent_approver_required");

  const approved = await decidePost(request(`/access/deletion-requests/${mine.requestId}`, { method: "POST", tenant, subject: "second-admin", body: { action: "approve", expectedStatus: "pending_approval" } }), params(mine.requestId));
  assert.equal(approved.status, 200);
  assert.equal((await body(approved)).data.status, "approved");
  const after = (await body(await retentionGet(request("/access/retention", { tenant })))).data.deletionRequests;
  assert.deepEqual(after.map((item) => item.status), ["approved", "rejected", "blocked", "completed"]);
});

test("the routes are Organization-Admin-only and validate before touching anything", async () => {
  const tenant = "tenant-deletion-validation";
  const seeded = (await body(await retentionGet(request("/access/retention", { tenant })))).data.deletionRequests[0]!;
  for (const roles of ["analyst", "reviewer", "read_only", "api_client"]) {
    assert.equal((await requestPost(request("/access/deletion-requests", { method: "POST", tenant, roles, body: { dataClasses: ["audit"], reason: REASON } }))).status, 403, roles);
    assert.equal((await decidePost(request(`/access/deletion-requests/${seeded.requestId}`, { method: "POST", tenant, roles, body: { action: "approve" } }), params(seeded.requestId))).status, 403, roles);
  }
  const cases: Array<[unknown, string]> = [
    [{ reason: REASON }, "invalid_data_classes"],
    [{ dataClasses: [], reason: REASON }, "invalid_data_classes"],
    [{ dataClasses: ["audit"] }, "invalid_reason"],
    [{ dataClasses: ["audit"], reason: "no" }, "invalid_reason"],
  ];
  for (const [payload, error] of cases) {
    const response = await requestPost(request("/access/deletion-requests", { method: "POST", tenant, body: payload }));
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal((await body(response)).error, error);
  }
  assert.equal((await requestPost(request("/access/deletion-requests", { method: "POST", tenant, rawBody: "[" }))).status, 400, "a body that is not JSON");
  const decisions: Array<[unknown, string]> = [[{}, "invalid_action"], [{ action: "reject" }, "invalid_note"], [{ action: "approve", expectedStatus: "approved" }, "invalid_status"]];
  for (const [payload, error] of decisions) {
    const response = await decidePost(request(`/access/deletion-requests/${seeded.requestId}`, { method: "POST", tenant, body: payload }), params(seeded.requestId));
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal((await body(response)).error, error);
  }
  const missing = await decidePost(request("/access/deletion-requests/not-a-request", { method: "POST", tenant, body: { action: "approve" } }), params("not-a-request"));
  assert.equal(missing.status, 404);
  assert.equal((await body(missing)).error, "deletion_request_not_found");
});
