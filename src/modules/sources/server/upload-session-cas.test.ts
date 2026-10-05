import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { GcsControlClient, type ConditionalPutResult, type GcsObject, type JsonWithGeneration, type ObjectPage, type UploadObjectStore } from "../../../platform/gcp/gcs.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { ProductionUploadSessions, UPLOAD_SESSION_TTL_MS, UploadRequestError, type UploadSession } from "./uploads.ts";

const GENERATION = "1758240000000001";

/** In-memory store with real generation semantics, plus a seam to run code just before a conditional write lands. */
class CasStore implements UploadObjectStore {
  readonly bucket = "corvis-source-test";
  readonly json = new Map<string, { raw: string; generation: number }>();
  readonly objects = new Map<string, { bytes: Buffer; object: GcsObject }>();
  readonly resumable = new Map<string, { key: string; metadata: Record<string, string>; contentType: string }>();
  readonly cancelled: string[] = [];
  readonly deleted: string[] = [];
  private counter = 1;
  beforeConditionalPut?: (key: string, value: unknown) => Promise<void>;

  async createResumableUpload(input: Parameters<UploadObjectStore["createResumableUpload"]>[0]): Promise<string> {
    await Promise.resolve();
    const url = `https://upload.example/resumable/${this.resumable.size + 1}`;
    this.resumable.set(url, { key: input.key, metadata: { ...input.metadata }, contentType: input.contentType });
    return url;
  }
  async cancelResumableUpload(url: string): Promise<void> { this.cancelled.push(url); }
  async putJson(key: string, value: unknown): Promise<void> { this.json.set(key, { raw: JSON.stringify(value), generation: ++this.counter }); }
  async getJson<T>(key: string): Promise<T | null> { const found = this.json.get(key); return found ? JSON.parse(found.raw) as T : null; }
  async getJsonWithGeneration<T>(key: string): Promise<JsonWithGeneration<T> | null> {
    await Promise.resolve();
    const found = this.json.get(key);
    return found ? { value: JSON.parse(found.raw) as T, generation: String(found.generation) } : null;
  }
  async putJsonIfGenerationMatch(key: string, value: unknown, generation: string): Promise<ConditionalPutResult> {
    await Promise.resolve();
    if (this.beforeConditionalPut) { const hook = this.beforeConditionalPut; this.beforeConditionalPut = undefined; await hook(key, value); }
    const found = this.json.get(key);
    if ((found ? String(found.generation) : "0") !== generation) return { ok: false };
    const next = ++this.counter;
    this.json.set(key, { raw: JSON.stringify(value), generation: next });
    return { ok: true, generation: String(next) };
  }
  async getObjectMetadata(key: string): Promise<GcsObject | null> { return this.objects.get(key)?.object ?? null; }
  async getObjectPrefix(key: string, bytes = 32): Promise<Buffer> { return this.objects.get(key)!.bytes.subarray(0, bytes); }
  async getObjectSha256(key: string): Promise<string> { return createHash("sha256").update(this.objects.get(key)!.bytes).digest("hex"); }
  async deleteObject(key: string): Promise<void> { this.deleted.push(key); this.objects.delete(key); }
  async listObjects(prefix: string, limit = 1000): Promise<string[]> { return [...this.json.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit); }
  async listObjectPage(prefix: string, options: { limit: number; pageToken?: string }): Promise<ObjectPage> {
    const all = [...this.json.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = options.pageToken ? Number(options.pageToken) : 0;
    const names = all.slice(start, start + options.limit);
    return start + options.limit < all.length ? { names, nextPageToken: String(start + options.limit) } : { names };
  }

  land(url: string, bytes: Buffer): void {
    const pending = this.resumable.get(url)!;
    this.objects.set(pending.key, { bytes, object: { generation: GENERATION, size: String(bytes.length), contentType: pending.contentType, crc32c: "AAAAAA==", md5Hash: "1B2M2Y8AsgTpgAmY7PhCfg==", metadata: { ...pending.metadata } } });
  }
  scan(key: string, status: string): void {
    const stored = this.objects.get(key)!;
    stored.object = { ...stored.object, metadata: { ...stored.object.metadata, "corvis-malware-status": status } };
  }
}

class Db implements PostgresSqlApi {
  readonly calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  releases = 0;
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    // The guarded purge claim: nothing here has been released, so the claim always wins.
    if (sql.includes("returning 1 as claimed")) return [{ claimed: 1 }];
    if (sql.includes("select malware_scan_status, quarantine_status")) return [{ malware_scan_status: "pending", quarantine_status: "quarantined", sha256: null, size_bytes: 4096 }];
    if (sql.includes("set sha256=lower(coalesce(sha256")) return [{ sha_matches: true }];
    if (sql.includes("release_clean_artifact")) { this.releases += 1; return [{ job_id: "registered:x" }]; }
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health() { return true; }
  documentInserts(): number { return this.calls.filter((call) => call.sql.includes("insert into corvis_source.document\n")).length; }
}

const actor: RequestIdentity = {
  subject: "oidc|uploader-1", tenantId: "00000000-0000-0000-0000-0000000000a1", workspaceId: "00000000-0000-0000-0000-0000000000b1",
  roles: ["analyst"], entitlements: { workspaceIds: ["00000000-0000-0000-0000-0000000000b1"], sourceDocumentAccessAllowed: true },
  authMethod: "oidc", sessionId: "session-1",
};
function input(key = "oidc|uploader-1:key-1") { return { fileName: "report.pdf", contentType: "application/pdf", sizeBytes: 4096, idempotencyKey: key }; }
function pdf(size: number): Buffer { return Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(size - 9, 0x20)]); }
function sessionKey(session: UploadSession): string { return `_corvis/upload-sessions/tenant=${encodeURIComponent(session.tenantId)}/${session.uploadId}.json`; }
function stored(store: CasStore, session: UploadSession): UploadSession { return JSON.parse(store.json.get(sessionKey(session))!.raw) as UploadSession; }

