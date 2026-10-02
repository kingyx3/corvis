import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHttpDeliveryPort } from "../adapters/delivery/http-delivery.ts";
import { SESSION_EXPIRED_EVENT, UnauthenticatedError } from "./api-errors.ts";
import { latestRequestCorrelationId } from "./request-correlation.ts";

// Lives in lib/ so `npm test` (which globs lib/*.test.ts) runs it.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("identical export requests in flight share one POST and every POST carries an idempotency key", async () => {
  const keys: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    await gate;
    return new Response(JSON.stringify({ data: { exportId: `e${keys.length}` }, correlationId: "c" }), { status: 202, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const port = createHttpDeliveryPort();
  const first = port.createExport("csv");
  const doubleClick = port.createExport("csv");
  const other = port.createExport("xlsx");
  release();
  const [a, b, c] = await Promise.all([first, doubleClick, other]);
  assert.equal(keys.length, 2, "the double-click must not issue a second POST");
  assert.ok(keys.every((key) => /^[0-9a-f-]{36}$/.test(key)));
  assert.notEqual(keys[0], keys[1]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  await port.createExport("csv");
  assert.equal(keys.length, 3, "a later request after completion is a new export");
});

test("a failed export request is not cached", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
      : new Response(JSON.stringify({ data: { exportId: "e" }, correlationId: "c" }), { status: 202 });
  }) as typeof fetch;
  const port = createHttpDeliveryPort();
  await assert.rejects(port.createExport("csv"), /unavailable/);
  assert.deepEqual(await port.createExport("csv"), { exportId: "e" });
});

test("a 401 from any delivery call is an UnauthenticatedError and fires the session-expired event", async () => {
  const fired: string[] = [];
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: (event: Event) => { fired.push(event.type); return true; } }, configurable: true });
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 })) as typeof fetch;
    const port = createHttpDeliveryPort();
    await assert.rejects(port.createExport("csv"), UnauthenticatedError);
    await assert.rejects(port.listExports(), UnauthenticatedError);
    await assert.rejects(port.prepareDownload("e1"), UnauthenticatedError);
    assert.deepEqual(fired, [SESSION_EXPIRED_EVENT, SESSION_EXPIRED_EVENT, SESSION_EXPIRED_EVENT]);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("the correlation id of the latest export response is remembered for Contact support", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [], correlationId: "corr-exports-9" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  await createHttpDeliveryPort().listExports();
  assert.equal(latestRequestCorrelationId(), "corr-exports-9");
});
