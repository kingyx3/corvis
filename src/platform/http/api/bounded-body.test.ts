import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedRequestText, RequestBodyTooLargeError } from "./bounded-body.ts";

function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}, onPull?: () => void): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  }, { highWaterMark: 0 }); // pull only when a reader asks, so `onPull` counts real reads
  return new Request("https://example.test/upload", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

const bytes = (text: string) => new TextEncoder().encode(text);

test("a normal body is read in full, including multi-byte characters split across chunks", async () => {
  const encoded = bytes("héllo, wörld ✓");
  const request = streamRequest([encoded.slice(0, 2), encoded.slice(2)]);
  assert.equal(await readBoundedRequestText(request, 1024), "héllo, wörld ✓");
  assert.equal(await readBoundedRequestText(new Request("https://example.test/", { method: "POST", body: "exact" }), 5), "exact");
  assert.equal(await readBoundedRequestText(new Request("https://example.test/", { method: "POST" }), 10), "");
});

test("a declared Content-Length over the limit is rejected without reading the body", async () => {
  let pulls = 0;
  const request = streamRequest([bytes("x".repeat(10))], { "content-length": "2049" }, () => { pulls += 1; });
  await assert.rejects(() => readBoundedRequestText(request, 2048), RequestBodyTooLargeError);
  assert.equal(pulls, 0);
});

test("a chunked body with no Content-Length is cut off at the limit and the stream is cancelled", async () => {
  let pulls = 0;
  const chunk = bytes("x".repeat(1000));
  const request = streamRequest(Array.from({ length: 1000 }, () => chunk), {}, () => { pulls += 1; });
  assert.equal(request.headers.get("content-length"), null);
  await assert.rejects(() => readBoundedRequestText(request, 2048), RequestBodyTooLargeError);
  // Three chunks cross the limit; the reader must not drain the other ~1000.
  assert.ok(pulls < 20, `read ${pulls} chunks`);
});

test("a Content-Length that understates the body still cannot exceed the limit", async () => {
  const request = streamRequest([bytes("x".repeat(3000))], { "content-length": "10" });
  await assert.rejects(() => readBoundedRequestText(request, 2048), RequestBodyTooLargeError);
});

test("the limit counts bytes, not characters", async () => {
  const request = streamRequest([bytes("é".repeat(1100))]);
  await assert.rejects(() => readBoundedRequestText(request, 2048), RequestBodyTooLargeError);
  assert.equal((await readBoundedRequestText(streamRequest([bytes("é".repeat(1024))]), 2048)).length, 1024);
});