async function quarantinedUpload() {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const session = await uploads.initiate(actor, input());
  store.land(session.resumableUploadUrl!, pdf(4096));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  store.scan(session.objectKey!, "clean");
  return { store, db, uploads, session };
}

test("two concurrent initiates with one idempotency key create exactly one document", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const [a, b] = await Promise.all([uploads.initiate(actor, input()), uploads.initiate(actor, input())]);
  assert.equal(a.uploadId, b.uploadId, "the loser must return the winner's session");
  assert.equal(db.documentInserts(), 1, "one key must not register two documents");
  assert.equal(store.cancelled.length, 1, "the loser's resumable session is cancelled");
  const idempotencyObjects = [...store.json.keys()].filter((key) => key.includes("upload-idempotency"));
  assert.equal(idempotencyObjects.length, 1);
  // A replay after the race is a plain idempotent hit.
  assert.equal((await uploads.initiate(actor, input())).uploadId, a.uploadId);
});

test("an aborted idempotency record is replaced atomically by exactly one new session", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const first = await uploads.initiate(actor, input());
  await uploads.abort(actor, first.uploadId);
  const [a, b] = await Promise.all([uploads.initiate(actor, input()), uploads.initiate(actor, input())]);
  assert.notEqual(a.uploadId, first.uploadId);
  assert.equal(a.uploadId, b.uploadId);
});

test("a rejected idempotency record is replaced atomically by exactly one new session", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const first = await uploads.initiate(actor, input());
  store.land(first.resumableUploadUrl!, Buffer.alloc(4096, 0x41));
  await assert.rejects(uploads.complete(actor, first.uploadId, first.idempotencyKey), (error: unknown) =>
    error instanceof UploadRequestError && error.code === "invalid_file_content");
  const [a, b] = await Promise.all([uploads.initiate(actor, input()), uploads.initiate(actor, input())]);
  assert.notEqual(a.uploadId, first.uploadId);
  assert.equal(a.uploadId, b.uploadId);
  assert.ok(a.resumableUploadUrl);
  assert.equal(stored(store, first).state, "quarantined", "the rejected session is left for the sweep to purge");
});

test("abort racing a release: the abort claims first, so the release stops and nothing is released", async () => {
  const { store, db, uploads, session } = await quarantinedUpload();
  // Just before release's "complete" claim lands, a concurrent abort runs to completion.
  store.beforeConditionalPut = async (key, value) => {
    if ((value as UploadSession).state !== "complete") return;
    store.beforeConditionalPut = undefined;
    await uploads.abort(actor, session.uploadId);
    assert.ok(key.includes(session.uploadId));
  };
  const seen = await uploads.get(actor, session.uploadId);
  assert.equal(seen.state, "aborted", "a poll reports the winner's state instead of failing");
  assert.equal(db.releases, 0, "release_clean_artifact must not run for an aborted session");
  assert.equal(stored(store, session).state, "aborted");
  assert.deepEqual(store.deleted, [session.objectKey]);
});

