import assert from "node:assert/strict";
import test from "node:test";
import { acquireLock } from "./lock.ts";
import { resolveRunMode } from "./schedule.ts";
import { GcsStateStore, InMemoryStateStore } from "./state.ts";

test("monthly candidate resolves by Asia/Singapore day of month", () => {
  assert.equal(resolveRunMode("monthly-candidate", new Date("2026-09-05T20:31:00Z")), "monthly"); // Sep 6 Singapore
  assert.equal(resolveRunMode("monthly-candidate", new Date("2026-09-12T20:31:00Z")), "weekly"); // Sep 13 Singapore
  assert.equal(resolveRunMode("daily", new Date()), "daily");
  assert.throws(() => resolveRunMode("invalid"), /--mode must be one of/);
});

test("conditional state allows only one simultaneous lock winner", async () => {
  const store = new InMemoryStateStore();
  const now = new Date("2026-09-21T00:00:00Z");
  const [left, right] = await Promise.all([
    acquireLock(store, "left", now, 60_000),
    acquireLock(store, "right", now, 60_000),
  ]);
  assert.equal(Number(left.acquired) + Number(right.acquired), 1);
});

test("every GCS and metadata-token request carries an abort-timeout signal", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("http://metadata.google.internal/")) {
      return new Response(JSON.stringify({ access_token: "meta-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response("state", { status: 200, headers: { "x-goog-generation": "7" } });
  };
  // No tokenProvider: the default provider exercises the metadata-server fetch.
  const store = new GcsStateStore({ bucket: "corvis-control-state.example", fetchImpl });

  await store.readVersioned("lock");
  await store.write("lock", "v");
  await store.write("lock", null);
  await store.writeIfVersion("lock", "v", "7");
  await store.writeIfVersion("lock", null, "7");

  assert.equal(calls.length, 6, "one metadata token fetch (cached) plus five storage calls");
  assert.ok(calls[0]?.url.startsWith("http://metadata.google.internal/"));
  for (const call of calls) {
    assert.ok(call.init?.signal instanceof AbortSignal, `no timeout signal on ${call.init?.method ?? "GET"} ${call.url}`);
  }
});

test("a hung GCS request is aborted by the configured timeout instead of stalling forever", async () => {
  const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
  const store = new GcsStateStore({ bucket: "corvis-control-state.example", fetchImpl, tokenProvider: async () => "t", timeoutMs: 20 });
  // AbortSignal.timeout timers are unref'd; hold the event loop open so the runner does not exit first.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(store.readVersioned("lock"), (error: Error) => error.name === "TimeoutError");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("GCS state uses authenticated generation preconditions", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let mode: "read" | "create-conflict" | "create-ok" = "read";
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (mode === "read") {
      return new Response("state", { status: 200, headers: { "x-goog-generation": "7" } });
    }
    if (mode === "create-conflict") return new Response("", { status: 412 });
    return new Response("", { status: 200, headers: { "x-goog-generation": "8" } });
  };
  const store = new GcsStateStore({
    bucket: "corvis-control-state.example",
    fetchImpl,
    tokenProvider: async () => "test-token",
  });

  assert.deepEqual(await store.readVersioned("lock"), { value: "state", version: "7" });
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer test-token");

  mode = "create-conflict";
  assert.equal(await store.writeIfVersion("lock", "new", null), false);
  assert.equal(new Headers(calls[1]?.init?.headers).get("x-goog-if-generation-match"), "0");

  mode = "create-ok";
  assert.equal(await store.writeIfVersion("lock", "new", "7"), true);
  assert.equal(new Headers(calls[2]?.init?.headers).get("x-goog-if-generation-match"), "7");
});
