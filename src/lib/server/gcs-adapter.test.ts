import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { GcsControlClient } from "./gcs.ts";

// The object store adapter's request shapes and failure handling, against a scripted fetch.

type Seen = { url: string; method: string; headers: Headers; body?: unknown };
type Reply = Response | ((seen: Seen) => Response);

async function withFetch<T>(replies: Reply[], run: (seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body };
    seen.push(entry);
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${entry.method} ${entry.url}`);
    return typeof reply === "function" ? reply(entry) : reply;
  }) as typeof fetch;
  try { return await run(seen); } finally { globalThis.fetch = originalFetch; }
}
const status = (code: number, body?: string, headers: Record<string, string> = {}) => new Response(body ?? null, { status: code, headers });
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } });
const client = () => new GcsControlClient({ bucket: "bkt", accessToken: "static" });

test("without a static token the client asks the workload identity server once, caches the token and fails closed", async () => {
  const metadata = (token: unknown) => json(token);
  await withFetch([metadata({ access_token: "t1", expires_in: 3600 }), status(404), status(404)], async (seen) => {
    const gcs = new GcsControlClient({ bucket: "bkt" });
    assert.equal(await gcs.getObjectMetadata("a"), null);
    assert.equal(await gcs.getObjectMetadata("b"), null);
    assert.match(seen[0]!.url, /metadata\.google\.internal.*service-accounts\/default\/token/);
    assert.equal(seen[0]!.headers.get("metadata-flavor"), "Google");
    assert.equal(seen[1]!.headers.get("authorization"), "Bearer t1");
    assert.equal(seen.length, 3, "the second call reuses the cached token");
  });
  // No expires_in: a default lifetime applies.
  await withFetch([metadata({ access_token: "t2" }), status(404)], async () => { assert.equal(await new GcsControlClient({ bucket: "bkt" }).getObjectMetadata("a"), null); });
  await withFetch([status(500)], async () => { await assert.rejects(new GcsControlClient({ bucket: "bkt" }).getObjectMetadata("a"), /token request failed \(500\)/); });
  await withFetch([metadata({})], async () => { await assert.rejects(new GcsControlClient({ bucket: "bkt" }).getObjectMetadata("a"), /did not return an access token/); });
  // A token about to expire is fetched again.
  await withFetch([metadata({ access_token: "short", expires_in: 1 }), status(404), metadata({ access_token: "fresh", expires_in: 3600 }), status(404)], async (seen) => {
    const gcs = new GcsControlClient({ bucket: "bkt" });
    await gcs.getObjectMetadata("a");
    await gcs.getObjectMetadata("a");
    assert.equal(seen[3]!.headers.get("authorization"), "Bearer fresh");
  });
});

test("a client without a bucket is refused", () => {
  const saved = process.env.CORVIS_OBJECT_STORE_BUCKET;
  delete process.env.CORVIS_OBJECT_STORE_BUCKET;
  try { assert.throws(() => new GcsControlClient({ accessToken: "x" }), /not configured/); } finally { if (saved !== undefined) process.env.CORVIS_OBJECT_STORE_BUCKET = saved; }
});

test("whole-object writes carry their length and type, refuse custom metadata, and surface failures", async () => {
  await withFetch([status(200), status(200)], async (seen) => {
    await client().putObject("k/one.bin", Buffer.from("abc"), "application/octet-stream");
    assert.match(seen[0]!.url, /uploadType=media&name=k%2Fone\.bin/);
    assert.equal(seen[0]!.headers.get("content-type"), "application/octet-stream");
    await client().putJson("k/two.json", { a: 1 });
    assert.equal(seen[1]!.headers.get("content-type"), "application/json");
  });
  await assert.rejects(client().putObject("k", Buffer.from("x"), "text/plain", { a: "b" }), /do not support custom metadata/);
  await withFetch([status(500)], async () => { await assert.rejects(client().putObject("k", Buffer.from("x"), "text/plain"), /object write failed \(500\)/); });
});

test("reads return null for a missing object and throw for any other failure", async () => {
  await withFetch([json({ a: 1 })], async () => { assert.deepEqual(await client().getJson("k"), { a: 1 }); });
  await withFetch([status(404)], async () => { assert.equal(await client().getJson("k"), null); });
  await withFetch([status(503)], async () => { await assert.rejects(client().getJson("k"), /metadata read failed \(503\)/); });
  await withFetch([json({ generation: "5", size: "3" })], async (seen) => {
    assert.deepEqual(await client().getObjectMetadata("k"), { generation: "5", size: "3" });
    assert.match(seen[0]!.url, /fields=generation,size/);
  });
  await withFetch([status(503)], async () => { await assert.rejects(client().getObjectMetadata("k"), /object metadata read failed \(503\)/); });
});

test("an object's SHA-256 is computed from the stream, pinned to a generation when given", async () => {
  await withFetch([status(200, "hello"), status(200, "hello")], async (seen) => {
    const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert.equal(await client().getObjectSha256("k"), expected);
    assert.equal(await client().getObjectSha256("k", "9"), expected);
    assert.doesNotMatch(seen[0]!.url, /generation/);
    assert.match(seen[1]!.url, /alt=media&generation=9/);
  });
  await withFetch([status(404)], async () => { await assert.rejects(client().getObjectSha256("k"), /hash read failed \(404\)/); });
});

test("listing pages through the provider's tokens up to the limit, skipping unnamed items", async () => {
  await withFetch([
    json({ items: [{ name: "a" }, {}, { name: "b" }], nextPageToken: "p2" }),
    json({ items: [{ name: "c" }] }),
  ], async (seen) => {
    assert.deepEqual(await client().listObjects("pre/", 10), ["a", "b", "c"]);
    assert.match(seen[0]!.url, /prefix=pre%2F/);
    assert.match(seen[1]!.url, /pageToken=p2/);
  });
  await withFetch([json({ items: [{ name: "a" }, { name: "b" }, { name: "c" }], nextPageToken: "more" })], async () => { assert.deepEqual(await client().listObjects("p", 2), ["a", "b"]); });
  await withFetch([json({})], async () => { assert.deepEqual(await client().listObjects("p"), []); });
  await withFetch([status(500)], async () => { await assert.rejects(client().listObjects("p"), /listing failed \(500\)/); });
  await withFetch([json({ items: [{ name: "a" }], nextPageToken: "t" }), json({ items: [{ name: "b" }] })], async (seen) => {
    assert.deepEqual(await client().listObjectPage("p", { limit: 5000 }), { names: ["a"], nextPageToken: "t" });
    assert.match(seen[0]!.url, /maxResults=1000/);
    assert.deepEqual(await client().listObjectPage("p", { limit: 0, pageToken: "t" }), { names: ["b"] });
    assert.match(seen[1]!.url, /maxResults=1&pageToken=t/);
  });
  await withFetch([status(500)], async () => { await assert.rejects(client().listObjectPage("p", { limit: 1 }), /listing failed \(500\)/); });
});

test("deleting a missing object is not an error, any other failure is", async () => {
  await withFetch([status(204), status(404)], async () => { await client().deleteObject("k"); await client().deleteObject("k"); });
  await withFetch([status(403)], async () => { await assert.rejects(client().deleteObject("k"), /deletion failed \(403\)/); });
});

test("conditional writes and generation reads report a lost race and refuse malformed input", async () => {
  await assert.rejects(client().putJsonIfGenerationMatch("k", {}, "abc"), /numeric generation/);
  await withFetch([json({ generation: "8" }), status(412), status(500), json({})], async (seen) => {
    assert.deepEqual(await client().putJsonIfGenerationMatch("k", { a: 1 }, "7"), { ok: true, generation: "8" });
    assert.match(seen[0]!.url, /ifGenerationMatch=7/);
    assert.deepEqual(await client().putJsonIfGenerationMatch("k", {}, "7"), { ok: false });
    await assert.rejects(client().putJsonIfGenerationMatch("k", {}, "7"), /conditional write failed \(500\)/);
    await assert.rejects(client().putJsonIfGenerationMatch("k", {}, "7"), /returned no generation/);
  });
  await withFetch([new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "x-goog-generation": "4" } }), status(404), status(500), json({ a: 1 })], async () => {
    assert.deepEqual(await client().getJsonWithGeneration("k"), { value: { a: 1 }, generation: "4" });
    assert.equal(await client().getJsonWithGeneration("k"), null);
    await assert.rejects(client().getJsonWithGeneration("k"), /metadata read failed \(500\)/);
    await assert.rejects(client().getJsonWithGeneration("k"), /returned no generation/);
  });
});

test("resumable sessions: initiation failures are surfaced, and cancelling accepts the statuses GCS uses for a gone session", async () => {
  await withFetch([status(403)], async () => { await assert.rejects(client().createResumableUpload({ key: "k", contentType: "a/b", metadata: {} }), /initiation failed \(403\)/); });
  await withFetch([status(200)], async () => { await assert.rejects(client().createResumableUpload({ key: "k", contentType: "a/b", metadata: {}, origin: "https://app.test" }), /no session URI/); });
  await withFetch([(seen) => { assert.equal(seen.headers.get("origin"), "https://app.test"); return status(200, undefined, { location: "https://s/1" }); }], async () => {
    assert.equal(await client().createResumableUpload({ key: "k", contentType: "a/b", metadata: {}, origin: "https://app.test" }), "https://s/1");
  });
  for (const [code, ok] of [[204, true], [404, true], [500, false]] as const) {
    const server = createServer((_request, response) => { response.statusCode = code; response.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const cancel = client().cancelResumableUpload(`http://127.0.0.1:${port}/session`, httpRequest as unknown as typeof httpsRequest);
      if (ok) await cancel; else await assert.rejects(cancel, /cancellation failed \(500\)/);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("listing a page tolerates a provider answer with no items or with unnamed ones, and a prefix read tolerates a bodiless answer", async () => {
  await withFetch([json({}), json({ items: [{}, { name: "n" }] })], async () => {
    assert.deepEqual(await client().listObjectPage("p", { limit: 5 }), { names: [] });
    assert.deepEqual(await client().listObjectPage("p", { limit: 5 }), { names: ["n"] });
  });
  await withFetch([new Response(null, { status: 206 })], async () => { assert.equal((await client().getObjectPrefix("k", 4)).length, 0); });
});

test("a cancellation answer with no status code counts as status 0", async () => {
  const { deleteWithZeroContentLength } = await import("./gcs.ts");
  const fake = ((_url: URL, _options: unknown, callback: (response: { statusCode?: number; resume(): void }) => void) => ({
    on() { return this; },
    end() { callback({ resume() {} }); },
  })) as unknown as typeof httpsRequest;
  assert.equal(await deleteWithZeroContentLength("https://s/1", fake), 0);
});

/** A body that fails when the consumer cancels it, to exercise the best-effort cleanup paths. */
const cancelFails = (bytes = 1000) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new Uint8Array(bytes)); },
  cancel() { throw new Error("cancel failed"); },
});