test("release racing an abort: the release claims first, so the abort refuses and the bytes survive", async () => {
  const { store, db, uploads, session } = await quarantinedUpload();
  // Just before abort's "aborted" claim lands, the scheduled/interactive release completes.
  store.beforeConditionalPut = async (_key, value) => {
    if ((value as UploadSession).state !== "aborted") return;
    await uploads.get(actor, session.uploadId);
  };
  await assert.rejects(uploads.abort(actor, session.uploadId), (error: unknown) =>
    error instanceof UploadRequestError && error.code === "upload_not_active");
  assert.equal(stored(store, session).state, "complete");
  assert.equal(db.releases, 1);
  assert.deepEqual(store.deleted, [], "released evidence must never be purged");
});

test("completion racing an abort never rewrites the document status the abort set", async () => {
  const store = new CasStore();
  // Models the document row's status guard, which the plain fake ignores.
  const db = new (class extends Db {
    documentStatus = "uploading";
    override async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
      await super.execute(sql, parameters);
      if (!/update corvis_source\.document set status/.test(sql)) return;
      const next = /status=\$1/.test(sql) ? String(parameters[0]) : sql.match(/status='([a-z_]+)'/)![1];
      const guard = sql.match(/and status in \(([^)]*)\)/)?.[1].split(",").map((state) => state.trim().replace(/'/g, ""));
      if (!guard || guard.includes(this.documentStatus)) this.documentStatus = next;
    }
  })();
  const uploads = new ProductionUploadSessions(store, db);
  const session = await uploads.initiate(actor, input());
  store.land(session.resumableUploadUrl!, pdf(4096));
  // After complete verified the object but before it writes the document row, a concurrent abort runs to completion.
  const original = db.execute.bind(db);
  db.execute = async (sql, parameters) => {
    if (sql.includes("set storage_generation=")) { db.execute = original; await uploads.abort(actor, session.uploadId); }
    return original(sql, parameters);
  };
  await assert.rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), (error: unknown) =>
    error instanceof UploadRequestError && error.code === "upload_conflict");
  assert.equal(db.documentStatus, "aborted", "complete must not relabel an aborted document as quarantined");
  assert.equal(stored(store, session).state, "aborted");
});

test("a failed release reopens the session so the next poll can retry it", async () => {
  const { store, db, uploads, session } = await quarantinedUpload();
  const original = db.query.bind(db);
  let failOnce = true;
  db.query = async (sql, parameters) => {
    if (sql.includes("release_clean_artifact") && failOnce) { failOnce = false; throw new Error("db down"); }
    return original(sql, parameters);
  };
  await assert.rejects(uploads.get(actor, session.uploadId), /db down/);
  assert.equal(stored(store, session).state, "quarantined");
  assert.equal((await uploads.get(actor, session.uploadId)).state, "complete");
  assert.equal(db.releases, 1);
});

test("a writer that lost a conditional write retries, and gives up with upload_conflict under persistent contention", async () => {
  const { store, uploads, session } = await quarantinedUpload();
  // One concurrent modification: abort's first claim loses, re-reads and wins on the retry.
  store.beforeConditionalPut = async () => { await store.putJson(sessionKey(session), { ...stored(store, session), fileName: "touched.pdf" }); };
  await uploads.abort(actor, session.uploadId);
  assert.equal(stored(store, session).state, "aborted");
  assert.equal(stored(store, session).fileName, "touched.pdf", "the concurrent change is preserved, not overwritten");

  const second = await quarantinedUpload();
  const original = second.store.putJsonIfGenerationMatch!.bind(second.store);
  second.store.putJsonIfGenerationMatch = async (key, value, generation) => {
    await second.store.putJson(sessionKey(second.session), { ...stored(second.store, second.session) });
    return original(key, value, generation);
  };
  await assert.rejects(second.uploads.abort(actor, second.session.uploadId), (error: unknown) =>
    error instanceof UploadRequestError && error.code === "upload_conflict" && error.status === 409);
  assert.deepEqual(second.store.deleted, [], "nothing is purged when the claim never landed");
});

