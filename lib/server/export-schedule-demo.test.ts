import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent, RequestIdentity } from "../../core/enterprise.ts";
import type { CreateExportScheduleCommand } from "../../core/export-schedule.ts";
import { DemoExportScheduleStore } from "../../adapters/demo/export-schedule-store.ts";
import { ExportScheduleRequestError } from "./export-schedule.ts";

// See lib/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
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

const { GET: listGet, POST: createPost } = await import("@/app/api/v1/export-schedules/route");
const { GET: itemGet, PATCH: itemPatch, DELETE: itemDelete } = await import("@/app/api/v1/export-schedules/[scheduleId]/route");
const { GET: runsGet } = await import("@/app/api/v1/export-schedules/runs/route");
const { exportScheduleService, demoExportScheduleService, postgresExportScheduleService, overrideExportScheduleService, createExportScheduleService } = await import("./export-schedule-service.ts");
const { platform } = await import("./platform.ts");

const NOW = new Date("2026-10-02T12:00:00.000Z");
const refusal = (code: string, status: number) => (error: unknown) => error instanceof ExportScheduleRequestError && error.code === code && error.status === status;

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "demo-user", tenantId: "tenant-store", workspaceId: "workspace-store", roles: ["analyst"], authMethod: "demo", sessionId: "s",
    entitlements: { workspaceIds: ["workspace-store"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const adminIdentity = (overrides: Partial<RequestIdentity> = {}) => identity({ subject: "demo-admin", roles: ["admin"], isTenantAdmin: true, ...overrides });
const store = () => new DemoExportScheduleStore(() => NOW);
const position = { positionFinancials: { fundId: "fund-eqt-ix", holdingId: "holding-1", companyId: "company-1", periodicity: "annual" as const } };
const command = (key: string, overrides: Partial<CreateExportScheduleCommand> = {}): CreateExportScheduleCommand => ({
  idempotencyKey: key, label: "Annual sparrow", scope: position, format: "xlsx", trigger: "quarterly", notifyOnCompletion: true, ...overrides,
});

test("each owning subject is seeded once with an active monthly schedule that delivered and a paused on-publish one whose last run was refused", async () => {
  const demo = store();
  const mine = await demo.list(identity(), { scope: "mine", limit: 50 });
  assert.deepEqual(mine.items.map((item) => [item.trigger, item.status]).sort(), [["monthly", "active"], ["on_publish", "paused"]]);
  const monthly = mine.items.find((item) => item.trigger === "monthly")!;
  assert.equal(monthly.nextRunAt, "2026-11-01T00:00:00.000Z");
  assert.equal(monthly.ownedByMe, true);
  assert.equal(monthly.lastRun?.outcome, "requested");
  assert.equal(monthly.lastRun?.exportState, "complete");
  assert.match(monthly.lastRun!.triggerKey, /^monthly:2026-09$/);
  const paused = mine.items.find((item) => item.trigger === "on_publish")!;
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.lastRun?.outcome, "failed");
  assert.equal(paused.lastRun?.failureReason, "redistribution_not_permitted");
  assert.equal((await demo.list(identity(), { scope: "mine", limit: 50 })).items.length, 2, "listing again does not seed again");
  assert.equal((await demo.list(identity({ subject: "another-demo-user" }), { scope: "mine", limit: 50 })).items.length, 2, "another subject gets its own seeds");
  assert.equal((await demo.list(identity({ tenantId: "tenant-other" }), { scope: "mine", limit: 50 })).items.length, 2);
});

test("creating a schedule is idempotent per owner, refuses a reused key with different content and starts from now", async () => {
  const demo = store();
  const first = await demo.create(identity(), command("key-1"));
  assert.equal(first.created, true);
  assert.deepEqual([first.item.status, first.item.trigger, first.item.format, first.item.lastRun, first.item.stopReason], ["active", "quarterly", "xlsx", null, null]);
  assert.equal(first.item.nextRunAt, "2027-01-01T00:00:00.000Z", "the next quarter start, not now");
  assert.equal(first.item.scopeLabel, "Position financials · company-1 · annual");
  assert.equal(first.item.createdAt, NOW.toISOString());
  const again = await demo.create(identity(), command("key-1"));
  assert.deepEqual([again.created, again.item.scheduleId], [false, first.item.scheduleId]);
  await assert.rejects(() => demo.create(identity(), command("key-1", { label: "Something else" })), refusal("idempotency_key_reused", 409));
  const colleague = await demo.create(identity({ subject: "colleague" }), command("key-1"));
  assert.equal(colleague.created, true, "keys are per owner");
  assert.notEqual(colleague.item.scheduleId, first.item.scheduleId);
  const onPublish = await demo.create(identity(), command("key-2", { trigger: "on_publish", scope: { snapshotId: "seed-snapshot-2" } }));
  assert.equal(onPublish.item.nextRunAt, null, "a publication schedule has no calendar run");
  assert.deepEqual(onPublish.item.scope, { snapshotId: "seed-snapshot-2" });
  assert.equal((await demo.create(identity(), command("key-3", { trigger: "monthly" }))).item.nextRunAt, "2026-11-01T00:00:00.000Z");
});

test("a scorecard schedule is saved like any other, idempotent per owner and distinct per filter", async () => {
  const demo = store();
  const scorecard = command("sc-1", { scope: { performanceScorecard: true }, trigger: "on_publish" });
  const first = await demo.create(identity(), scorecard);
  assert.equal(first.created, true);
  assert.equal(first.item.scopeLabel, "Performance scorecard · all entitled funds");
  assert.deepEqual(first.item.scope, { performanceScorecard: true });
  assert.equal(first.item.nextRunAt, null);
  assert.equal((await demo.create(identity(), scorecard)).created, false);
  await assert.rejects(demo.create(identity(), { ...scorecard, scope: { performanceScorecard: true, fundId: "fund-eqt-ix" } }), refusal("idempotency_key_reused", 409));
  const filtered = await demo.create(identity(), command("sc-2", { scope: { performanceScorecard: true, fundId: "fund-eqt-ix", period: "Q1 2026" } }));
  assert.equal(filtered.item.scopeLabel, "Performance scorecard · fund-eqt-ix · Q1 2026");
});

test("an owner holds at most 50 schedules that have not been deleted", async () => {
  const demo = store();
  const who = identity();
  for (let index = 0; index < 47; index += 1) await demo.create(who, command(`bulk-${index}`)); // with the two seeded schedules, 49 of 50
  const last = await demo.create(who, command("bulk-last"));
  await assert.rejects(() => demo.create(who, command("bulk-over")), refusal("export_schedule_limit_reached", 409));
  await demo.remove(who, last.item.scheduleId);
  assert.equal((await demo.create(who, command("bulk-after-delete"))).created, true, "a deleted schedule frees its place");
  assert.equal((await demo.create(identity({ subject: "colleague" }), command("bulk-other"))).created, true, "the limit is per owner");
});

test("only the owner pauses, resumes or deletes: an Organization Admin sees every schedule and changes none", async () => {
  const demo = store();
  const mine = (await demo.create(identity(), command("key-1"))).item;
  assert.equal((await demo.get(identity(), mine.scheduleId)).ownedByMe, true);
  const seen = await demo.get(adminIdentity(), mine.scheduleId);
  assert.deepEqual([seen.ownedByMe, seen.owner], [false, "demo-user"]);
  assert.ok((await demo.list(adminIdentity(), { scope: "all", limit: 50 })).items.some((item) => item.scheduleId === mine.scheduleId));
  assert.ok(!(await demo.list(adminIdentity(), { scope: "mine", limit: 50 })).items.some((item) => item.scheduleId === mine.scheduleId));
  assert.ok(!(await demo.list(identity({ subject: "colleague" }), { scope: "mine", limit: 50 })).items.some((item) => item.scheduleId === mine.scheduleId));

  for (const attempt of [
    () => demo.setStatus(adminIdentity(), mine.scheduleId, "pause"),
    () => demo.remove(adminIdentity(), mine.scheduleId),
    () => demo.setStatus(identity({ subject: "colleague" }), mine.scheduleId, "pause"),
    () => demo.get(identity({ subject: "colleague" }), mine.scheduleId),
    () => demo.get(identity({ tenantId: "tenant-other" }), mine.scheduleId),
    () => demo.get(identity(), "00000000-0000-4000-8000-000000000000"),
    () => demo.remove(identity(), "00000000-0000-4000-8000-000000000000"),
  ]) await assert.rejects(attempt, refusal("export_schedule_not_found", 404));
  assert.equal((await demo.get(identity(), mine.scheduleId)).status, "active", "refused changes leave it untouched");
});

test("pause holds a schedule and resume restarts it from now, with no catch-up; delete is final", async () => {
  const clock = { now: new Date("2026-10-02T12:00:00.000Z") };
  const demo = new DemoExportScheduleStore(() => clock.now);
  const who = identity();
  const item = (await demo.create(who, command("key-1", { trigger: "monthly" }))).item;
  assert.equal(item.nextRunAt, "2026-11-01T00:00:00.000Z");

  clock.now = new Date("2026-10-20T08:00:00.000Z");
  const paused = await demo.setStatus(who, item.scheduleId, "pause");
  assert.deepEqual([paused.status, paused.nextRunAt, paused.updatedAt], ["paused", null, "2026-10-20T08:00:00.000Z"]);
  await assert.rejects(() => demo.setStatus(who, item.scheduleId, "pause"), refusal("export_schedule_transition_not_allowed", 409));

  clock.now = new Date("2026-11-15T08:00:00.000Z");
  const resumed = await demo.setStatus(who, item.scheduleId, "resume");
  assert.deepEqual([resumed.status, resumed.nextRunAt], ["active", "2026-12-01T00:00:00.000Z"], "November's run was missed while paused and is not caught up");
  await assert.rejects(() => demo.setStatus(who, item.scheduleId, "resume"), refusal("export_schedule_transition_not_allowed", 409));

  const publication = (await demo.create(who, command("key-2", { trigger: "on_publish", scope: { snapshotId: "seed-snapshot-3" } }))).item;
  await demo.setStatus(who, publication.scheduleId, "pause");
  assert.equal((await demo.setStatus(who, publication.scheduleId, "resume")).nextRunAt, null);

  assert.deepEqual(await demo.remove(who, item.scheduleId), { scheduleId: item.scheduleId, label: "Annual sparrow", trigger: "monthly", format: "xlsx" });
  await assert.rejects(() => demo.get(who, item.scheduleId), refusal("export_schedule_not_found", 404));
  await assert.rejects(() => demo.setStatus(who, item.scheduleId, "resume"), refusal("export_schedule_not_found", 404));
  await assert.rejects(() => demo.remove(who, item.scheduleId), refusal("export_schedule_not_found", 404));
  assert.ok(!(await demo.list(who, { scope: "mine", limit: 50 })).items.some((entry) => entry.scheduleId === item.scheduleId));
});

test("the list pages newest first with an opaque cursor, every schedule exactly once", async () => {
  const demo = store();
  const who = identity();
  await demo.create(who, command("a"));
  await demo.create(who, command("b", { label: "Second" }));
  const all = await demo.list(who, { scope: "mine", limit: 50 });
  assert.equal(all.items.length, 4);
  const firstPage = await demo.list(who, { scope: "mine", limit: 3 });
  assert.equal(firstPage.items.length, 3);
  assert.ok(firstPage.nextCursor);
  const secondPage = await demo.list(who, { scope: "mine", limit: 3, cursor: firstPage.nextCursor });
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual([...firstPage.items, ...secondPage.items].map((item) => item.scheduleId).sort(), all.items.map((item) => item.scheduleId).sort());
  await assert.rejects(() => demo.list(who, { scope: "mine", limit: 2, cursor: "!!!" }), /invalid_cursor/);
  await assert.rejects(() => demo.listRuns(who, { scope: "mine", limit: 2, cursor: "!!!" }), /invalid_cursor/);
});

test("run history keeps the runs of deleted schedules and can be narrowed to one schedule", async () => {
  const demo = store();
  const who = identity();
  const runs = await demo.listRuns(who, { scope: "mine", limit: 50 });
  assert.equal(runs.items.length, 3);
  assert.deepEqual(runs.items.map((run) => run.outcome), ["failed", "requested", "requested"], "newest first");
  assert.ok(runs.items.every((run) => run.scheduleLabel && run.scopeLabel && run.triggerKey), "each run names its schedule and scope");
  const refused = runs.items[0]!;
  assert.deepEqual([refused.failureReason, refused.exportId], ["redistribution_not_permitted", undefined]);

  const narrowed = await demo.listRuns(who, { scope: "mine", limit: 50, scheduleId: refused.scheduleId });
  assert.deepEqual(narrowed.items.map((run) => run.scheduleId), [refused.scheduleId, refused.scheduleId]);
  const first = await demo.listRuns(who, { scope: "mine", limit: 2 });
  const second = await demo.listRuns(who, { scope: "mine", limit: 2, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map((run) => run.runId), runs.items.map((run) => run.runId));
  assert.equal(second.nextCursor, null);

  await demo.remove(who, refused.scheduleId);
  assert.equal((await demo.listRuns(who, { scope: "mine", limit: 50 })).items.length, 3, "deleting a schedule does not erase its history");
  assert.equal((await demo.listRuns(adminIdentity(), { scope: "mine", limit: 50 })).items.length, 3, "an admin's own history is their own, seeded once");
  assert.ok((await demo.listRuns(adminIdentity(), { scope: "all", limit: 50 })).items.length >= 6, "an Organization Admin sees every owner's runs");
  assert.equal((await demo.listRuns(identity({ subject: "colleague" }), { scope: "mine", limit: 50, scheduleId: refused.scheduleId })).items.length, 0);
});

test("the service selects the demo store in demo mode and audits only what changed", async () => {
  assert.equal(exportScheduleService(), demoExportScheduleService);
  assert.notEqual(demoExportScheduleService, postgresExportScheduleService);
  const events: AuditEvent[] = [];
  const service = createExportScheduleService(store());
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  try {
    const noScope = identity({ roles: ["analyst"] });
    await assert.rejects(() => service.list(noScope, { scope: "all", limit: 5 }), refusal("tenant_admin_required", 403));
    await assert.rejects(() => service.listRuns(noScope, { scope: "all", limit: 5 }), refusal("tenant_admin_required", 403));
    assert.equal(events.length, 0, "a refused read is not audited");

    const created = await service.create(identity(), command("k"), "corr-1");
    const replay = await service.create(identity(), command("k"), "corr-2");
    assert.deepEqual([created.created, replay.created], [true, false]);
    await service.setStatus(identity(), created.item.scheduleId, "pause", "corr-3");
    await service.setStatus(identity(), created.item.scheduleId, "resume", "corr-4");
    await service.remove(identity(), created.item.scheduleId, "corr-5");
    await assert.rejects(() => service.remove(identity(), created.item.scheduleId, "corr-6"), refusal("export_schedule_not_found", 404));
    assert.equal((await service.list(adminIdentity(), { scope: "all", limit: 50 })).items.length >= 2, true);
    assert.equal((await service.listRuns(adminIdentity(), { scope: "all", limit: 50 })).items.length >= 3, true);
    assert.equal((await service.get(identity(), (await service.list(identity(), { scope: "mine", limit: 1 })).items[0]!.scheduleId)).ownedByMe, true);

    assert.deepEqual(events.map((event) => [event.action, event.correlationId]), [
      ["export_schedule.create", "corr-1"], ["export_schedule.pause", "corr-3"], ["export_schedule.resume", "corr-4"], ["export_schedule.delete", "corr-5"],
    ], "a replay and a refused command are not audited as changes");
    assert.ok(events.every((event) => event.targetType === "export_schedule" && event.actorSubject === "demo-user" && event.outcome === "success"));
    assert.deepEqual(events[3]!.metadata, { label: "Annual sparrow", trigger: "quarterly", format: "xlsx", status: "deleted" });
  } finally { port.audit = original; }
});

// ---------------------------------------------------------------- the routes in demo mode
let sequence = 0;
type Caller = { roles?: string; subject?: string; tenant?: string; method?: string; body?: unknown; headers?: Record<string, string> };
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const hasBody = caller.body !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method: caller.method ?? "GET",
    headers: {
      "x-correlation-id": `corr-demo-schedule-${sequence}`,
      "x-corvis-demo-tenant": caller.tenant ?? "tenant-routes",
      "x-corvis-demo-subject": caller.subject ?? "demo-user",
      "x-corvis-demo-roles": caller.roles ?? "analyst",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...caller.headers,
    },
    body: hasBody ? JSON.stringify(caller.body) : undefined,
  });
}
const params = (scheduleId: string) => ({ params: Promise.resolve({ scheduleId }) });
type Json = { error?: string; replayed?: boolean; nextCursor?: string | null; data: Record<string, unknown> & Array<Record<string, unknown>> };
const json = async (response: Response) => (await response.json()) as Json;

