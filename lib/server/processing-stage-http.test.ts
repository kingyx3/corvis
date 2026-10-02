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