test("sweep pages past the first limit with a cursor and visits every session", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) ids.push((await uploads.initiate(actor, input(`oidc|uploader-1:key-${index}`))).uploadId);
  const visited: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const summary = await uploads.sweep(actor.tenantId, { limit: 2, cursor, abandonedAfterMs: 0, now: new Date(Date.now() + 1000) });
    visited.push(summary.scanned);
    cursor = summary.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.deepEqual(visited, [2, 2, 1]);
  for (const id of ids) {
    const record = JSON.parse(store.json.get(`_corvis/upload-sessions/tenant=${encodeURIComponent(actor.tenantId)}/${id}.json`)!.raw) as UploadSession;
    assert.equal(record.state, "aborted", "every abandoned session is reached, not just the first page");
  }
});

test("GcsControlClient conditional write, generation read and paged listing speak the JSON API", async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method });
    if (url.includes("uploadType=media") && url.includes("ifGenerationMatch=7")) return new Response(null, { status: 412 });
    if (url.includes("uploadType=media")) return new Response(JSON.stringify({ generation: "9" }), { status: 200 });
    if (url.includes("alt=media")) return new Response(JSON.stringify({ hello: "world" }), { status: 200, headers: { "x-goog-generation": "42" } });
    return new Response(JSON.stringify({ items: [{ name: "a" }, { name: "b" }], nextPageToken: "tok" }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new GcsControlClient({ bucket: "b", accessToken: "t" });
    assert.deepEqual(await client.putJsonIfGenerationMatch("k.json", { a: 1 }, "7"), { ok: false });
    assert.deepEqual(await client.putJsonIfGenerationMatch("k.json", { a: 1 }, "0"), { ok: true, generation: "9" });
    assert.ok(seen[1]!.url.includes("ifGenerationMatch=0"), "generation 0 means create-only");
    assert.deepEqual(await client.getJsonWithGeneration("k.json"), { value: { hello: "world" }, generation: "42" });
    const page = await client.listObjectPage("p/", { limit: 2, pageToken: "prev" });
    assert.deepEqual(page, { names: ["a", "b"], nextPageToken: "tok" });
    assert.ok(seen[3]!.url.includes("pageToken=prev"));
    await assert.rejects(client.putJsonIfGenerationMatch("k.json", {}, "not-a-number"), /numeric generation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GcsControlClient streams an object without buffering it and maps 404 to null (#231)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("missing")) return new Response("gone", { status: 404 });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("a,b\r\n")); controller.enqueue(new TextEncoder().encode("1,2\r\n")); controller.close(); } }), { status: 200, headers: { "content-type": "text/csv", "content-length": "10" } });
  }) as typeof fetch;
  try {
    const client = new GcsControlClient({ bucket: "b", accessToken: "t" });
    const object = await client.getObjectStream("exports/x.csv");
    assert.ok(object);
    assert.equal(object.contentType, "text/csv");
    assert.equal(object.contentLength, "10");
    assert.equal(await new Response(object.body).text(), "a,b\r\n1,2\r\n");
    assert.equal(await client.getObjectStream("exports/missing.csv"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a streamed download is not cut off by the header-phase request timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const encoder = new TextEncoder();
    // Like undici, an aborted signal errors the response body as well as the pending request.
    return new Response(new ReadableStream({
      async start(controller) {
        init?.signal?.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch { /* already closed */ } });
        controller.enqueue(encoder.encode("first,"));
        await new Promise((resolve) => setTimeout(resolve, 150));
        try { controller.enqueue(encoder.encode("second")); controller.close(); } catch { /* aborted */ }
      },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new GcsControlClient({ bucket: "b", accessToken: "t", requestTimeoutMs: 40 });
    const object = await client.getObjectStream("exports/slow.csv");
    assert.ok(object);
    assert.equal(await new Response(object.body).text(), "first,second");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function isUploadError(code: string) {
  return (error: unknown) => error instanceof UploadRequestError && error.code === code;
}

/** A store that hands concurrent readers the same parsed session object, as an in-process cache would. */
class SharedObjectStore extends CasStore {
  private readonly shared = new Map<string, { generation: string; value: unknown }>();
  override async getJsonWithGeneration<T>(key: string): Promise<JsonWithGeneration<T> | null> {
    const found = await super.getJsonWithGeneration<T>(key);
    if (!found) return null;
    const hit = this.shared.get(key);
    if (hit?.generation === found.generation) return { value: hit.value as T, generation: found.generation };
    this.shared.set(key, found);
    return found;
  }
}

test("an initiate whose session key is already taken fails with upload_conflict and registers nothing", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  store.beforeConditionalPut = async (key) => { await store.putJson(key, { squatter: true }); };
  await assert.rejects(uploads.initiate(actor, input()), (error: unknown) =>
    isUploadError("upload_conflict")(error) && /already exists/.test((error as Error).message));
  assert.equal(store.cancelled.length, 1, "the resumable session authorized for the lost claim is cancelled");
  assert.equal(db.documentInserts(), 0);
});

test("an unknown session id is reported as not found", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  await assert.rejects(uploads.get(actor, "00000000-0000-4000-8000-00000000dead"), isUploadError("upload_not_found"));
  await assert.rejects(uploads.complete(actor, "00000000-0000-4000-8000-00000000dead", "key"), isUploadError("upload_not_found"));
});

test("a poll that finds the session already released by a concurrent poll does not release it again", async () => {
  const store = new SharedObjectStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const session = await uploads.initiate(actor, input());
  store.land(session.resumableUploadUrl!, pdf(4096));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  store.scan(session.objectKey!, "clean");

  // While the outer poll waits for the object's scan verdict, another poll reads the same session and releases it.
  let inner: UploadSession | undefined;
  const readMetadata = store.getObjectMetadata.bind(store);
  let first = true;
  store.getObjectMetadata = async (key) => {
    if (first) { first = false; inner = await uploads.get(actor, session.uploadId); }
    return readMetadata(key);
  };
  const outer = await uploads.get(actor, session.uploadId);
  assert.equal(inner?.state, "complete");
  assert.equal(outer.state, "complete");
  assert.equal(db.releases, 1, "release_clean_artifact runs once even though two polls saw a clean scan");
});

test("a release whose registry row cannot be sealed leaves the session quarantined for a later poll", async () => {
  const { store, db, uploads, session } = await quarantinedUpload();
  const original = db.query.bind(db);
  let rowMissing = true;
  db.query = async (sql, parameters) => rowMissing && sql.includes("set sha256=lower(coalesce(sha256") ? [] : original(sql, parameters);

  const polled = await uploads.get(actor, session.uploadId);
  assert.equal(polled.state, "quarantined");
  assert.equal(stored(store, session).state, "quarantined");
  assert.equal(db.releases, 0, "an unsealed artifact is never released");

  rowMissing = false;
  assert.equal((await uploads.get(actor, session.uploadId)).state, "complete");
  assert.equal(db.releases, 1);
});

test("a release that creates no processing state reopens the session, and a missing generation is released as null", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const session = await uploads.initiate(actor, input());
  store.land(session.resumableUploadUrl!, pdf(4096));
  store.objects.get(session.objectKey!)!.object.generation = undefined;
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  assert.equal(stored(store, session).storageVersionId, undefined);
  store.scan(session.objectKey!, "clean");

  const original = db.query.bind(db);
  const releaseParameters: PostgresPrimitive[][] = [];
  let createsNothing = true;
  db.query = async (sql, parameters) => {
    if (!sql.includes("release_clean_artifact")) return original(sql, parameters);
    releaseParameters.push(parameters ?? []);
    return createsNothing ? [] : original(sql, parameters);
  };
  await assert.rejects(uploads.get(actor, session.uploadId), /did not create processing state/);
  assert.equal(releaseParameters[0]?.[3], null, "an absent generation is passed to the release as SQL null");
  const reopened = stored(store, session);
  assert.equal(reopened.state, "quarantined");
  assert.equal(reopened.releasedAt, undefined);
  assert.equal(db.releases, 0);

  createsNothing = false;
  assert.equal((await uploads.get(actor, session.uploadId)).state, "complete");
  assert.equal(db.releases, 1);
});

test("when reopening after a failed release also fails, the release error is the one reported", async () => {
  const { store, db, uploads, session } = await quarantinedUpload();
  const original = db.query.bind(db);
  db.query = async (sql, parameters) => {
    if (sql.includes("release_clean_artifact")) throw new Error("db down");
    return original(sql, parameters);
  };
  const put = store.putJsonIfGenerationMatch!.bind(store);
  let reopenAttempts = 0;
  store.putJsonIfGenerationMatch = async (key, value, generation) => {
    if ((value as UploadSession).state === "quarantined") { reopenAttempts += 1; throw new Error("gcs down"); }
    return put(key, value, generation);
  };
  await assert.rejects(uploads.get(actor, session.uploadId), /db down/);
  assert.equal(reopenAttempts, 1);
});

test("a poll that loses its release claim to a vanished session reports a view instead of failing", async () => {
  const { store, db, uploads, session } = await quarantinedUpload();
  store.beforeConditionalPut = async (key) => { store.json.delete(key); };
  const seen = await uploads.get(actor, session.uploadId);
  assert.equal(seen.uploadId, session.uploadId);
  assert.equal(db.releases, 0, "the claim never landed, so nothing was released");
  assert.equal(seen.state, "quarantined", "the view must not claim a completion that never happened");
  assert.equal(seen.releasedAt, undefined);
  assert.equal(seen.malwareScanStatus, "pending");
});

test("a poll that finds the artifact already released but loses the session write does not report a completion either", async () => {
  const { store, db, uploads, session } = await quarantinedUpload();
  const original = db.query.bind(db);
  // The scheduled release already registered the artifact: only the session object is stale.
  db.query = async (sql, parameters) => sql.includes("select malware_scan_status, quarantine_status")
    ? [{ malware_scan_status: "clean", quarantine_status: "released" }]
    : original(sql, parameters);
  store.beforeConditionalPut = async (key) => { store.json.delete(key); };
  const seen = await uploads.get(actor, session.uploadId);
  assert.equal(seen.state, "quarantined", "the unsaved transition is rolled back in memory");
  assert.equal(seen.releasedAt, undefined);
  assert.equal(db.releases, 0);
});

test("a poll of a quarantined session whose object has vanished leaves it quarantined", async () => {
  const { store, db, uploads, session } = await quarantinedUpload();
  store.objects.delete(session.objectKey!);
  const seen = await uploads.get(actor, session.uploadId);
  assert.equal(seen.state, "quarantined");
  assert.equal(stored(store, session).state, "quarantined");
  assert.equal(db.releases, 0);
});

test("an idempotency record whose session has vanished starts a fresh session instead of failing", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const first = await uploads.initiate(actor, input());
  store.json.delete(sessionKey(first));

  const second = await uploads.initiate(actor, input());
  assert.notEqual(second.uploadId, first.uploadId);
  assert.ok(second.resumableUploadUrl);
  assert.equal(store.resumable.size, 2);
  assert.equal(db.documentInserts(), 2);
  assert.equal((await uploads.initiate(actor, input())).uploadId, second.uploadId, "the key now replays the new session");
});

test("an initiate that loses the idempotency claim discards its attempt even when the cleanup fails, then retries", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const cancelAttempts: string[] = [];
  store.cancelResumableUpload = async (url) => { cancelAttempts.push(url); throw new Error("GCS resumable upload cancellation failed (503)"); };
  const put = store.putJsonIfGenerationMatch!.bind(store);
  let rival = true;
  store.putJsonIfGenerationMatch = async (key, value, generation) => {
    // A rival initiate claims the idempotency key (for a session that is gone) just before ours does.
    if (rival && key.includes("upload-idempotency")) { rival = false; await store.putJson(key, { uploadId: "00000000-0000-4000-8000-0000000000aa" }); }
    // Recording the discarded attempt as aborted fails too: both cleanup steps are best effort.
    if ((value as UploadSession).state === "aborted") throw new Error("gcs down");
    return put(key, value, generation);
  };

  const session = await uploads.initiate(actor, input());
  assert.equal(session.state, "initiated");
  assert.equal(cancelAttempts.length, 1, "the lost attempt's resumable session was cancelled");
  assert.notEqual(session.resumableUploadUrl, cancelAttempts[0]);
  assert.equal(db.documentInserts(), 1, "only the winning attempt registers a document");
  assert.equal((await uploads.initiate(actor, input())).uploadId, session.uploadId);
});

test("a failed registration is reported as itself even when cancelling and recording the dead session also fail", async () => {
  const store = new CasStore();
  const db = new (class extends Db {
    override async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
      if (sql.includes("insert into corvis_source.document\n")) throw new Error("postgres unavailable");
      return super.execute(sql, parameters);
    }
  })();
  const uploads = new ProductionUploadSessions(store, db);
  const cancelAttempts: string[] = [];
  store.cancelResumableUpload = async (url) => { cancelAttempts.push(url); throw new Error("GCS resumable upload cancellation failed (503)"); };
  const put = store.putJsonIfGenerationMatch!.bind(store);
  store.putJsonIfGenerationMatch = async (key, value, generation) => {
    if ((value as UploadSession).state === "aborted") throw new Error("gcs down");
    return put(key, value, generation);
  };

  await assert.rejects(uploads.initiate(actor, input()), /postgres unavailable/);
  assert.equal(cancelAttempts.length, 1);
});

