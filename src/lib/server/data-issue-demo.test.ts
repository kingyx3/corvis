import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent, RequestIdentity } from "../../core/enterprise.ts";
import { DemoDataIssueStore } from "../../adapters/demo/data-issue-store.ts";
import { DataIssueRequestError } from "./data-issue.ts";

// See src/lib/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_POSTGRES_DSN;

// Demo mode must never reach a database: any outbound request fails the test that made it.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`unexpected network call in demo mode: ${url}${init?.method ? ` ${init.method}` : ""}`);
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { GET: listGet, POST: reportPost } = await import("@/app/api/v1/data-issues/route");
const { GET: itemGet, PATCH: itemPatch } = await import("@/app/api/v1/data-issues/[caseId]/route");
const { GET: queueGet } = await import("@/app/api/v1/admin/data-issues/route");
const { GET: adminItemGet, PATCH: adminItemPatch } = await import("@/app/api/v1/admin/data-issues/[caseId]/route");
const { dataIssueService, demoDataIssueService, postgresDataIssueService, overrideDataIssueService, createDataIssueService, MAX_EXPORT_PAGES } = await import("./data-issue-service.ts");
const { platform } = await import("./platform.ts");

const NOW = new Date("2026-10-02T12:00:00.000Z");
const refusal = (code: string, status: number) => (error: unknown) => error instanceof DataIssueRequestError && error.code === code && error.status === status;

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "demo-user", tenantId: "tenant-store", workspaceId: "workspace-store", roles: ["analyst"], authMethod: "demo", sessionId: "s",
    entitlements: { workspaceIds: ["workspace-store"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const adminIdentity = (overrides: Partial<RequestIdentity> = {}) => identity({ subject: "demo-admin", roles: ["admin"], isTenantAdmin: true, ...overrides });
const store = () => new DemoDataIssueStore(() => NOW);
const report = (key: string, overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: key, figure: "overview" as const, comment: "Value looks wrong.", scope: { fundId: "fund-advent-viii", reportPeriod: "Q2 2026" }, ...overrides,
});

test("each reporting subject is seeded once with a corrected-with-update, an investigating and a received case", async () => {
  const demo = store();
  const mine = await demo.list(identity(), { scope: "mine", limit: 50 });
  assert.deepEqual(mine.items.map((item) => item.status).sort(), ["corrected", "investigating", "received"]);
  assert.equal(mine.unseenUpdateCount, 1);
  const corrected = mine.items.find((item) => item.status === "corrected")!;
  assert.equal(corrected.hasUnseenUpdate, true);
  assert.deepEqual(corrected.replacement, { snapshotId: "seed-snapshot-1", snapshotVersion: 2 });
  assert.equal(corrected.reportedByMe, true);
  assert.equal("correctionIncidentId" in corrected, false, "only Organization Admins see the governed incident");
  assert.equal((await demo.list(identity(), { scope: "mine", limit: 50 })).items.length, 3, "listing again does not seed again");
  assert.equal((await demo.list(identity({ subject: "another-demo-user" }), { scope: "mine", limit: 50 })).items.length, 3, "another subject gets its own seeds");
  assert.equal((await demo.list(identity({ tenantId: "tenant-other" }), { scope: "mine", limit: 50 })).items.length, 3);
});

test("a report adds one case, is idempotent per reporter, and refuses a reused key with different content", async () => {
  const demo = store();
  const first = await demo.report(identity(), report("key-1") as never);
  assert.equal(first.created, true);
  assert.equal(first.item.status, "received");
  assert.equal(first.item.routedTo, "data_operations");
  assert.equal(first.item.createdAt, NOW.toISOString());
  assert.equal(first.item.hasUnseenUpdate, false);
  const again = await demo.report(identity(), report("key-1") as never);
  assert.deepEqual([again.created, again.item.caseId], [false, first.item.caseId]);
  await assert.rejects(() => demo.report(identity(), report("key-1", { comment: "Something else." }) as never), refusal("idempotency_key_reused", 409));
  const colleague = await demo.report(identity({ subject: "colleague" }), report("key-1") as never);
  assert.equal(colleague.created, true, "keys are per reporter");
  assert.notEqual(colleague.item.caseId, first.item.caseId);
  const history = (await demo.get(identity(), first.item.caseId)).history!;
  assert.deepEqual(history, [{ fromStatus: null, toStatus: "received", at: NOW.toISOString(), note: null }]);
});

test("a case is visible to its reporter and Organization Admins only, and existence is not leaked", async () => {
  const demo = store();
  const mine = (await demo.report(identity(), report("key-1") as never)).item;
  const colleague = identity({ subject: "colleague" });
  await assert.rejects(() => demo.get(colleague, mine.caseId), refusal("data_issue_not_found", 404));
  await assert.rejects(() => demo.acknowledge(colleague, mine.caseId), refusal("data_issue_not_found", 404));
  await assert.rejects(() => demo.get(identity(), "00000000-0000-4000-8000-000000000000"), refusal("data_issue_not_found", 404));
  await assert.rejects(() => demo.get(identity({ tenantId: "tenant-other" }), mine.caseId), refusal("data_issue_not_found", 404));
  const seen = await demo.get(adminIdentity(), mine.caseId);
  assert.equal(seen.reportedByMe, false);
  assert.equal(seen.reportedBy, "demo-user");
  await assert.rejects(() => demo.acknowledge(adminIdentity(), mine.caseId), refusal("data_issue_not_found", 404), "an admin looking at someone else's case acknowledges nothing");
  assert.ok(!(await demo.list(colleague, { scope: "mine", limit: 50 })).items.some((item) => item.caseId === mine.caseId));
  assert.ok((await demo.list(adminIdentity(), { scope: "all", limit: 50 })).items.some((item) => item.caseId === mine.caseId));
  assert.ok(!(await demo.list(adminIdentity(), { scope: "mine", limit: 50 })).items.some((item) => item.caseId === mine.caseId), "mine is the admin's own reports even for an admin");
});

test("the list pages newest first with an opaque cursor, filters by status and counts only the caller's unseen updates", async () => {
  const demo = store();
  const who = identity();
  const created = [await demo.report(who, report("a") as never), await demo.report(who, report("b") as never)];
  const all = await demo.list(who, { scope: "mine", limit: 50 });
  assert.equal(all.items.length, 5);
  const firstPage = await demo.list(who, { scope: "mine", limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor);
  const secondPage = await demo.list(who, { scope: "mine", limit: 2, cursor: firstPage.nextCursor });
  const thirdPage = await demo.list(who, { scope: "mine", limit: 2, cursor: secondPage.nextCursor });
  assert.equal(thirdPage.nextCursor, null);
  assert.deepEqual([...firstPage.items, ...secondPage.items, ...thirdPage.items].map((item) => item.caseId).sort(), all.items.map((item) => item.caseId).sort(), "every case exactly once");
  assert.deepEqual((await demo.list(who, { scope: "mine", limit: 50, status: "received" })).items.map((item) => item.status), ["received", "received", "received"]);
  assert.equal((await demo.list(who, { scope: "mine", limit: 5, status: "no_change" })).items.length, 0);
  assert.equal(created.length, 2);
  await assert.rejects(() => demo.list(who, { scope: "mine", limit: 2, cursor: "!!!" }), /invalid_cursor/);
});

test("acknowledging clears the update indicator without changing the case", async () => {
  const demo = store();
  const who = identity();
  const corrected = (await demo.list(who, { scope: "mine", limit: 50 })).items.find((item) => item.status === "corrected")!;
  const acknowledged = await demo.acknowledge(who, corrected.caseId);
  assert.equal(acknowledged.hasUnseenUpdate, false);
  assert.equal(acknowledged.status, "corrected");
  assert.equal((await demo.list(who, { scope: "mine", limit: 50 })).unseenUpdateCount, 0);
});

test("Data Operations moves a case along the shared state machine and a correction exposes the replacement", async () => {
  const demo = store();
  const who = identity();
  const ops = adminIdentity();
  const item = (await demo.report(who, report("key-1", { scope: { fundId: "fund-advent-viii", reportPeriod: "Q2 2026", snapshotId: "seed-snapshot-1", snapshotVersion: 4 } }) as never)).item;
  const incident = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";

  await assert.rejects(() => demo.transition(ops, item.caseId, { action: "correct", correctionIncidentId: incident }), refusal("data_issue_transition_not_allowed", 409));
  await assert.rejects(() => demo.transition(ops, item.caseId, { action: "investigate", expectedStatus: "investigating" }), refusal("data_issue_status_changed", 409));
  await assert.rejects(() => demo.transition(ops, "00000000-0000-4000-8000-000000000000", { action: "investigate" }), refusal("data_issue_not_found", 404));

  const investigating = await demo.transition(ops, item.caseId, { action: "investigate", expectedStatus: "received", note: "Checking the source." });
  assert.equal(investigating.status, "investigating");
  assert.equal(investigating.hasUnseenUpdate, false, "the admin is not the reporter");
  assert.equal((await demo.get(who, item.caseId)).hasUnseenUpdate, true, "the reporter now has an update to look at");

  await assert.rejects(() => demo.transition(ops, item.caseId, { action: "correct" }), refusal("data_issue_correction_required", 409));
  const corrected = await demo.transition(ops, item.caseId, { action: "correct", correctionIncidentId: incident, note: "Republished." });
  assert.equal(corrected.status, "corrected");
  assert.deepEqual(corrected.replacement, { snapshotId: "seed-snapshot-1", snapshotVersion: 5 });
  assert.equal(corrected.resolutionNote, "Republished.");
  assert.equal(corrected.correctionIncidentId, incident);
  assert.equal((await demo.get(who, item.caseId)).correctionIncidentId, undefined);
  assert.deepEqual((await demo.get(who, item.caseId)).history?.map((event) => [event.fromStatus, event.toStatus, event.note]), [[null, "received", null], ["received", "investigating", "Checking the source."], ["investigating", "corrected", "Republished."]]);
  await assert.rejects(() => demo.transition(ops, item.caseId, { action: "no_change", note: "late" }), refusal("data_issue_transition_not_allowed", 409));

  // A link made while investigating is remembered: correcting later needs no incident id, and a case with no snapshot gets a fresh one.
  const linked = (await demo.report(who, report("key-2") as never)).item;
  await demo.transition(ops, linked.caseId, { action: "investigate", correctionIncidentId: incident });
  const closed = await demo.transition(ops, linked.caseId, { action: "correct" });
  assert.equal(closed.correctionIncidentId, incident);
  assert.equal(closed.replacement?.snapshotVersion, 2);
  assert.match(closed.replacement!.snapshotId, /^[0-9a-f-]{36}$/);
  assert.equal(closed.resolutionNote, null);

  const noChange = (await demo.report(who, report("key-3") as never)).item;
  await demo.transition(ops, noChange.caseId, { action: "investigate" });
  const closedNoChange = await demo.transition(ops, noChange.caseId, { action: "no_change", note: "Matches the source." });
  assert.deepEqual([closedNoChange.status, closedNoChange.resolutionNote, closedNoChange.replacement], ["no_change", "Matches the source.", null]);
});

// ------------------------------------------------------------------ service
test("the service enforces who may report, list the tenant and move a case, and audits only what changed", async () => {
  const events: AuditEvent[] = [];
  const backend = store();
  const service = createDataIssueService(backend);
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  try {
    const noFunds = identity({ authMethod: "oidc", entitlements: { workspaceIds: [], fundIds: ["fund-eqt-ix"], sourceDocumentAccessAllowed: false } });
    await assert.rejects(() => service.report(noFunds, report("k") as never, "corr-1"), refusal("fund_not_entitled", 403));
    assert.equal(events.length, 0, "a refused report is not audited as a success");

    const first = await service.report(identity(), report("k") as never, "corr-1");
    await service.report(identity(), report("k") as never, "corr-2");
    assert.deepEqual(events.map((event) => [event.action, event.targetType, event.correlationId]), [["data_issue.report", "data_issue_case", "corr-1"]], "a replay changed nothing");
    assert.ok(!JSON.stringify(events[0]).includes("Value looks wrong."), "the comment is not copied into the audit trail");

    await assert.rejects(() => service.list(identity(), { scope: "all", limit: 10 }), refusal("tenant_admin_required", 403));
    await assert.rejects(() => service.exportAll(identity(), "all"), refusal("tenant_admin_required", 403));
    await assert.rejects(() => service.transition(identity(), first.item.caseId, { action: "investigate" }, "corr-3"), refusal("tenant_admin_required", 403));
    assert.equal(events.length, 1, "a refused command is not audited");

    const moved = await service.transition(adminIdentity(), first.item.caseId, { action: "investigate" }, "corr-4");
    assert.equal(moved.status, "investigating");
    assert.deepEqual(events.at(-1) && [events.at(-1)!.action, events.at(-1)!.actorSubject, events.at(-1)!.metadata?.status], ["data_issue.investigate", "demo-admin", "investigating"]);
    assert.equal((await service.get(identity(), first.item.caseId)).status, "investigating");
    assert.equal((await service.acknowledge(identity(), first.item.caseId)).hasUnseenUpdate, false);

    const exported = await service.exportAll(adminIdentity(), "all");
    assert.equal(exported.truncated, false);
    assert.ok(exported.items.length >= 4);
    assert.equal((await service.exportAll(identity(), "mine")).items.length, 4);
  } finally {
    port.audit = original;
  }
});

test("an export that never finishes paging stops at its ceiling and says it was truncated", async () => {
  let pages = 0;
  const endless = createDataIssueService({
    demo: true,
    report: async () => { throw new Error("unused"); },
    get: async () => { throw new Error("unused"); },
    acknowledge: async () => { throw new Error("unused"); },
    transition: async () => { throw new Error("unused"); },
    list: async () => { pages += 1; return { items: [], nextCursor: "more", unseenUpdateCount: 0 }; },
  });
  assert.deepEqual(await endless.exportAll(adminIdentity(), "all"), { items: [], truncated: true });
  assert.equal(pages, MAX_EXPORT_PAGES);
});

test("demo mode selects the in-memory service, and the override pins the Postgres one", () => {
  assert.equal(dataIssueService(), demoDataIssueService);
  overrideDataIssueService(postgresDataIssueService);
  assert.equal(dataIssueService(), postgresDataIssueService);
  overrideDataIssueService();
  assert.equal(dataIssueService(), demoDataIssueService);
});

// ------------------------------------------------------------------- routes
type Options = { method?: string; roles?: string; subject?: string; tenant?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> };
function request(path: string, options: Options = {}): Request {
  const method = options.method ?? "GET";
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method,
    headers: {
      "x-corvis-demo-tenant": options.tenant ?? "tenant-routes",
      "x-corvis-demo-subject": options.subject ?? "route-user",
      "x-corvis-demo-roles": options.roles ?? "analyst",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: hasBody ? (options.rawBody ?? JSON.stringify(options.body)) : undefined,
  });
}
const params = (caseId: string) => ({ params: Promise.resolve({ caseId }) });
type CaseJson = {
  caseId: string; status: string; figure: string; routedTo: string; reportedBy: string; reportedByMe: boolean; hasUnseenUpdate: boolean;
  resolutionNote: string | null; correctionIncidentId?: string; replacement: { snapshotId: string; snapshotVersion: number } | null; history: unknown[];
};
/** The API answers a single case or a list under `data`; the intersection lets one helper type serve both in these tests. */
type Body = {
  error?: string; replayed?: boolean; correlationId?: string; nextCursor?: string | null; unseenUpdateCount?: number; truncated?: boolean;
  data: CaseJson & Array<CaseJson>;
};
const body = async (response: Response) => (await response.json()) as Body;

test("POST /data-issues records a case, replays an idempotent retry as 200, and takes the key from the header too", async () => {
  const created = await reportPost(request("/data-issues", { method: "POST", body: report("route-1") }));
  assert.equal(created.status, 201);
  const payload = await body(created);
  assert.equal(payload.replayed, false);
  assert.equal(payload.data.status, "received");
  assert.equal(payload.data.routedTo, "data_operations");
  assert.ok(payload.correlationId);

  const replay = await reportPost(request("/data-issues", { method: "POST", body: report("route-1") }));
  assert.equal(replay.status, 200);
  const replayed = await body(replay);
  assert.deepEqual([replayed.replayed, replayed.data.caseId], [true, payload.data.caseId]);

  const { idempotencyKey, ...withoutKey } = report("route-1");
  assert.equal(idempotencyKey, "route-1");
  const viaHeader = await reportPost(request("/data-issues", { method: "POST", body: withoutKey, headers: { "idempotency-key": "route-1" } }));
  assert.equal(viaHeader.status, 200);
  assert.equal((await body(viaHeader)).data.caseId, payload.data.caseId, "the header and the body key share one namespace");

  const reused = await reportPost(request("/data-issues", { method: "POST", body: report("route-1", { comment: "different" }) }));
  assert.equal(reused.status, 409);
  assert.equal((await body(reused)).error, "idempotency_key_reused");
});

test("POST /data-issues answers typed 400s for malformed reports", async () => {
  for (const [bodyValue, error] of [
    [report("k", { figure: "fund_scorecard" }), "invalid_figure"],
    [report("k", { comment: "   " }), "invalid_comment"],
    [report("k", { scope: { fundId: "f" } }), "invalid_scope"],
    [{ ...report("k"), idempotencyKey: undefined }, "idempotency_key_required"],
  ] as const) {
    const response = await reportPost(request("/data-issues", { method: "POST", body: bodyValue }));
    assert.equal(response.status, 400);
    assert.equal((await body(response)).error, error);
  }
  for (const rawBody of ["not json", "null", "[]"]) {
    const response = await reportPost(request("/data-issues", { method: "POST", rawBody }));
    assert.equal(response.status, 400, rawBody);
    assert.equal((await body(response)).error, "invalid_request");
  }
});

test("the case list, detail and acknowledgement follow the reporter, and a colleague sees nothing of it", async () => {
  const created = await body(await reportPost(request("/data-issues", { method: "POST", tenant: "tenant-flow", body: report("flow-1") })));
  const id = created.data.caseId as string;

  const list = await body(await listGet(request("/data-issues", { tenant: "tenant-flow" })));
  assert.equal(list.data.length, 4, "three seeded cases and the new one");
  assert.equal(list.unseenUpdateCount, 1);
  assert.equal(list.nextCursor, null);
  const paged = await body(await listGet(request("/data-issues?limit=1&status=received", { tenant: "tenant-flow" })));
  assert.equal(paged.data.length, 1);
  assert.ok(paged.nextCursor);
  const rest = await body(await listGet(request(`/data-issues?limit=1&status=received&cursor=${encodeURIComponent(paged.nextCursor)}`, { tenant: "tenant-flow" })));
  assert.equal(rest.data.length, 1);
  assert.equal(rest.nextCursor, null);
  assert.notEqual(rest.data[0].caseId, paged.data[0].caseId);

  const detail = await itemGet(request(`/data-issues/${id}`, { tenant: "tenant-flow" }), params(id));
  assert.equal(detail.status, 200);
  assert.equal((await body(detail)).data.history.length, 1);
  const colleague = await itemGet(request(`/data-issues/${id}`, { tenant: "tenant-flow", subject: "colleague" }), params(id));
  assert.equal(colleague.status, 404);
  assert.equal((await body(colleague)).error, "data_issue_not_found");
  assert.equal((await body(await listGet(request("/data-issues", { tenant: "tenant-flow", subject: "colleague" })))).data.length, 3, "a colleague sees only their own seeded cases");

  const seededCorrected = list.data.find((item) => item.hasUnseenUpdate)!;
  const ack = await itemPatch(request(`/data-issues/${seededCorrected.caseId}`, { method: "PATCH", tenant: "tenant-flow", body: { seen: true } }), params(seededCorrected.caseId));
  assert.equal(ack.status, 200);
  assert.equal((await body(ack)).data.hasUnseenUpdate, false);
  assert.equal((await body(await listGet(request("/data-issues", { tenant: "tenant-flow" })))).unseenUpdateCount, 0);
  for (const bad of [{ seen: false }, {}, "x"]) {
    const response = await itemPatch(request(`/data-issues/${id}`, { method: "PATCH", tenant: "tenant-flow", body: bad }), params(id));
    assert.equal(response.status, 400);
  }
  assert.equal((await itemPatch(request(`/data-issues/${id}`, { method: "PATCH", tenant: "tenant-flow", rawBody: "{" }), params(id))).status, 400);
});

test("only an Organization Admin may list the tenant, and list parameters are validated", async () => {
  const denied = await listGet(request("/data-issues?scope=all", { tenant: "tenant-scope" }));
  assert.equal(denied.status, 403);
  assert.equal((await body(denied)).error, "tenant_admin_required");
  const all = await listGet(request("/data-issues?scope=all", { tenant: "tenant-scope", roles: "admin", subject: "boss" }));
  assert.equal(all.status, 200);
  for (const [query, error] of [["scope=everyone", "invalid_scope"], ["status=open", "invalid_status"], ["format=xml", "invalid_format"], ["limit=0", "invalid_limit"], ["cursor=!!!", "invalid_cursor"]]) {
    const response = await listGet(request(`/data-issues?${query}`, { tenant: "tenant-scope" }));
    assert.equal(response.status, 400, query);
    assert.equal((await body(response)).error, error, query);
  }
});

test("a case can be exported as CSV or JSON for the customer's own records, with spreadsheet formulas defused", async () => {
  const tenant = "tenant-export";
  await reportPost(request("/data-issues", { method: "POST", tenant, body: report("x-1", { comment: "=HYPERLINK(\"http://evil\")\nsecond line", scope: { fundId: "fund-advent-viii", reportPeriod: "Q2 2026", companyId: "c", companyLabel: "Co, \"Quoted\" Ltd" } }) }));
  const csv = await listGet(request("/data-issues?format=csv", { tenant }));
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /^text\/csv/);
  assert.match(csv.headers.get("content-disposition") ?? "", /attachment; filename=corvis-data-issues\.csv/);
  assert.equal(csv.headers.get("x-corvis-export-truncated"), "false");
  assert.equal(csv.headers.get("cache-control"), "no-store");
  const text = await csv.text();
  const lines = text.split("\n");
  assert.equal(lines[0], '"case_id","status","figure","fund","fund_id","company","company_id","metric","metric_code","report_period","snapshot_id","snapshot_version","comment","reported_by","reported_at","status_changed_at","resolution_note","replacement_snapshot_id","replacement_snapshot_version","correction_incident_id"');
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"")\nsecond line"`), "a formula-leading comment is neutralised and quoted");
  assert.ok(text.includes('"Co, ""Quoted"" Ltd"'));
  assert.ok(text.includes('"Corrected"') && text.includes('"Investigating"') && text.includes('"Received"'));

  const filtered = await (await listGet(request("/data-issues?format=csv&status=corrected", { tenant }))).text();
  assert.equal(filtered.trim().split("\n").length, 2, "the header and the one corrected case");

  const json = await listGet(request("/data-issues?format=json", { tenant }));
  assert.match(json.headers.get("content-disposition") ?? "", /attachment; filename=corvis-data-issues\.json/);
  const exported = await body(json);
  assert.equal(exported.data.length, 4);
  assert.equal(exported.truncated, false);
  assert.equal((await body(await listGet(request("/data-issues?format=json&status=received", { tenant })))).data.length, 2);
  const queue = await body(await queueGet(request("/admin/data-issues?format=json", { tenant, roles: "admin", subject: "boss" })));
  assert.equal(queue.data.length, 7, "the queue export is every case in the tenant: the reporter's four and the operator's own three seeded ones");
});

