import assert from "node:assert/strict";
import test from "node:test";
import { GCS_UPLOAD_CHUNK_BYTES, GcsControlClient } from "./gcs.ts";

// Streamed writes (putObjectStream): a resumable upload whose memory is bounded by one chunk.

const KIB = 1024;
const CHUNK = 256 * KIB;
const SESSION = "https://storage.googleapis.test/upload/session-1";

type Put = { range: string; bytes: Buffer };
type UploadScript = { puts: Put[]; initiation: { headers: Headers } | null; cancelled: string[] };

/** A client whose resumable-upload session is scripted: `answer` decides the response to each PUT. */
async function withUploadServer<T>(answer: (put: Put, index: number) => { status: number; range?: string }, run: (client: GcsControlClient, script: UploadScript) => Promise<T>): Promise<T> {
  const script: UploadScript = { puts: [], initiation: null, cancelled: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      script.initiation = { headers: new Headers(init.headers) };
      return new Response(null, { status: 200, headers: { location: SESSION } });
    }
    assert.equal(String(input), SESSION);
    assert.equal(new Headers(init?.headers).get("authorization"), null, "the session URI is self-authorizing");
    assert.equal(init?.redirect, "manual");
    const put: Put = { range: new Headers(init?.headers).get("content-range")!, bytes: init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0) };
    script.puts.push(put);
    const reply = answer(put, script.puts.length - 1);
    return new Response(null, { status: reply.status, headers: reply.range ? { range: reply.range } : {} });
  }) as typeof fetch;
  class ScriptedClient extends GcsControlClient {
    override async cancelResumableUpload(uploadUrl: string): Promise<void> { script.cancelled.push(uploadUrl); }
  }
  try { return await run(new ScriptedClient({ bucket: "bucket", accessToken: "token" }), script); }
  finally { globalThis.fetch = originalFetch; }
}

async function* pieces(sizes: number[]): AsyncGenerator<Uint8Array> {
  let next = 0;
  for (const size of sizes) { yield new Uint8Array(size).fill(next % 251); next += 1; }
}
const persistedThrough = (put: Put) => Number(/bytes (\d+)-(\d+)/.exec(put.range)![2]);
const normal = (put: Put) => (/\/\d+$/.test(put.range) ? { status: 200 } : { status: 308, range: `bytes=0-${persistedThrough(put)}` });

test("putObjectStream writes in chunk-sized resumable ranges and never holds more than one chunk", async () => {
  const sizes = Array.from({ length: 7 }, () => 100 * KIB);
  await withUploadServer(normal, async (client, script) => {
    const result = await client.putObjectStream("exports/t/x.zip", pieces(sizes), "application/zip", { chunkBytes: CHUNK });
    assert.deepEqual(result, { sizeBytes: 700 * KIB });
    assert.deepEqual(script.puts.map((put) => put.range), [`bytes 0-${CHUNK - 1}/*`, `bytes ${CHUNK}-${2 * CHUNK - 1}/*`, `bytes ${2 * CHUNK}-${700 * KIB - 1}/${700 * KIB}`]);
    for (const put of script.puts) assert.ok(put.bytes.length <= CHUNK, "no request body larger than one chunk");
    const expected = Buffer.concat([...Array(7).keys()].map((index) => Buffer.alloc(100 * KIB, index)));
    assert.ok(Buffer.concat(script.puts.map((put) => put.bytes)).equals(expected), "every byte arrives once, in order");
    assert.equal(script.initiation!.headers.get("x-upload-content-length"), null, "the size is not known when the session starts");
    assert.equal(script.initiation!.headers.get("x-upload-content-type"), "application/zip");
    assert.deepEqual(script.cancelled, []);
  });
});

test("an object that is an exact multiple of the chunk is finalized with an empty range, and an empty object with */0", async () => {
  await withUploadServer(normal, async (client, script) => {
    assert.deepEqual(await client.putObjectStream("k", pieces([2 * CHUNK]), "application/zip", { chunkBytes: CHUNK }), { sizeBytes: 2 * CHUNK });
    assert.deepEqual(script.puts.map((put) => put.range), [`bytes 0-${CHUNK - 1}/*`, `bytes ${CHUNK}-${2 * CHUNK - 1}/*`, `bytes */${2 * CHUNK}`]);
    assert.equal(script.puts.at(-1)!.bytes.length, 0);
  });
  await withUploadServer(normal, async (client, script) => {
    assert.deepEqual(await client.putObjectStream("k", pieces([]), "application/zip"), { sizeBytes: 0 });
    assert.deepEqual(script.puts.map((put) => put.range), ["bytes */0"]);
  });
});

