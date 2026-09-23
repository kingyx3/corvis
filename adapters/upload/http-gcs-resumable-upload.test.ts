import assert from "node:assert/strict";
import test from "node:test";
import { createHttpGcsResumableUploadPort } from "./http-gcs-resumable-upload.ts";

const KIB = 1024;
const GCS_QUANTUM = 256 * KIB;
const UPLOAD_URL = "https://storage.example/upload-session";

type GcsRequest = { contentRange: string; bodyBytes: number };
type GcsReply = { status: number; range?: string } | "network-error";

/**
 * A minimal in-memory GCS resumable session. `script` can override the reply
 * for the Nth request (0-based) to inject partial commits, missing Range
 * headers or network drops; otherwise it behaves like GCS.
 */
function fakeGcs(totalBytes: number, script: Record<number, (request: GcsRequest, committed: number) => { reply: GcsReply; committed: number }> = {}) {
  let committed = 0;
  const requests: GcsRequest[] = [];
  const reply = (request: GcsRequest): GcsReply => {
    const index = requests.length;
    requests.push(request);
    const override = script[index];
    if (override) {
      const result = override(request, committed);
      committed = result.committed;
      return result.reply;
    }
    const statusCheck = /^bytes \*\/(\d+)$/.exec(request.contentRange);
    if (!statusCheck) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.contentRange);
      assert.ok(match, `unexpected content-range ${request.contentRange}`);
      const start = Number(match[1]);
      assert.equal(start, committed, "every chunk must start exactly at the committed offset");
      assert.equal(Number(match[2]) - start + 1, request.bodyBytes);
      committed = start + request.bodyBytes;
    }
    if (committed >= totalBytes) return { status: 200 };
    return committed > 0 ? { status: 308, range: `bytes=0-${committed - 1}` } : { status: 308 };
  };
  return { requests, reply, committed: () => committed };
}

function installBrowserFakes(gcs: ReturnType<typeof fakeGcs>) {
  const storage = new Map<string, string>();
  const globals = globalThis as Record<string, unknown>;
  const previous = { window: globals.window, XMLHttpRequest: globals.XMLHttpRequest, fetch: globals.fetch };

  globals.window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  };

  class FakeXhr {
    status = 0;
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    onload: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    private headers: Record<string, string> = {};
    private responseRange: string | null = null;
    open(method: string, url: string) {
      assert.equal(method, "PUT");
      assert.equal(url, UPLOAD_URL);
    }
    setRequestHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; }
    getResponseHeader(name: string) { return name.toLowerCase() === "range" ? this.responseRange : null; }
    abort() { this.onabort?.(); this.onloadend?.(); }
    send(body: Blob | null) {
      queueMicrotask(() => {
        const result = gcs.reply({ contentRange: this.headers["content-range"], bodyBytes: body?.size ?? 0 });
        if (result === "network-error") { this.onerror?.(); this.onloadend?.(); return; }
        this.status = result.status;
        this.responseRange = result.range ?? null;
        this.onload?.();
        this.onloadend?.();
      });
    }
  }
  globals.XMLHttpRequest = FakeXhr;

  globals.fetch = async (url: string) => {
    if (String(url).endsWith("/api/v1/uploads/initiate")) {
      return Response.json({ uploadId: "up_1", documentId: "doc_1", chunkSize: GCS_QUANTUM, state: "initiated", uploadUrl: UPLOAD_URL });
    }
    if (String(url).endsWith("/api/v1/uploads/up_1/complete")) {
      return Response.json({ data: { uploadId: "up_1", documentId: "doc_1", state: "complete" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  return () => Object.assign(globals, previous);
}

async function runUpload(totalBytes: number, gcs: ReturnType<typeof fakeGcs>, maxRetries = 4) {
  const restore = installBrowserFakes(gcs);
  try {
    const port = createHttpGcsResumableUploadPort({ apiBase: "https://api.example", maxRetries });
    const file = new File([new Uint8Array(totalBytes)], "fund-report.pdf", { type: "application/pdf", lastModified: 1 });
    return await port.upload(file);
  } finally {
    restore();
  }
}

test("a 308 that commits fewer bytes than were sent resumes from the committed Range, not the end of the chunk", async () => {
  const total = 3 * GCS_QUANTUM;
  const gcs = fakeGcs(total, {
    // Request 1 is the first chunk (request 0 is the initial status query):
    // GCS keeps only half of the first 256 KiB.
    1: (request) => {
      assert.equal(request.contentRange, `bytes 0-${GCS_QUANTUM - 1}/${total}`);
      const kept = GCS_QUANTUM / 2;
      return { reply: { status: 308, range: `bytes=0-${kept - 1}` }, committed: kept };
    },
  });
  assert.deepEqual(await runUpload(total, gcs), { documentId: "doc_1" });
  assert.equal(gcs.committed(), total);
  assert.equal(gcs.requests[2].contentRange, `bytes ${GCS_QUANTUM / 2}-${GCS_QUANTUM * 1.5 - 1}/${total}`, "the next chunk re-sends from the committed offset");
});

test("a 308 without a Range header means nothing was persisted, so the chunk is re-sent from byte 0", async () => {
  const total = 2 * GCS_QUANTUM;
  const gcs = fakeGcs(total, {
    1: () => ({ reply: { status: 308 }, committed: 0 }),
  });
  assert.deepEqual(await runUpload(total, gcs), { documentId: "doc_1" });
  assert.equal(gcs.committed(), total);
  const chunkStarts = gcs.requests.filter((request) => !request.contentRange.startsWith("bytes */")).map((request) => request.contentRange.split(/[ -]/)[1]);
  assert.deepEqual(chunkStarts, ["0", "0", String(GCS_QUANTUM)]);
});

test("a network drop during the retry status check is retried with backoff instead of ending the upload", async () => {
  const total = 2 * GCS_QUANTUM;
  const gcs = fakeGcs(total, {
    1: (_request, committed) => ({ reply: "network-error", committed }), // first chunk drops
    2: (_request, committed) => ({ reply: "network-error", committed }), // the recovery status query drops too
  });
  assert.deepEqual(await runUpload(total, gcs), { documentId: "doc_1" });
  assert.equal(gcs.committed(), total);
});

test("a persistently failing upload still gives up after the retry budget", async () => {
  const total = 2 * GCS_QUANTUM;
  const failing: Record<number, (request: GcsRequest, committed: number) => { reply: GcsReply; committed: number }> = {};
  for (let index = 1; index < 20; index += 1) failing[index] = (_request, committed) => ({ reply: "network-error", committed });
  await assert.rejects(runUpload(total, fakeGcs(total, failing), 2), /Network error/);
});