test("scheduling works end to end in demo mode: create, list, pause, resume, delete, with the owner and Organization Admin views", async () => {
  const tenant = "tenant-e2e";
  const created = await createPost(request("/export-schedules", { method: "POST", tenant, body: { idempotencyKey: "r-1", label: "Monthly sparrow", scope: position, format: "csv", trigger: "monthly" } }));
  assert.equal(created.status, 201);
  const item = (await json(created)).data;
  assert.equal(item.status, "active");
  const replay = await createPost(request("/export-schedules", { method: "POST", tenant, headers: { "idempotency-key": "r-1" }, body: { label: "Monthly sparrow", scope: position, format: "csv", trigger: "monthly" } }));
  assert.deepEqual([replay.status, (await json(replay)).replayed], [200, true]);

  const list = await json(await listGet(request("/export-schedules?limit=50", { tenant })));
  assert.equal(list.data.length, 3, "two seeded schedules and the new one");
  const id = String(item.scheduleId);
  assert.equal((await json(await itemGet(request(`/export-schedules/${id}`, { tenant }), params(id)))).data.label, "Monthly sparrow");

  const paused = await itemPatch(request(`/export-schedules/${id}`, { method: "PATCH", tenant, body: { action: "pause" } }), params(id));
  assert.equal((await json(paused)).data.status, "paused");
  const conflict = await itemPatch(request(`/export-schedules/${id}`, { method: "PATCH", tenant, body: { action: "pause" } }), params(id));
  assert.deepEqual([conflict.status, (await json(conflict)).error], [409, "export_schedule_transition_not_allowed"]);
  assert.equal((await json(await itemPatch(request(`/export-schedules/${id}`, { method: "PATCH", tenant, body: { action: "resume" } }), params(id)))).data.status, "active");

  const operator = { tenant, roles: "admin", subject: "demo-boss" };
  const everyone = await json(await listGet(request("/export-schedules?scope=all&limit=50", operator)));
  assert.ok(everyone.data.some((entry) => entry.scheduleId === id && entry.ownedByMe === false && entry.owner === "demo-user"));
  const notYours = await itemPatch(request(`/export-schedules/${id}`, { method: "PATCH", ...operator, body: { action: "pause" } }), params(id));
  assert.equal(notYours.status, 404);
  const history = await json(await runsGet(request("/export-schedules/runs?scope=all", operator)));
  assert.ok(history.data.length >= 3);

  const deleted = await itemDelete(request(`/export-schedules/${id}`, { method: "DELETE", tenant }), params(id));
  assert.deepEqual((await json(deleted)).data, { scheduleId: id, status: "deleted" });
  assert.equal((await itemGet(request(`/export-schedules/${id}`, { tenant }), params(id))).status, 404);
  assert.equal((await listGet(request("/export-schedules?scope=all", { tenant }))).status, 403);
  assert.equal((await listGet(request("/export-schedules", { tenant, roles: "read_only" }))).status, 403, "a viewer cannot export, so cannot schedule one");
});