test("a failure to release a response body never hides the real outcome", async () => {
  await withFetch([new Response(cancelFails(), { status: 404 }), new Response(cancelFails(), { status: 500 })], async () => {
    assert.equal(await client().getObjectStream("k"), null);
    await assert.rejects(client().getObjectStream("k"), /object read failed \(500\)/);
  });
  await withFetch([new Response(cancelFails(), { status: 200 })], async () => {
    assert.equal((await client().getObjectPrefix("k", 10)).length, 10);
  });
});

test("waiting for response headers is bounded, and a stalled cancellation request is destroyed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as typeof fetch;
  try {
    await assert.rejects(new GcsControlClient({ bucket: "bkt", accessToken: "t", requestTimeoutMs: 5 }).getObjectStream("k"), /aborted/);
  } finally { globalThis.fetch = originalFetch; }

  const { deleteWithZeroContentLength } = await import("./gcs.ts");
  const handlers: Record<string, (value?: unknown) => void> = {};
  let destroyed: Error | undefined;
  const fake = (() => ({
    on(event: string, handler: (value?: unknown) => void) { handlers[event] = handler; return this; },
    destroy(error: Error) { destroyed = error; handlers.error?.(error); },
    end() { handlers.timeout!(); },
  })) as unknown as typeof httpsRequest;
  await assert.rejects(deleteWithZeroContentLength("https://s/1", fake, 1), /timed out/);
  assert.match(destroyed!.message, /timed out/);
});

test("object streams pin a generation, report the type and length, and treat a missing object as null", async () => {
  await withFetch([new Response("data", { status: 200, headers: { "content-type": "application/pdf", "content-length": "4" } }), status(200, "x"), status(404), status(500)], async (seen) => {
    const found = await client().getObjectStream("k", "3");
    assert.match(seen[0]!.url, /alt=media&generation=3/);
    assert.deepEqual([found!.contentType, found!.contentLength], ["application/pdf", "4"]);
    await found!.body.cancel();
    const bare = await client().getObjectStream("k");
    assert.equal(bare!.contentLength, undefined);
    await bare!.body.cancel();
    assert.equal(await client().getObjectStream("k"), null);
    await assert.rejects(client().getObjectStream("k"), /object read failed \(500\)/);
  });
  await withFetch([new Response(null, { status: 200 })], async () => { await assert.rejects(client().getObjectStream("k"), /object read failed \(200\)/); });
});
