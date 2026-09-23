import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { GcsObject, UploadObjectStore } from "./gcs.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { ProductionUploadSessions, QUARANTINE_RETENTION_MS, UPLOAD_SESSION_TTL_MS, UploadRequestError, type UploadSession } from "./uploads.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };
type FakeObject = { bytes: Buffer; object: GcsObject };
type Pending = { key: string; contentType: string; sizeBytes: number; metadata: Record<string, string> };

const CLEAN_GENERATION = "1758240000000001";
const CLEAN_CRC32C = "AAAAAA==";
const CLEAN_MD5 = "1B2M2Y8AsgTpgAmY7PhCfg==";

class FakeObjectStore implements UploadObjectStore {
  readonly bucket = "corvis-source-test";
  readonly json = new Map<string, string>();
  readonly objects = new Map<string, FakeObject>();
  readonly resumable = new Map<string, Pending>();
  readonly cancelled: string[] = [];
  readonly deleted: string[] = [];
  listCalls = 0;

  async createResumableUpload(input: Parameters<UploadObjectStore["createResumableUpload"]>[0]): Promise<string> {
    const url = `https://upload.example/resumable/${this.resumable.size + 1}`;
    this.resumable.set(url, { key: input.key, contentType: input.contentType, sizeBytes: input.sizeBytes, metadata: { ...input.metadata } });
    return url;
  }
  async cancelResumableUpload(uploadUrl: string): Promise<void> { this.cancelled.push(uploadUrl); }
  async putJson(key: string, value: unknown): Promise<void> { this.json.set(key, JSON.stringify(value)); }
  async getJson<T>(key: string): Promise<T | null> {
    const raw = this.json.get(key);
    return raw ? JSON.parse(raw) as T : null;
  }
  async getObjectMetadata(key: string): Promise<GcsObject | null> { return this.objects.get(key)?.object ?? null; }
  async getObjectPrefix(key: string, bytes = 32): Promise<Buffer> {
    const stored = this.objects.get(key);
    if (!stored) throw new Error("GCS object validation read failed (404)");
    return stored.bytes.subarray(0, bytes);
  }
  async deleteObject(key: string): Promise<void> { this.deleted.push(key); this.objects.delete(key); }
  async listObjects(prefix: string, limit = 1000): Promise<string[]> {
    this.listCalls += 1;
    return [...this.json.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit);
  }

  /** Test seam for the direct browser-to-GCS transfer landing an object. */
  finalize(uploadUrl: string, bytes: Buffer, overrides: Partial<GcsObject> = {}): void {
    const pending = this.resumable.get(uploadUrl);
    assert.ok(pending, "resumable session was never authorized");
    const { metadata, ...rest } = overrides;
    this.objects.set(pending.key, {
      bytes,
      object: {
        generation: CLEAN_GENERATION,
        size: String(bytes.length),
        contentType: pending.contentType,
        crc32c: CLEAN_CRC32C,
        md5Hash: CLEAN_MD5,
        metadata: { ...pending.metadata, ...(metadata ?? {}) },
        ...rest,
      },
    });
  }

  mutate(key: string, patch: Partial<GcsObject>): void {
    const stored = this.objects.get(key);
    assert.ok(stored, "object is not present");
    const { metadata, ...rest } = patch;
    stored.object = { ...stored.object, ...rest, metadata: { ...stored.object.metadata, ...(metadata ?? {}) } };
  }

  scan(key: string, status: string): void { this.mutate(key, { metadata: { "corvis-malware-status": status } }); }
}