async function expiredSession(store: CasStore, uploads: ProductionUploadSessions): Promise<UploadSession> {
  const session = await uploads.initiate(actor, input());
  store.land(session.resumableUploadUrl!, pdf(4096));
  await store.putJson(sessionKey(session), { ...stored(store, session), createdAt: new Date(Date.now() - UPLOAD_SESSION_TTL_MS - 60_000).toISOString() });
  return session;
}

test("expiring a session is best effort: a failed document update or a lost session write never masks upload_expired", async () => {
  const store = new CasStore();
  let documentUpdateFails = true;
  const db = new (class extends Db {
    override async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
      if (documentUpdateFails && sql.includes("set status='aborted'")) throw new Error("postgres unavailable");
      return super.execute(sql, parameters);
    }
  })();
  const uploads = new ProductionUploadSessions(store, db);
  const session = await expiredSession(store, uploads);
  store.beforeConditionalPut = async () => { await store.putJson(sessionKey(session), { ...stored(store, session) }); };

  await assert.rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), isUploadError("upload_expired"));
  assert.deepEqual(store.deleted, [session.objectKey], "the expired bytes are still purged");
  assert.equal(stored(store, session).purgedAt, undefined, "the lost session write leaves the purge record to the sweep");
  documentUpdateFails = false;
  assert.equal((await uploads.sweep(actor.tenantId)).abandoned, 1);
  assert.equal(stored(store, session).state, "aborted");
  assert.ok(stored(store, session).purgedAt);
});