test("a single piece is sliced without re-joining, and the default chunk is 8 MiB", async () => {
  await withUploadServer(normal, async (client, script) => {
    await client.putObjectStream("k", pieces([CHUNK, 10]), "application/zip", { chunkBytes: CHUNK });
    assert.deepEqual(script.puts.map((put) => put.range), [`bytes 0-${CHUNK - 1}/*`, `bytes ${CHUNK}-${CHUNK + 9}/${CHUNK + 10}`]);
  });
  await withUploadServer(normal, async (client, script) => {
    await client.putObjectStream("k", pieces([9 * 1024 * 1024]), "application/zip");
    assert.equal(script.puts[0]!.bytes.length, GCS_UPLOAD_CHUNK_BYTES);
    assert.equal(GCS_UPLOAD_CHUNK_BYTES % CHUNK, 0);
  });
});

test("a chunk the server only partly persisted is resent from where it stopped", async () => {
  await withUploadServer((put, index) => (index === 0 ? { status: 308, range: `bytes=0-${CHUNK / 2 - 1}` } : normal(put)), async (client, script) => {
    await client.putObjectStream("k", pieces([CHUNK + 5]), "application/zip", { chunkBytes: CHUNK });
    assert.deepEqual(script.puts.map((put) => put.range), [`bytes 0-${CHUNK - 1}/*`, `bytes ${CHUNK / 2}-${CHUNK - 1}/*`, `bytes ${CHUNK}-${CHUNK + 4}/${CHUNK + 5}`]);
    assert.equal(script.puts[1]!.bytes.length, CHUNK / 2);
  });
});

test("a stalled, failed or premature answer fails the write and cancels the session", async () => {
  const run = (answer: Parameters<typeof withUploadServer>[0], sizes: number[], message: RegExp) => withUploadServer(answer, async (client, script) => {
    await assert.rejects(client.putObjectStream("k", pieces(sizes), "application/zip", { chunkBytes: CHUNK }), message);
    assert.deepEqual(script.cancelled, [SESSION], "the session is cancelled so no partial object is left");
  });
  await run(() => ({ status: 500 }), [10], /resumable upload failed \(500\)/);
  await run(() => ({ status: 308 }), [CHUNK + 1], /made no progress/);
  await run(() => ({ status: 200 }), [CHUNK + 1], /finished before the last chunk/);
  await run((put) => ({ status: 308, range: `bytes=0-${persistedThrough(put)}` }), [10], /did not finalize/);
  await withUploadServer(normal, async (client, script) => {
    async function* broken(): AsyncGenerator<Uint8Array> { yield new Uint8Array(10); throw new Error("source failed"); }
    await assert.rejects(client.putObjectStream("k", broken(), "application/zip"), /source failed/);
    assert.deepEqual(script.cancelled, [SESSION]);
  });
});

test("the upload chunk must be a positive multiple of 256 KiB, and a session with a declared size still sends it", async () => {
  const client = new GcsControlClient({ bucket: "bucket", accessToken: "token" });
  for (const chunkBytes of [0, -CHUNK, 1000, 1.5 * CHUNK]) {
    await assert.rejects(client.putObjectStream("k", pieces([]), "application/zip", { chunkBytes }), /multiple of 256 KiB/);
  }
  const originalFetch = globalThis.fetch;
  let headers: Headers | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => { headers = new Headers(init?.headers); return new Response(null, { status: 200, headers: { location: SESSION } }); }) as typeof fetch;
  try {
    await client.createResumableUpload({ key: "k", contentType: "application/pdf", sizeBytes: 1234, metadata: {} });
    assert.equal(headers!.get("x-upload-content-length"), "1234");
  } finally { globalThis.fetch = originalFetch; }
});