class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  readonly releases: PostgresPrimitive[][] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("release_clean_artifact")) {
      this.releases.push(parameters);
      return [{ job_id: `registered:${String(parameters[1])}` }];
    }
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }

  documentStatuses(): string[] {
    return this.calls
      .filter((call) => /update corvis_source\.document set status/.test(call.sql))
      .map((call) => /status=\$1/.test(call.sql) ? String(call.parameters[0]) : call.sql.match(/status='([a-z_]+)'/)?.[1] ?? "");
  }
  artifactStatuses(): string[] {
    return this.calls
      .filter((call) => call.sql.includes("corvis_source.document_artifact_version") && call.sql.startsWith("update"))
      .map((call) => call.sql.match(/(?:malware_scan_status|quarantine_status)='([a-z_]+)'/)?.[1] ?? String(call.parameters[1] ?? ""));
  }
}

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "oidc|uploader-1",
    tenantId: "00000000-0000-0000-0000-0000000000a1",
    workspaceId: "00000000-0000-0000-0000-0000000000b1",
    roles: ["analyst"],
    entitlements: { workspaceIds: ["00000000-0000-0000-0000-0000000000b1"], sourceDocumentAccessAllowed: true },
    authMethod: "oidc",
    sessionId: "session-1",
    ...overrides,
  };
}

function pdfBytes(size: number): Buffer {
  const header = Buffer.from("%PDF-1.7\n", "ascii");
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), 0x20)]);
}

function initiateInput(overrides: Partial<Parameters<ProductionUploadSessions["initiate"]>[1]> = {}) {
  return {
    fileName: "quarterly-report.pdf",
    contentType: "application/pdf",
    sizeBytes: 4096,
    idempotencyKey: "oidc|uploader-1:key-1",
    ...overrides,
  };
}

function sessionStorageKey(session: UploadSession): string {
  return `_corvis/upload-sessions/tenant=${encodeURIComponent(session.tenantId)}/${session.uploadId}.json`;
}

function backdate(store: FakeObjectStore, session: UploadSession, ms: number): void {
  const key = sessionStorageKey(session);
  const stored = JSON.parse(store.json.get(key) ?? "null") as UploadSession | null;
  assert.ok(stored, "session was never persisted");
  stored.createdAt = new Date(Date.now() - ms).toISOString();
  store.json.set(key, JSON.stringify(stored));
}

function storedSession(store: FakeObjectStore, session: UploadSession): UploadSession {
  return JSON.parse(store.json.get(sessionStorageKey(session)) ?? "null") as UploadSession;
}

function harness() {
  const store = new FakeObjectStore();
  const db = new FakeDb();
  return { store, db, uploads: new ProductionUploadSessions(store, db) };
}

async function acceptedUpload(overrides: Partial<Parameters<ProductionUploadSessions["initiate"]>[1]> = {}) {
  const context = harness();
  const actor = identity();
  const session = await context.uploads.initiate(actor, initiateInput(overrides));
  context.store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await context.uploads.complete(actor, session.uploadId, session.idempotencyKey);
  context.store.scan(session.objectKey ?? "", "clean");
  const released = await context.uploads.get(actor, session.uploadId);
  return { ...context, actor, session, released };
}

async function rejects(operation: Promise<unknown>, expected: RegExp): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.match(String((error as Error).message), expected);
    return true;
  });
}

test("a clean upload registers once and carries object generation into registration", async () => {
  const { db, store, session, released } = await acceptedUpload({ checksumSha256: "a".repeat(64) });
  assert.equal(released.state, "complete");
  assert.equal(db.releases.length, 1);
  assert.equal(db.releases[0]?.[2], session.artifactVersionId);
  assert.equal(db.releases[0]?.[3], CLEAN_GENERATION, "storage generation must reach release_clean_artifact");
  assert.equal(db.releases[0]?.[4], session.ingestionId);
  assert.equal(released.storageVersionId, CLEAN_GENERATION);
  assert.equal(released.storageChecksumCrc32c, CLEAN_CRC32C);
  assert.equal(released.storageChecksumMd5, CLEAN_MD5);
  assert.equal(storedSession(store, session).storageVersionId, CLEAN_GENERATION);
  assert.equal(store.resumable.get(session.resumableUploadUrl ?? "")?.metadata.sha256, "a".repeat(64));
});

test("a duplicate completion never registers the document twice", async () => {
  const { uploads, db, actor, session } = await acceptedUpload();
  const repeat = await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  assert.equal(repeat.state, "complete");
  assert.equal(db.releases.length, 1);
});