test("expiring a session surfaces an unexpected storage failure while recording the expiry", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const session = await expiredSession(store, uploads);
  store.putJsonIfGenerationMatch = async () => { throw new Error("gcs down"); };
  await assert.rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /gcs down/);
});

test("an abort whose document update fails is still durable and purges the bytes", async () => {
  const store = new CasStore();
  const db = new (class extends Db {
    override async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
      if (sql.includes("set status='aborted'")) throw new Error("postgres unavailable");
      return super.execute(sql, parameters);
    }
  })();
  const uploads = new ProductionUploadSessions(store, db);
  const session = await uploads.initiate(actor, input());
  store.land(session.resumableUploadUrl!, pdf(4096));

  await uploads.abort(actor, session.uploadId);
  const aborted = stored(store, session);
  assert.equal(aborted.state, "aborted");
  assert.ok(aborted.purgedAt);
  assert.deepEqual(store.deleted, [session.objectKey]);
});

test("an abort that loses the purge-record write keeps its durable abort and is finished by the sweep", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const session = await uploads.initiate(actor, input());
  store.land(session.resumableUploadUrl!, pdf(4096));
  const put = store.putJsonIfGenerationMatch!.bind(store);
  let writes = 0;
  store.putJsonIfGenerationMatch = async (key, value, generation) => {
    writes += 1;
    if (writes === 2) await store.putJson(key, { ...stored(store, session) });
    return put(key, value, generation);
  };

  await uploads.abort(actor, session.uploadId);
  assert.equal(writes, 2);
  assert.equal(stored(store, session).state, "aborted");
  assert.equal(stored(store, session).purgedAt, undefined);

  assert.equal((await uploads.sweep(actor.tenantId)).abandoned, 1);
  assert.ok(stored(store, session).purgedAt);
});

test("an abort surfaces an unexpected storage failure while recording the purge", async () => {
  const store = new CasStore(); const db = new Db(); const uploads = new ProductionUploadSessions(store, db);
  const session = await uploads.initiate(actor, input());
  const put = store.putJsonIfGenerationMatch!.bind(store);
  let writes = 0;
  store.putJsonIfGenerationMatch = async (key, value, generation) => {
    writes += 1;
    if (writes === 2) throw new Error("gcs down");
    return put(key, value, generation);
  };
  await assert.rejects(uploads.abort(actor, session.uploadId), /gcs down/);
  assert.equal(stored(store, session).state, "aborted", "the abort itself was already durable");
});
