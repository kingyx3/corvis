import assert from "node:assert/strict";
import test from "node:test";
import { HttpDocumentRepresentationProducer } from "./processing-represented-stage.ts";
import { HttpExtractionProvider } from "./processing-extracted-stage.ts";
import {
  boundedFetch,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  EXTRACTION_STAGE_EXECUTION_BUDGET_MS,
  MAX_PROVIDER_TIMEOUT_MS,
  METADATA_TIMEOUT_MS,
  STAGE_EXECUTION_BUDGET_MS,
  STAGE_ROUTER_TIMEOUT_MS,
  withStageBudget,
} from "./processing-stage-http.ts";

function stalledBodyResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start() { /* never enqueues, never closes */ } });
  return new Response(body, { status: 200 });
}

test("short stages and long extraction keep nested execution bounds", () => {
  assert.ok(STAGE_EXECUTION_BUDGET_MS < STAGE_ROUTER_TIMEOUT_MS);
  assert.ok(METADATA_TIMEOUT_MS + DEFAULT_PROVIDER_TIMEOUT_MS < STAGE_EXECUTION_BUDGET_MS);
  assert.ok(METADATA_TIMEOUT_MS + MAX_PROVIDER_TIMEOUT_MS < EXTRACTION_STAGE_EXECUTION_BUDGET_MS);
});

test("boundedFetch keeps its timeout armed while the response body is read", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    boundedFetch(async () => stalledBodyResponse(), "https://provider.example", {}, new AbortController().signal, 40, "provider", (res) => res.text()),
    /provider timed out/,
  );
  assert.ok(Date.now() - startedAt < 2_000);
});

test("boundedFetch rejects a fetch that ignores the abort signal and honours parent aborts mid-body", async () => {
  await assert.rejects(
    boundedFetch(() => new Promise<Response>(() => undefined), "https://provider.example", {}, new AbortController().signal, 30, "hung", async () => ""),
    /hung timed out/,
  );
  const parent = new AbortController();
  const pending = boundedFetch(async () => stalledBodyResponse(), "https://provider.example", {}, parent.signal, 60_000, "p", (res) => res.text());
  setTimeout(() => parent.abort(new Error("router abort")), 20);
  await assert.rejects(pending, /router abort/);
});

test("boundedFetch returns the body when the provider answers in time", async () => {
  const { response, value } = await boundedFetch(async () => new Response("hello"), "https://provider.example", {}, new AbortController().signal, 1_000, "ok", (res) => res.text());
  assert.equal(response.status, 200);
  assert.equal(value, "hello");
});

test("representation and extraction providers time out on a stalled response body", async () => {
  const fakeFetch: typeof fetch = async (input) => String(input).startsWith("http://metadata.google.internal/")
    ? new Response("oidc-token")
    : stalledBodyResponse();
  const producer = new HttpDocumentRepresentationProducer({ endpoint: "https://r.example", audience: "https://r.example", timeoutMs: 40 }, fakeFetch);
  await assert.rejects(
    producer.produce({ signal: new AbortController().signal, idempotencyKey: "k" } as Parameters<typeof producer.produce>[0]),
    /document representation provider timed out/,
  );
  const provider = new HttpExtractionProvider({ endpoint: "https://e.example", audience: "https://e.example", timeoutMs: 40 }, fakeFetch);
  await assert.rejects(
    provider.extract({ signal: new AbortController().signal, idempotencyKey: "k" } as Parameters<typeof provider.extract>[0]),
    /extraction provider timed out/,
  );
});

test("withStageBudget aborts the handler signal when the budget is spent and releases the timer", async () => {
  let observed: AbortSignal | undefined;
  const handler = withStageBudget(async (_effect, signal) => {
    observed = signal;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw signal.reason;
  }, 30);
  await assert.rejects(handler({ stage: "represented" } as never, new AbortController().signal), /execution budget timed out/);
  assert.equal(observed?.aborted, true);

  const parent = new AbortController();
  const fast = withStageBudget(async () => ({ ok: true }), 60_000);
  assert.deepEqual(await fast({ stage: "represented" } as never, parent.signal), { ok: true });
});

test("boundedFetch rejects with a generic error when the parent was already aborted with a non-Error reason", async () => {
  const parent = new AbortController();
  parent.abort("router gave up");
  let fetchCalls = 0;
  await assert.rejects(
    boundedFetch(() => { fetchCalls += 1; return new Promise<Response>(() => undefined); }, "https://provider.example", {}, parent.signal, 60_000, "pre-aborted", async () => ""),
    { message: "operation aborted" },
  );
  assert.equal(fetchCalls, 1);

  const errorParent = new AbortController();
  errorParent.abort(new Error("router abort before start"));
  await assert.rejects(
    boundedFetch(() => new Promise<Response>(() => undefined), "https://provider.example", {}, errorParent.signal, 60_000, "pre-aborted", async () => ""),
    { message: "router abort before start" },
  );
});

test("boundedFetch cancels an unread response body and tolerates cancel failures", async () => {
  const signal = new AbortController().signal;

  let cancelled = 0;
  const cancellable = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } }));
  await boundedFetch(async () => cancellable, "https://provider.example", {}, signal, 1_000, "unread", async () => "ignored");
  assert.equal(cancelled, 1);

  // An asynchronously rejecting cancel() must not surface to the caller.
  let rejectingCancels = 0;
  const rejecting = new Response(new ReadableStream<Uint8Array>({
    cancel() { rejectingCancels += 1; return Promise.reject(new Error("cancel failed")); },
  }));
  const { value } = await boundedFetch(async () => rejecting, "https://provider.example", {}, signal, 1_000, "rejecting", async () => "still ok");
  assert.equal(value, "still ok");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejectingCancels, 1);

  // A synchronously throwing cancel() must not surface either.
  let throwingCancels = 0;
  const throwing = {
    ok: true,
    bodyUsed: false,
    body: { locked: false, cancel() { throwingCancels += 1; throw new Error("already closed"); } },
  } as unknown as Response;
  const result = await boundedFetch(async () => throwing, "https://provider.example", {}, signal, 1_000, "throwing", async () => 7);
  assert.equal(result.value, 7);
  assert.equal(throwingCancels, 1);
});

test("boundedFetch leaves consumed, locked, absent and missing response bodies alone", async () => {
  const signal = new AbortController().signal;

  const consumed = await boundedFetch(async () => new Response("body"), "https://provider.example", {}, signal, 1_000, "consumed", (res) => res.text());
  assert.equal(consumed.value, "body");
  assert.equal(consumed.response.bodyUsed, true);

  let lockedCancels = 0;
  const lockedResponse = new Response(new ReadableStream<Uint8Array>({ cancel() { lockedCancels += 1; } }));
  const reader = lockedResponse.body!.getReader();
  const locked = await boundedFetch(async () => lockedResponse, "https://provider.example", {}, signal, 1_000, "locked", async () => "held");
  assert.equal(locked.value, "held");
  assert.equal(locked.response.body?.locked, true);
  assert.equal(lockedCancels, 0);
  reader.releaseLock();

  const empty = await boundedFetch(async () => new Response(null, { status: 204 }), "https://provider.example", {}, signal, 1_000, "empty", async () => "none");
  assert.equal(empty.response.body, null);
  assert.equal(empty.value, "none");

  await assert.rejects(
    boundedFetch(async () => { throw new Error("network down"); }, "https://provider.example", {}, signal, 1_000, "no response", async () => ""),
    /network down/,
  );
});