test("a duplicate initiate reuses the authorized session and registers one document", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const first = await uploads.initiate(actor, initiateInput());
  const second = await uploads.initiate(actor, initiateInput());
  assert.equal(second.uploadId, first.uploadId);
  assert.equal(store.resumable.size, 1);
  assert.equal(db.calls.filter((call) => call.sql.includes("insert into corvis_source.document\n")).length, 1);
  assert.equal(db.releases.length, 0);
});

test("an object larger than the authorized size cannot be registered", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes + 1024));
  await rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /size does not match/);
  assert.equal(db.releases.length, 0);
  assert.equal(storedSession(store, session).state, "initiated");
});

test("an unfinalized resumable session cannot be registered", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  await rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /has not completed/);
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(1024));
  await rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /size does not match/);
  assert.equal(db.releases.length, 0);
});

test("an object whose bound lineage metadata does not match the session cannot be registered", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput({ checksumSha256: "b".repeat(64) }));
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes), { metadata: { sha256: "c".repeat(64) } });
  await rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /lineage does not match/);
  assert.equal(db.releases.length, 0);

  store.mutate(session.objectKey ?? "", { metadata: { sha256: "b".repeat(64), artifact: "00000000-0000-0000-0000-00000000dead" } });
  await rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /lineage does not match/);
  assert.equal(db.releases.length, 0);
});

test("an object replaced after verification is never released on a clean scan", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);

  store.mutate(session.objectKey ?? "", { generation: "1758240000009999" });
  store.scan(session.objectKey ?? "", "clean");
  await rejects(uploads.get(actor, session.uploadId), /generation changed after verification/);
  assert.equal(db.releases.length, 0);
  assert.ok(db.artifactStatuses().includes("integrity_failed"));
  assert.equal(storedSession(store, session).state, "quarantined");
});

test("an object whose storage checksum changes after verification is never released", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);

  store.mutate(session.objectKey ?? "", { crc32c: "ZZZZZZ==" });
  store.scan(session.objectKey ?? "", "clean");
  await rejects(uploads.get(actor, session.uploadId), /checksum changed after verification/);
  assert.equal(db.releases.length, 0);
});

test("an invalid file signature is rejected and stays unreleasable even if a scanner reports clean", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", Buffer.alloc(session.sizeBytes, 0x41));
  await rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /content does not match the permitted document type/);
  assert.equal(db.releases.length, 0);
  assert.ok(db.documentStatuses().includes("rejected"));

  store.scan(session.objectKey ?? "", "clean");
  const current = await uploads.get(actor, session.uploadId);
  assert.equal(current.state, "quarantined");
  assert.equal(db.releases.length, 0);
});

test("a malware disposition keeps the artifact quarantined and out of canonical processing", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  store.scan(session.objectKey ?? "", "threat");

  const scanned = await uploads.get(actor, session.uploadId);
  assert.equal(scanned.state, "quarantined");
  assert.equal(scanned.malwareScanStatus, "threat");
  assert.equal(db.releases.length, 0);

  assert.equal((await uploads.complete(actor, session.uploadId, session.idempotencyKey)).state, "quarantined");
  assert.equal(db.releases.length, 0);
  assert.ok(db.documentStatuses().includes("quarantined"));
});

test("an expired session cannot be completed and its bytes are purged", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  backdate(store, session, UPLOAD_SESSION_TTL_MS + 60_000);

  await rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /has expired/);
  assert.equal(db.releases.length, 0);
  const expired = storedSession(store, session);
  assert.equal(expired.state, "aborted");
  assert.ok(expired.purgedAt);
  assert.deepEqual(store.deleted, [session.objectKey]);
  assert.deepEqual(store.cancelled, [session.resumableUploadUrl]);
});

test("an aborted session cannot be revived into a registered document", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  await uploads.abort(actor, session.uploadId);
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await rejects(uploads.complete(actor, session.uploadId, session.idempotencyKey), /no longer active/);
  assert.equal(db.releases.length, 0);
});

test("another uploader in the same tenant cannot complete or abort the session", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  const other = identity({ subject: "oidc|uploader-2", sessionId: "session-2" });

  await rejects(uploads.complete(other, session.uploadId, session.idempotencyKey), /Upload not found/);
  await rejects(uploads.abort(other, session.uploadId), /Upload not found/);
  assert.equal(db.releases.length, 0);
  assert.equal(storedSession(store, session).state, "initiated");
});

