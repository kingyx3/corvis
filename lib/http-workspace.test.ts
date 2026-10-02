import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHttpWorkspacePort } from "../adapters/workspace/http-workspace.ts";
import { ApiError, MalformedStreamError, SESSION_EXPIRED_EVENT, UnauthenticatedError, friendlyErrorMessage, SESSION_EXPIRED_MESSAGE } from "./api-errors.ts";
import { latestRequestCorrelationId } from "./request-correlation.ts";

// Lives in lib/ so `npm test` (which globs lib/*.test.ts) runs it without touching package.json.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Recorded = { url: string; init?: RequestInit };
function stubFetch(handler: (call: Recorded, index: number) => Response | Promise<Response>): Recorded[] {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("collection reads follow nextCursor until it is null and send the published cursor contract", async () => {
  const calls = stubFetch((_call, index) => json(index === 0
    ? { data: [{ id: "a" }, { id: "b" }], nextCursor: "c1", correlationId: "x" }
    : index === 1 ? { data: [{ id: "c" }], nextCursor: "c2", correlationId: "x" }
      : { data: [{ id: "d" }], nextCursor: null, correlationId: "x" }));
  const port = createHttpWorkspacePort("https://api.example/");
  const documents = await port.listDocuments();
  assert.deepEqual(documents.map((item) => (item as unknown as { id: string }).id), ["a", "b", "c", "d"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, "https://api.example/api/v1/documents?limit=200");
  assert.equal(calls[1]!.url, "https://api.example/api/v1/documents?limit=200&cursor=c1");
  assert.equal(calls[2]!.url, "https://api.example/api/v1/documents?limit=200&cursor=c2");
  assert.equal(calls[0]!.init?.credentials, "include");
});

test("a repeating cursor is reported as a cycle instead of looping forever", async () => {
  stubFetch(() => json({ data: [], nextCursor: "same", correlationId: "x" }));
  await assert.rejects(createHttpWorkspacePort().listSnapshots(), /pagination_cursor_cycle/);
});

test("single reads unwrap the data envelope", async () => {
  stubFetch(() => json({ data: { subject: "user-1", tenantAdmin: true }, correlationId: "x" }));
  assert.deepEqual(await createHttpWorkspacePort().whoAmI(), { subject: "user-1", tenantAdmin: true });
});

test("401 maps to UnauthenticatedError for single and collection reads", async () => {
  stubFetch(() => json({ error: "authentication_required" }, 401));
  const port = createHttpWorkspacePort();
  await assert.rejects(port.whoAmI(), (error: unknown) => {
    assert.ok(error instanceof UnauthenticatedError);
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "authentication_required");
    return true;
  });
  await assert.rejects(port.listDocuments(), UnauthenticatedError);
  await assert.rejects(port.researchStream("q", () => {}), UnauthenticatedError);
});

test("a 401 tells the shell once per failed request via the session-expired event; other failures do not", async () => {
  const fired: string[] = [];
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: (event: Event) => { fired.push(event.type); return true; } }, configurable: true });
  try {
    stubFetch(() => json({ error: "authentication_required" }, 401));
    await assert.rejects(createHttpWorkspacePort().whoAmI(), UnauthenticatedError);
    assert.deepEqual(fired, [SESSION_EXPIRED_EVENT]);
    stubFetch(() => json({ error: "boom" }, 500));
    await assert.rejects(createHttpWorkspacePort().whoAmI(), ApiError);
    assert.deepEqual(fired, [SESSION_EXPIRED_EVENT]);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("other failures keep code and reasons in the message and expose status", async () => {
  stubFetch(() => json({ error: "validation_failed", reasons: ["a is required", "b is invalid"] }, 422));
  await assert.rejects(createHttpWorkspacePort().workspaceSummary(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.ok(!(error instanceof UnauthenticatedError));
    assert.equal(error.status, 422);
    assert.equal(error.message, "validation_failed: a is required; b is invalid");
    return true;
  });
});

test("403 and 5xx without a JSON body fall back to a status message", async () => {
  stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
  await assert.rejects(createHttpWorkspacePort().capabilities(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.match(error.message, /\(502\)/);
    return true;
  });
});

test("friendlyErrorMessage hides machine codes and explains an expired session", () => {
  assert.equal(friendlyErrorMessage(new UnauthenticatedError(), "fallback"), SESSION_EXPIRED_MESSAGE);
  assert.equal(friendlyErrorMessage(new Error("pagination_cursor_cycle"), "fallback"), "fallback");
  assert.equal(friendlyErrorMessage(new Error("validation_failed: a is required"), "fallback"), "fallback");
  assert.equal(friendlyErrorMessage(new Error("Corvis API request failed (500)"), "fallback"), "Corvis API request failed (500)");
  assert.equal(friendlyErrorMessage("nope", "fallback"), "fallback");
  assert.match(friendlyErrorMessage(new MalformedStreamError(), "fallback"), /unreadable/);
});

// ---- research NDJSON stream -------------------------------------------------------------------

const answer = { answer: "42", citations: [], uncertainty: null };

function ndjsonResponse(chunks: string[], onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
      else controller.close();
    },
    cancel() { onCancel?.(); },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

test("research stream parses events split across chunks and returns the result", async () => {
  const line1 = JSON.stringify({ type: "progress", phase: "planning" });
  const line2 = JSON.stringify({ type: "result", data: answer });
  // Split the second event in the middle of the JSON and keep the trailing newline out of the last chunk.
  stubFetch(() => ndjsonResponse([`${line1}\n${line2.slice(0, 10)}`, `${line2.slice(10)}`]));
  const events: string[] = [];
  const result = await createHttpWorkspacePort().researchStream("q", (event) => events.push(event.type));
  assert.deepEqual(result, answer);
  assert.deepEqual(events, ["progress", "result"]);
});

test("research stream ignores blank lines and posts the question with the ndjson accept header", async () => {
  const calls = stubFetch(() => ndjsonResponse([`\n\n${JSON.stringify({ type: "result", data: answer })}\n\n`]));
  await createHttpWorkspacePort().researchStream("What changed?", () => {});
  assert.equal(calls[0]!.url, "/api/v1/research/stream");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal((calls[0]!.init?.headers as Record<string, string>).accept, "application/x-ndjson");
  assert.equal(calls[0]!.init?.body, JSON.stringify({ question: "What changed?" }));
});

test("a malformed NDJSON line becomes MalformedStreamError (not a raw SyntaxError) and cancels the reader", async () => {
  let cancelled = false;
  stubFetch(() => ndjsonResponse([`${JSON.stringify({ type: "progress", phase: "planning" })}\n{not json\n`, `${JSON.stringify({ type: "result", data: answer })}\n`], () => { cancelled = true; }));
  await assert.rejects(createHttpWorkspacePort().researchStream("q", () => {}), (error: unknown) => {
    assert.ok(error instanceof MalformedStreamError);
    assert.ok(!(error instanceof SyntaxError));
    return true;
  });
  assert.equal(cancelled, true);
});

test("a JSON line that is not an event object is treated as malformed", async () => {
  stubFetch(() => ndjsonResponse(["42\n"]));
  await assert.rejects(createHttpWorkspacePort().researchStream("q", () => {}), MalformedStreamError);
});

test("an error event throws its code and cancels the reader so the server stops streaming", async () => {
  let cancelled = false;
  stubFetch(() => ndjsonResponse([`${JSON.stringify({ type: "error", code: "research_timeout" })}\n`, `${JSON.stringify({ type: "result", data: answer })}\n`], () => { cancelled = true; }));
  const seen: string[] = [];
  await assert.rejects(createHttpWorkspacePort().researchStream("q", (event) => seen.push(event.type)), /research_timeout/);
  assert.deepEqual(seen, ["error"]);
  assert.equal(cancelled, true);
});

test("a stream that ends without a result is an error", async () => {
  stubFetch(() => ndjsonResponse([`${JSON.stringify({ type: "progress", phase: "retrieval" })}\n`]));
  await assert.rejects(createHttpWorkspacePort().researchStream("q", () => {}), /research_stream_ended_without_result/);
});

test("a final line without a trailing newline is still consumed", async () => {
  stubFetch(() => ndjsonResponse([JSON.stringify({ type: "result", data: answer })]));
  assert.deepEqual(await createHttpWorkspacePort().researchStream("q", () => {}), answer);
});

test("the correlation id of the latest successful read is remembered for Contact support", async () => {
  stubFetch(() => json({ data: { subject: "user-1" }, correlationId: "corr-single-1" }));
  await createHttpWorkspacePort().whoAmI();
  assert.equal(latestRequestCorrelationId(), "corr-single-1");
  stubFetch(() => json({ data: [], nextCursor: null, correlationId: "corr-collection-2" }));
  await createHttpWorkspacePort().listDocuments();
  assert.equal(latestRequestCorrelationId(), "corr-collection-2");
});