test("demo mode serves schedules without ever touching a database", async () => {
  overrideExportScheduleService();
  const response = await listGet(request("/export-schedules", { tenant: "tenant-no-db" }));
  assert.equal(response.status, 200);
});

test("emails about a schedule are on by default, chosen at creation and changed by the owner only, with each change audited", async () => {
  const demo = store();
  const seeded = await demo.list(identity(), { scope: "mine", limit: 50 });
  assert.ok(seeded.items.length > 0 && seeded.items.every((item) => item.notifyOnCompletion === true), "seeded schedules keep the default");

  const quiet = (await demo.create(identity(), command("key-quiet", { notifyOnCompletion: false }))).item;
  assert.equal(quiet.notifyOnCompletion, false);
  const loud = (await demo.create(identity(), command("key-loud"))).item;
  assert.equal(loud.notifyOnCompletion, true);
  await assert.rejects(() => demo.create(identity(), command("key-quiet", { notifyOnCompletion: true })), refusal("idempotency_key_reused", 409));
  assert.equal((await demo.create(identity(), command("key-quiet", { notifyOnCompletion: false }))).created, false);

  const off = await demo.setNotification(identity(), loud.scheduleId, false);
  assert.equal(off.notifyOnCompletion, false);
  const updatedAt = off.updatedAt;
  assert.equal((await demo.setNotification(identity(), loud.scheduleId, false)).updatedAt, updatedAt, "setting the value it already has changes nothing");
  assert.equal((await demo.setNotification(identity(), loud.scheduleId, true)).notifyOnCompletion, true);
  assert.equal((await demo.get(identity(), loud.scheduleId)).notifyOnCompletion, true);

  for (const attempt of [
    () => demo.setNotification(adminIdentity(), loud.scheduleId, false),
    () => demo.setNotification(identity({ subject: "colleague" }), loud.scheduleId, false),
    () => demo.setNotification(identity(), "00000000-0000-4000-8000-000000000000", false),
  ]) await assert.rejects(attempt, refusal("export_schedule_not_found", 404));
  assert.equal((await demo.get(identity(), loud.scheduleId)).notifyOnCompletion, true, "refused changes leave it untouched");

  const events: AuditEvent[] = [];
  const service = createExportScheduleService(store());
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  try {
    const created = await service.create(identity(), command("key-audited"), "corr-n1");
    const changed = await service.setNotification(identity(), created.item.scheduleId, false, "corr-n2");
    assert.equal(changed.notifyOnCompletion, false);
    await assert.rejects(() => service.setNotification(adminIdentity(), created.item.scheduleId, true, "corr-n3"), refusal("export_schedule_not_found", 404));
    assert.deepEqual(events.map((event) => [event.action, event.correlationId]), [["export_schedule.create", "corr-n1"], ["export_schedule.notify", "corr-n2"]]);
    assert.deepEqual(events[1]!.metadata, { label: "Annual sparrow", trigger: "quarterly", format: "xlsx", status: "active", notifyOnCompletion: false });
  } finally { port.audit = original; }
});

test("the notification switch works through the routes in demo mode", async () => {
  const created = await json(await createPost(request("/export-schedules", { method: "POST", body: { idempotencyKey: "route-notify", label: "Quiet one", scope: { snapshotId: "seed-snapshot-4" }, format: "csv", trigger: "monthly", notifyOnCompletion: false } })));
  const id = String(created.data.scheduleId);
  assert.equal(created.data.notifyOnCompletion, false);
  const on = await itemPatch(request(`/export-schedules/${id}`, { method: "PATCH", body: { notifyOnCompletion: true } }), params(id));
  assert.equal(on.status, 200);
  assert.equal((await json(on)).data.notifyOnCompletion, true);
  const other = await itemPatch(request(`/export-schedules/${id}`, { method: "PATCH", roles: "admin", subject: "demo-boss", body: { notifyOnCompletion: false } }), params(id));
  assert.equal(other.status, 404);
  assert.equal((await json(await itemGet(request(`/export-schedules/${id}`), params(id)))).data.notifyOnCompletion, true);
});