test("another tenant cannot read, complete or abort the session", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  const intruder = identity({ tenantId: "00000000-0000-0000-0000-0000000000a2", subject: "oidc|uploader-1" });

  await rejects(uploads.get(intruder, session.uploadId), /Upload not found/);
  await rejects(uploads.complete(intruder, session.uploadId, session.idempotencyKey), /Upload not found/);
  await rejects(uploads.abort(intruder, session.uploadId), /Upload not found/);
  assert.equal(db.releases.length, 0);
});

test("a mismatched completion idempotency key cannot register the document", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await rejects(uploads.complete(actor, session.uploadId, "oidc|uploader-1:other-key"), /idempotency key does not match/);
  assert.equal(db.releases.length, 0);
});

test("lifecycle sweep purges abandoned sessions and quarantined threats but retains accepted evidence", async () => {
  const store = new FakeObjectStore();
  const db = new FakeDb();
  const uploads = new ProductionUploadSessions(store, db);
  const actor = identity();

  const accepted = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:accepted" }));
  store.finalize(accepted.resumableUploadUrl ?? "", pdfBytes(accepted.sizeBytes));
  await uploads.complete(actor, accepted.uploadId, accepted.idempotencyKey);
  store.scan(accepted.objectKey ?? "", "clean");
  await uploads.get(actor, accepted.uploadId);

  const infected = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:infected" }));
  store.finalize(infected.resumableUploadUrl ?? "", pdfBytes(infected.sizeBytes));
  await uploads.complete(actor, infected.uploadId, infected.idempotencyKey);
  store.scan(infected.objectKey ?? "", "threat");
  await uploads.get(actor, infected.uploadId);

  const abandoned = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:abandoned" }));
  backdate(store, abandoned, UPLOAD_SESSION_TTL_MS + 60_000);

  const pending = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:pending" }));
  store.finalize(pending.resumableUploadUrl ?? "", pdfBytes(pending.sizeBytes));
  await uploads.complete(actor, pending.uploadId, pending.idempotencyKey);

  const fresh = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:fresh" }));

  const releasesBefore = db.releases.length;
  const first = await uploads.sweep(actor.tenantId);
  assert.equal(first.scanned, 5);
  assert.equal(first.retained, 1);
  assert.equal(first.abandoned, 1);
  assert.equal(first.quarantinePurged, 1);
  assert.equal(first.skipped, 2);

  assert.equal(store.deleted.includes(accepted.objectKey ?? ""), false, "accepted source evidence must be retained");
  assert.equal(store.cancelled.includes(accepted.resumableUploadUrl ?? ""), false);
  assert.ok(store.objects.has(accepted.objectKey ?? ""));
  assert.equal(storedSession(store, accepted).state, "complete");
  assert.ok(store.deleted.includes(infected.objectKey ?? ""));
  assert.ok(store.deleted.includes(abandoned.objectKey ?? ""));
  assert.equal(store.deleted.includes(pending.objectKey ?? ""), false, "a pending scan is not purged before retention expires");
  assert.equal(store.deleted.includes(fresh.objectKey ?? ""), false);
  assert.equal(storedSession(store, abandoned).state, "aborted");
  assert.equal(storedSession(store, infected).state, "quarantined", "quarantine evidence rows survive byte purge");
  assert.ok(storedSession(store, infected).purgedAt);
  assert.equal(db.releases.length, releasesBefore, "cleanup never registers a document");

  const deletedAfterFirst = [...store.deleted];
  const second = await uploads.sweep(actor.tenantId);
  assert.deepEqual(store.deleted, deletedAfterFirst, "sweep is idempotent");
  assert.equal(second.abandoned, 0);
  assert.equal(second.quarantinePurged, 0);
  assert.equal(second.retained, 1);
  assert.equal(second.skipped, 4);
});

