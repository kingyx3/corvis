import assert from "node:assert/strict";
import test from "node:test";
import type { UploadObjectStore } from "../../../../platform/gcp/gcs.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import type { UploadLifecycleOptions, UploadLifecycleSweep, UploadSessionPort } from "./uploads.ts";
import { sweepUploadSessions, UPLOAD_SWEEP_ROTATION_KEY, uploadSweepCursorKey } from "./upload-sweep.ts";

process.env.CORVIS_DEMO_MODE = "true";
console.error = () => undefined;

const TENANTS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

function db(tenants = TENANTS): PostgresSqlApi {
  return {
    async query(sql: string): Promise<PostgresRow[]> {
      assert.match(sql, /from corvis_control\.tenant where status='active'/);
      return tenants.map((tenant_id) => ({ tenant_id }));
    },
    async execute(): Promise<void> {},
    async health(): Promise<boolean> { return true; },
  };
}

function jsonStore(): UploadObjectStore & { objects: Map<string, unknown> } {
  const objects = new Map<string, unknown>();
  return {
    objects,
    bucket: "b",
    async putJson(key: string, value: unknown) { objects.set(key, JSON.parse(JSON.stringify(value))); },
    async getJson<T>(key: string) { return (objects.get(key) as T) ?? null; },
  } as unknown as UploadObjectStore & { objects: Map<string, unknown> };
}

function sweeper(pages: Record<string, Array<{ cursor?: string; result: UploadLifecycleSweep }>>, calls: Array<[string, UploadLifecycleOptions | undefined]>): UploadSessionPort {
  return {
    async sweep(tenantId: string, options?: UploadLifecycleOptions) {
      calls.push([tenantId, options]);
      const page = pages[tenantId]?.find((candidate) => candidate.cursor === options?.cursor);
      if (!page) throw new Error("boom");
      return page.result;
    },
  } as UploadSessionPort;
}

const empty = (extra: Partial<UploadLifecycleSweep> = {}): UploadLifecycleSweep => ({ scanned: 0, abandoned: 0, quarantinePurged: 0, retained: 0, skipped: 0, ...extra });

test("each tick sweeps one page per active tenant and resumes from the stored cursor, wrapping at the end", async () => {
  const store = jsonStore();
  const calls: Array<[string, UploadLifecycleOptions | undefined]> = [];
  const sessions = sweeper({
    [TENANTS[0]!]: [{ cursor: undefined, result: empty({ scanned: 2, abandoned: 1, nextCursor: "p2" }) }, { cursor: "p2", result: empty({ scanned: 1, quarantinePurged: 1 }) }],
    [TENANTS[1]!]: [{ cursor: undefined, result: empty({ scanned: 3, retained: 3 }) }],
  }, calls);
  const first = await sweepUploadSessions({ store, db: db(), sessions, pageSize: 2 });
  assert.deepEqual(first, { tenants: 2, scanned: 5, abandoned: 1, quarantinePurged: 0, retained: 3, skipped: 0, errors: 0 });
  assert.deepEqual((store.objects.get(uploadSweepCursorKey(TENANTS[0]!)) as { cursor: string }).cursor, "p2");
  const second = await sweepUploadSessions({ store, db: db(), sessions, pageSize: 2 });
  assert.equal(second.quarantinePurged, 1);
  assert.deepEqual(calls.map(([tenant, options]) => [tenant, options?.cursor, options?.limit]), [
    [TENANTS[0], undefined, 2], [TENANTS[1], undefined, 2], [TENANTS[0], "p2", 2], [TENANTS[1], undefined, 2],
  ]);
  assert.equal((store.objects.get(uploadSweepCursorKey(TENANTS[0]!)) as { cursor: string | null }).cursor, null, "the last page wraps back to the start");
});

test("a failing tenant is counted and keeps its cursor without blocking the others", async () => {
  const store = jsonStore();
  store.objects.set(uploadSweepCursorKey(TENANTS[0]!), { cursor: "stuck" });
  const calls: Array<[string, UploadLifecycleOptions | undefined]> = [];
  const summary = await sweepUploadSessions({ store, db: db(), sessions: sweeper({ [TENANTS[1]!]: [{ cursor: undefined, result: empty({ scanned: 1, retained: 1 }) }] }, calls) });
  assert.equal(summary.errors, 1);
  assert.equal(summary.tenants, 1);
  assert.equal((store.objects.get(uploadSweepCursorKey(TENANTS[0]!)) as { cursor: string }).cursor, "stuck");
});

test("the time budget stops starting new tenants", async () => {
  let clock = 0;
  const calls: Array<[string, UploadLifecycleOptions | undefined]> = [];
  const sessions = sweeper({ [TENANTS[0]!]: [{ cursor: undefined, result: empty() }], [TENANTS[1]!]: [{ cursor: undefined, result: empty() }] }, calls);
  const summary = await sweepUploadSessions({ store: jsonStore(), db: db(), sessions: { sweep: async (tenant, options) => { clock += 1_000; return sessions.sweep(tenant, options); } } as UploadSessionPort, budgetMs: 500, now: () => clock });
  assert.equal(summary.tenants, 1);
});

test("a budget that only fits some tenants still reaches the tail tenants on later ticks", async () => {
  const tenants = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(8) + "-0000-4000-8000-000000000000");
  const store = jsonStore();
  let clock = 0;
  const visited: string[] = [];
  const sessions = { sweep: async (tenantId: string) => { visited.push(tenantId); clock += 1_000; return empty(); } } as unknown as UploadSessionPort;
  // Each tenant costs 1s of the 2.5s budget, so a tick starts three tenants and cuts the rest.
  const tick = () => sweepUploadSessions({ store, db: db(tenants), sessions, budgetMs: 2_500, now: () => clock });

  await tick();
  assert.deepEqual(visited, tenants.slice(0, 3));
  clock = 0;
  await tick();
  assert.deepEqual(visited.slice(3, 6), [tenants[3], tenants[4], tenants[0]], "the next tick resumes after the last tenant reached and wraps");
  assert.ok(visited.includes(tenants[4]!), "the tail tenant is visited");
  clock = 0;
  await tick();
  assert.deepEqual(visited.slice(6, 9), [tenants[1], tenants[2], tenants[3]]);
});

test("a lost rotation record only restarts from the first tenant; the sweep still runs", async () => {
  const store = jsonStore();
  const { getJson, putJson } = store;
  store.getJson = (async (key: string) => { if (key === UPLOAD_SWEEP_ROTATION_KEY) throw new Error("storage unavailable"); return getJson.call(store, key); }) as typeof store.getJson;
  store.putJson = (async (key: string, value: unknown) => { if (key === UPLOAD_SWEEP_ROTATION_KEY) throw new Error("storage unavailable"); return putJson.call(store, key, value); }) as typeof store.putJson;
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const calls: Array<[string, UploadLifecycleOptions | undefined]> = [];
    const sessions = { sweep: async (tenantId: string, options?: UploadLifecycleOptions) => { calls.push([tenantId, options]); return empty(); } } as unknown as UploadSessionPort;
    const summary = await sweepUploadSessions({ store, db: db(), sessions });
    assert.deepEqual([summary.tenants, summary.errors], [2, 0]);
    assert.deepEqual(calls.map(([tenant]) => tenant), TENANTS);
  } finally {
    console.warn = warn;
  }
});
