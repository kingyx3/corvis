import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { deleteWithZeroContentLength, GCS_REQUEST_TIMEOUT_MS, GcsControlClient } from "./gcs.ts";

test("resumable-session cancellation sends DELETE with Content-Length: 0 and no bearer token", async () => {
  const seen: { method?: string; headers?: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, headers: request.headers });
    response.statusCode = 499;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const status = await deleteWithZeroContentLength(
      `http://127.0.0.1:${port}/upload/storage/v1/b/bucket/o?uploadType=resumable&upload_id=abc`,
      httpRequest as unknown as typeof httpsRequest,
    );
    assert.equal(status, 499);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "DELETE");
    assert.equal(seen[0]?.headers?.["content-length"], "0");
    assert.equal(seen[0]?.headers?.authorization, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("every authorized GCS control-plane call carries a bounded timeout signal", async () => {
  const seen: (AbortSignal | null | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(init?.signal);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const client = new GcsControlClient({ bucket: "corvis-source-test", accessToken: "static-token" });
    assert.equal(await client.getObjectMetadata("tenant=a/object.pdf"), null);
    assert.equal(await client.getJson("tenant=a/session.json"), null);
    await client.deleteObject("tenant=a/object.pdf");
    assert.equal(seen.length, 3);
    for (const signal of seen) assert.ok(signal instanceof AbortSignal, "GCS fetch must not be able to hang indefinitely");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(GCS_REQUEST_TIMEOUT_MS > 0 && GCS_REQUEST_TIMEOUT_MS <= 60_000);
});

test("resumable-session cancellation surfaces transport failures", async () => {
  await assert.rejects(deleteWithZeroContentLength("http://127.0.0.1:1/cancel", httpRequest as unknown as typeof httpsRequest));
});

/** A body that counts how many chunks were pulled and whether the consumer cancelled it. */
function countingBody(chunks: number, chunkBytes: number): { body: ReadableStream<Uint8Array>; stats: { pulled: number; cancelled: boolean } } {
  const stats = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stats.pulled >= chunks) { controller.close(); return; }
      stats.pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x40 + stats.pulled));
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, stats };
}

test("getObjectPrefix caps the read at the requested length when the server ignores Range", async () => {
  const originalFetch = globalThis.fetch;
  const { body, stats } = countingBody(10_000, 1024 * 1024); // a 10 GB object answered with 200
  const ranges: (string | null)[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    ranges.push(new Headers(init?.headers).get("range"));
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  try {
    const client = new GcsControlClient({ bucket: "corvis-source-test", accessToken: "static-token" });
    const prefix = await client.getObjectPrefix("tenant=a/big.pdf", 64);
    assert.deepEqual(prefix, Buffer.alloc(64, 0x41));
    assert.deepEqual(ranges, ["bytes=0-63"]);
    assert.ok(stats.pulled <= 2, `read ${stats.pulled} chunks of a 10000-chunk body`);
    assert.equal(stats.cancelled, true, "the rest of the body is abandoned");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getObjectPrefix joins a prefix split across chunks and returns a short object whole", async () => {
  const originalFetch = globalThis.fetch;
  let body: BodyInit | null = null;
  globalThis.fetch = (async () => new Response(body, { status: 206 })) as typeof fetch;
  const streamOf = (...pieces: string[]) => new ReadableStream<Uint8Array>({
    start(controller) { for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece)); controller.close(); },
  });
  try {
    const client = new GcsControlClient({ bucket: "corvis-source-test", accessToken: "static-token" });
    body = streamOf("%PD", "F-1.", "7 rest of the file");
    assert.equal((await client.getObjectPrefix("tenant=a/doc.pdf", 8)).toString("latin1"), "%PDF-1.7");
    body = streamOf("tiny");
    assert.equal((await client.getObjectPrefix("tenant=a/tiny.csv", 64)).toString("latin1"), "tiny");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getObjectPrefix reads a well-behaved 206 body and still fails on an error status", async () => {
  const originalFetch = globalThis.fetch;
  let status = 206;
  globalThis.fetch = (async () => new Response(status === 206 ? Buffer.from("%PDF-1.7\n") : "nope", { status })) as typeof fetch;
  try {
    const client = new GcsControlClient({ bucket: "corvis-source-test", accessToken: "static-token" });
    assert.equal((await client.getObjectPrefix("tenant=a/doc.pdf", 9)).toString("latin1"), "%PDF-1.7\n");
    status = 404;
    await assert.rejects(client.getObjectPrefix("tenant=a/missing.pdf"), /validation read failed \(404\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