test("Data Operations works the queue: list, read, move, and a reporter is told through the case itself", async () => {
  const tenant = "tenant-queue";
  const created = await body(await reportPost(request("/data-issues", { method: "POST", tenant, body: report("q-1") })));
  const id = created.data.caseId as string;
  const events: AuditEvent[] = [];
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  try {
    const operator = { tenant, roles: "admin", subject: "ops-user" };
    const queue = await body(await queueGet(request("/admin/data-issues?status=received", operator)));
    assert.ok(queue.data.some((item) => item.caseId === id));
    assert.ok(queue.data.every((item) => item.status === "received"));
    const detail = await body(await adminItemGet(request(`/admin/data-issues/${id}`, operator), params(id)));
    assert.equal(detail.data.reportedBy, "route-user");

    const refuse = await adminItemPatch(request(`/admin/data-issues/${id}`, { ...operator, method: "PATCH", body: { action: "correct" } }), params(id));
    assert.equal(refuse.status, 409);
    assert.equal((await body(refuse)).error, "data_issue_transition_not_allowed");

    const investigate = await adminItemPatch(request(`/admin/data-issues/${id}`, { ...operator, method: "PATCH", body: { action: "investigate", expectedStatus: "received" } }), params(id));
    assert.equal(investigate.status, 200);
    assert.equal((await body(investigate)).data.status, "investigating");
    const incident = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
    const corrected = await body(await adminItemPatch(request(`/admin/data-issues/${id}`, { ...operator, method: "PATCH", body: { action: "correct", correctionIncidentId: incident } }), params(id)));
    assert.equal(corrected.data.status, "corrected");
    assert.equal(corrected.data.correctionIncidentId, incident);
    assert.deepEqual(events.map((event) => event.action), ["data_issue.investigate", "data_issue.correct"]);

    const reporterView = await body(await itemGet(request(`/data-issues/${id}`, { tenant }), params(id)));
    assert.equal(reporterView.data.status, "corrected");
    assert.equal(reporterView.data.hasUnseenUpdate, true, "the reporter sees the status change as an update");
    assert.equal(reporterView.data.replacement?.snapshotVersion, 2);
    assert.equal(reporterView.data.correctionIncidentId, undefined);

    for (const bad of [{}, { action: "reopen" }, { action: "no_change" }, { action: "correct", correctionIncidentId: "x" }]) {
      const response = await adminItemPatch(request(`/admin/data-issues/${id}`, { ...operator, method: "PATCH", body: bad }), params(id));
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    assert.equal((await adminItemPatch(request(`/admin/data-issues/${id}`, { ...operator, method: "PATCH", rawBody: "nope" }), params(id))).status, 400);
    assert.equal((await adminItemPatch(request(`/admin/data-issues/${"00000000-0000-4000-8000-000000000000"}`, { ...operator, method: "PATCH", body: { action: "investigate" } }), params("00000000-0000-4000-8000-000000000000"))).status, 404);
  } finally {
    port.audit = original;
  }
});

test("an analyst cannot reach the Data Operations queue or move a case", async () => {
  const analyst = { tenant: "tenant-denied", roles: "analyst" };
  const created = await body(await reportPost(request("/data-issues", { method: "POST", tenant: analyst.tenant, body: report("d-1") })));
  const id = created.data.caseId as string;
  assert.equal((await queueGet(request("/admin/data-issues", analyst))).status, 403);
  assert.equal((await adminItemGet(request(`/admin/data-issues/${id}`, analyst), params(id))).status, 403);
  const patch = await adminItemPatch(request(`/admin/data-issues/${id}`, { ...analyst, method: "PATCH", body: { action: "investigate" } }), params(id));
  assert.equal(patch.status, 403);
  assert.equal((await body(await itemGet(request(`/data-issues/${id}`, analyst), params(id)))).data.status, "received", "nothing moved");
});

test("reporting never changes what is published: the case store is the only thing a report writes", async () => {
  const tenant = "tenant-inert";
  const port = platform();
  const snapshotsBefore = JSON.stringify(await port.listSnapshots(identity({ tenantId: tenant })));
  const observationsBefore = JSON.stringify(await port.listObservations(identity({ tenantId: tenant })));
  const response = await reportPost(request("/data-issues", { method: "POST", tenant, body: report("inert-1", { figure: "review", comment: "This revenue is wrong; please correct it." }) }));
  assert.equal(response.status, 201);
  assert.equal(JSON.stringify(await port.listSnapshots(identity({ tenantId: tenant }))), snapshotsBefore, "no snapshot or publication state moved");
  assert.equal(JSON.stringify(await port.listObservations(identity({ tenantId: tenant }))), observationsBefore, "no observation changed");
});