test("lifecycle sweep purges quarantined bytes once retention expires and stays bounded", async () => {
  const store = new FakeObjectStore();
  const db = new FakeDb();
  const uploads = new ProductionUploadSessions(store, db);
  const actor = identity();

  const stale = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:stale" }));
  store.finalize(stale.resumableUploadUrl ?? "", pdfBytes(stale.sizeBytes));
  await uploads.complete(actor, stale.uploadId, stale.idempotencyKey);
  backdate(store, stale, QUARANTINE_RETENTION_MS + 60_000);

  const other = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:other" }));
  backdate(store, other, UPLOAD_SESSION_TTL_MS + 60_000);

  const bounded = await uploads.sweep(actor.tenantId, { limit: 1 });
  assert.equal(bounded.scanned, 1, "sweep processes at most the requested number of sessions");

  const rest = await uploads.sweep(actor.tenantId);
  assert.equal(bounded.quarantinePurged + rest.quarantinePurged, 1);
  assert.equal(bounded.abandoned + rest.abandoned, 1);
  assert.ok(store.deleted.includes(stale.objectKey ?? ""));
  assert.equal(db.releases.length, 0);
  assert.ok(db.calls.some((call) => call.sql.includes("quarantine_status='purged'")));
});

test("a sweep never touches another tenant's sessions", async () => {
  const store = new FakeObjectStore();
  const db = new FakeDb();
  const uploads = new ProductionUploadSessions(store, db);
  const actor = identity();
  const neighbour = identity({ tenantId: "00000000-0000-0000-0000-0000000000a2", subject: "oidc|uploader-9" });

  const mine = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:mine" }));
  backdate(store, mine, UPLOAD_SESSION_TTL_MS + 60_000);
  const theirs = await uploads.initiate(neighbour, initiateInput({ idempotencyKey: "oidc|uploader-9:theirs" }));
  backdate(store, theirs, UPLOAD_SESSION_TTL_MS + 60_000);

  const summary = await uploads.sweep(actor.tenantId);
  assert.equal(summary.scanned, 1);
  assert.deepEqual(store.deleted, [mine.objectKey]);
  assert.equal(storedSession(store, theirs).state, "initiated");
});

async function rejectsWith(operation: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof UploadRequestError, `expected UploadRequestError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("client-attributable upload failures are typed 4xx errors instead of generic 500s", { concurrency: false }, async () => {
  const previous = process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS;
  process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS = "https://app.corvis.example";
  try {
    const { uploads, store } = harness();
    const actor = identity();
    await rejectsWith(uploads.initiate(actor, initiateInput({ fileName: "payload.exe" })), "unsupported_file_type", 415);
    await rejectsWith(uploads.initiate(actor, initiateInput({ contentType: "application/x-msdownload" })), "unsupported_media_type", 415);
    await rejectsWith(uploads.initiate(actor, initiateInput({ sizeBytes: 0 })), "invalid_file_size", 400);
    await rejectsWith(uploads.initiate(actor, initiateInput({ sizeBytes: Number.NaN })), "invalid_file_size", 400);
    await rejectsWith(uploads.initiate(actor, initiateInput({ origin: "https://attacker.example" })), "upload_origin_not_allowed", 403);
    assert.equal(store.resumable.size, 0, "no resumable session is authorized for a rejected request");

    await rejectsWith(uploads.get(actor, "00000000-0000-0000-0000-00000000dead"), "upload_not_found", 404);
    const session = await uploads.initiate(actor, initiateInput({ origin: "https://app.corvis.example" }));
    await rejectsWith(uploads.complete(identity({ subject: "oidc|uploader-2" }), session.uploadId, session.idempotencyKey), "upload_not_found", 404);
    await rejectsWith(uploads.complete(actor, session.uploadId, "oidc|uploader-1:other"), "upload_idempotency_mismatch", 409);
    await rejectsWith(uploads.complete(actor, session.uploadId, session.idempotencyKey), "upload_incomplete", 409);
  } finally {
    if (previous === undefined) delete process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS;
    else process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS = previous;
  }
});

test("apiError maps UploadRequestError to its typed status and stable code", async () => {
  const source = await readFile("lib/server/http.ts", "utf8");
  assert.match(source, /error instanceof UploadRequestError[\s\S]*error: error\.code[\s\S]*status: error\.status/);
});
