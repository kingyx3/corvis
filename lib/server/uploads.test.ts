import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  hashed: string[] = [];
  async getObjectSha256(key: string): Promise<string> {
    const stored = this.objects.get(key);
    if (!stored) throw new Error("GCS object hash read failed (404)");
    this.hashed.push(key);
    return createHash("sha256").update(stored.bytes).digest("hex");
  }
  /** Number of upcoming deleteObject calls that fail (GCS 5xx/timeout/403) without deleting anything. */
  failDeletes = 0;
  async deleteObject(key: string): Promise<void> {
    if (this.failDeletes > 0) { this.failDeletes -= 1; throw new Error("GCS object deletion failed (503)"); }
    this.deleted.push(key);
    this.objects.delete(key);
  }
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
  /** What the artifact row currently says (the integrity seal reads it), and whether a declared digest agrees. */
  artifact: PostgresRow | undefined;
  shaMatches = true;
  sealed: PostgresPrimitive[][] = [];
  /** Simulates a release/abort winning between the sweep's registry read and its claim. */
  loseClaimRace = false;
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("returning 1 as claimed")) {
      const status = this.artifact?.quarantine_status;
      return this.loseClaimRace || status === "released" || status === "purged" ? [] : [{ claimed: 1 }];
    }
    if (sql.includes("select malware_scan_status, quarantine_status")) return this.artifact ? [this.artifact] : [];
    if (sql.includes("set sha256=lower(coalesce(sha256")) {
      this.sealed.push(parameters);
      return [{ sha_matches: this.shaMatches }];
    }
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
      .filter((call) => call.sql.includes("corvis_source.document_artifact_version") && call.sql.startsWith("update") && !call.sql.includes("set sha256="))
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

test("malformed initiate fields are typed 400s and never authorize a GCS session", async () => {
  const { uploads, store } = harness();
  const actor = identity();
  await rejectsWith(uploads.initiate(actor, initiateInput({ fileName: ["report.pdf"] as unknown as string })), "invalid_upload_request", 400);
  await rejectsWith(uploads.initiate(actor, initiateInput({ fileName: `${"a".repeat(300)}.pdf` })), "invalid_upload_request", 400);
  await rejectsWith(uploads.initiate(actor, initiateInput({ checksumSha256: "not-a-digest" })), "invalid_upload_request", 400);
  await rejectsWith(uploads.initiate(actor, initiateInput({ checksumSha256: 42 as unknown as string })), "invalid_upload_request", 400);
  await rejectsWith(uploads.initiate(actor, initiateInput({ contentType: ["application/pdf"] as unknown as string })), "unsupported_media_type", 415);
  await rejectsWith(uploads.initiate(actor, initiateInput({ sizeBytes: 1024.5 })), "invalid_file_size", 400);
  assert.equal(store.resumable.size, 0);
});

test("an initiate replay with the same key but a different file is an idempotency conflict", async () => {
  const { uploads, store } = harness();
  const actor = identity();
  const first = await uploads.initiate(actor, initiateInput());
  await rejectsWith(uploads.initiate(actor, initiateInput({ sizeBytes: 8192 })), "upload_idempotency_mismatch", 409);
  await rejectsWith(uploads.initiate(actor, initiateInput({ fileName: "other.pdf" })), "upload_idempotency_mismatch", 409);
  await rejectsWith(uploads.initiate(actor, initiateInput({ checksumSha256: "d".repeat(64) })), "upload_idempotency_mismatch", 409);
  assert.equal((await uploads.initiate(actor, initiateInput())).uploadId, first.uploadId);
  assert.equal(store.resumable.size, 1);
});

test("a failed initiate never leaves a replayable session behind its idempotency key", async () => {
  const store = new FakeObjectStore();
  let failRegistration = true;
  const db = new (class extends FakeDb {
    override async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
      if (failRegistration && sql.includes("insert into corvis_source.document")) throw new Error("postgres unavailable");
      return super.execute(sql, parameters);
    }
  })();
  const uploads = new ProductionUploadSessions(store, db);
  const actor = identity();

  await rejects(uploads.initiate(actor, initiateInput()), /postgres unavailable/);
  assert.equal(store.cancelled.length, 1);
  const orphanKey = [...store.json.keys()].find((key) => key.startsWith("_corvis/upload-sessions/"));
  assert.ok(orphanKey);
  assert.equal((JSON.parse(store.json.get(orphanKey) ?? "null") as UploadSession).state, "aborted");

  failRegistration = false;
  const retried = await uploads.initiate(actor, initiateInput());
  assert.notEqual(retried.resumableUploadUrl, store.cancelled[0], "retry must not replay a cancelled resumable session");
  assert.equal(retried.state, "initiated");
});

test("aborting a completed upload is refused and never relabels the released document", async () => {
  const { uploads, db, store, actor, session } = await acceptedUpload();
  const statusesBefore = db.documentStatuses().length;
  await rejectsWith(uploads.abort(actor, session.uploadId), "upload_not_active", 409);
  assert.equal(storedSession(store, session).state, "complete");
  assert.equal(db.documentStatuses().length, statusesBefore);
  assert.equal(db.documentStatuses().includes("aborted"), false);
  assert.equal(store.deleted.includes(session.objectKey ?? ""), false);
});

test("aborting an already-aborted upload is an idempotent no-op", async () => {
  const { uploads, db, store } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  await uploads.abort(actor, session.uploadId);
  const callsAfterFirst = db.calls.length;
  await uploads.abort(actor, session.uploadId);
  assert.equal(db.calls.length, callsAfterFirst);
  assert.equal(store.cancelled.length, 1);
});

test("release seals the SHA-256 of the stored bytes onto the artifact before queueing processing", async () => {
  const { db, store, session, released } = await acceptedUpload();
  assert.equal(released.state, "complete");
  const digest = createHash("sha256").update(store.objects.get(session.objectKey ?? "")?.bytes ?? Buffer.alloc(0)).digest("hex");
  assert.equal(db.sealed.length, 1);
  assert.equal(db.sealed[0]?.[2], digest, "the digest is computed from the object bytes, not taken from the client");
  const sealIndex = db.calls.findIndex((call) => call.sql.includes("set sha256=lower(coalesce(sha256"));
  const releaseIndex = db.calls.findIndex((call) => call.sql.includes("release_clean_artifact"));
  assert.ok(sealIndex >= 0 && sealIndex < releaseIndex, "the digest must be recorded before the artifact is released");
});

test("bytes that contradict the declared SHA-256 are quarantined and never released", async () => {
  const context = harness();
  const actor = identity();
  const session = await context.uploads.initiate(actor, initiateInput({ checksumSha256: "a".repeat(64) }));
  context.store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await context.uploads.complete(actor, session.uploadId, session.idempotencyKey);
  context.db.shaMatches = false;
  context.store.scan(session.objectKey ?? "", "clean");

  await assert.rejects(context.uploads.get(actor, session.uploadId), (error: unknown) => {
    assert.ok(error instanceof UploadRequestError);
    assert.equal(error.code, "upload_integrity_failed");
    assert.equal(error.status, 422);
    return true;
  });
  assert.equal(context.db.releases.length, 0, "a contradicted digest must never reach processing");
  assert.ok(context.db.calls.some((call) => call.sql.includes("malware_scan_status='integrity_failed'")));
  assert.equal(storedSession(context.store, session).state, "quarantined");
  assert.equal(storedSession(context.store, session).contentValidated, false);
});

test("an artifact already blocked in the registry is not released by a later clean verdict", async () => {
  const context = harness();
  const actor = identity();
  const session = await context.uploads.initiate(actor, initiateInput());
  context.store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await context.uploads.complete(actor, session.uploadId, session.idempotencyKey);
  context.db.artifact = { malware_scan_status: "threat", quarantine_status: "quarantined" };
  context.store.scan(session.objectKey ?? "", "clean");
  const after = await context.uploads.get(actor, session.uploadId);
  assert.equal(after.state, "quarantined");
  assert.equal(context.db.releases.length, 0);
  assert.deepEqual(context.store.hashed, [], "blocked artifacts are not even read");
  assert.equal(after.malwareScanStatus, "threat", "the session reports the threat the scheduled poll recorded");
  assert.equal(storedSession(context.store, session).malwareScanStatus, "threat");
});

test("an integrity failure recorded by the scheduled release is reported to the polling client", async () => {
  const context = harness();
  const actor = identity();
  const session = await context.uploads.initiate(actor, initiateInput());
  context.store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await context.uploads.complete(actor, session.uploadId, session.idempotencyKey);
  context.db.artifact = { malware_scan_status: "integrity_failed", quarantine_status: "quarantined" };
  context.store.scan(session.objectKey ?? "", "clean");
  await assert.rejects(context.uploads.get(actor, session.uploadId), (error: unknown) => error instanceof UploadRequestError && error.code === "upload_integrity_failed");
  assert.equal(storedSession(context.store, session).contentValidated, false);
  assert.equal(context.db.releases.length, 0);
  // Later polls stop retrying: the rejected signature is terminal.
  assert.equal((await context.uploads.get(actor, session.uploadId)).state, "quarantined");
});

test("an artifact another worker already released is not hashed or released again", async () => {
  const context = harness();
  const actor = identity();
  const session = await context.uploads.initiate(actor, initiateInput());
  context.store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await context.uploads.complete(actor, session.uploadId, session.idempotencyKey);
  context.db.artifact = { malware_scan_status: "clean", quarantine_status: "released" };
  context.store.scan(session.objectKey ?? "", "clean");
  const after = await context.uploads.get(actor, session.uploadId);
  assert.equal(after.state, "complete");
  assert.deepEqual(context.store.hashed, []);
  // release_clean_artifact is NOT safe to call again: it unconditionally resets
  // document.status back to 'queued' regardless of how far the pipeline has
  // since progressed, so a second caller observing "released" must skip it.
  assert.equal(context.db.releases.length, 0, "an already-released artifact must not be re-released");
});

test("the sweep never deletes the bytes of an artifact the scheduled release already released", async () => {
  // The scheduled release updates only the registry (its service account cannot write session objects),
  // so the session JSON stays `quarantined` after a successful release. Past the retention window the
  // sweep used to treat that stale session as abandoned, delete the source bytes and mark the RELEASED
  // artifact purged.
  const store = new FakeObjectStore();
  const db = new FakeDb();
  const uploads = new ProductionUploadSessions(store, db);
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  db.artifact = { malware_scan_status: "clean", quarantine_status: "released" };
  backdate(store, session, QUARANTINE_RETENTION_MS + 60_000);
  assert.equal(storedSession(store, session).state, "quarantined", "precondition: the session JSON is stale");

  const result = await uploads.sweep(actor.tenantId);

  assert.equal(result.quarantinePurged, 0);
  assert.equal(result.retained, 1);
  assert.deepEqual(store.deleted, [], "released source bytes must survive the sweep");
  assert.ok(store.objects.has(session.objectKey ?? ""));
  assert.ok(!db.calls.some((call) => call.sql.includes("quarantine_status='purged'")), "a released artifact is never marked purged");
  const repaired = storedSession(store, session);
  assert.equal(repaired.state, "complete", "the stale session is repaired so it is retained from now on");
  assert.equal(repaired.malwareScanStatus, "clean");
});

test("the sweep deletes nothing when a release wins the race for the registry row", async () => {
  const store = new FakeObjectStore();
  const db = new FakeDb();
  const uploads = new ProductionUploadSessions(store, db);
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  backdate(store, session, QUARANTINE_RETENTION_MS + 60_000);
  db.loseClaimRace = true; // registry still reads 'quarantined', but the guarded claim matches no row

  const result = await uploads.sweep(actor.tenantId);

  assert.equal(result.quarantinePurged, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(store.deleted, [], "bytes are deleted only after the registry claim succeeds");
});

test("an upload id that is not a server-issued UUID never reaches an object key", async () => {
  const context = harness();
  const reads: string[] = [];
  const store = context.store as unknown as { getJson: (key: string) => Promise<unknown>; getJsonWithGeneration?: (key: string) => Promise<unknown> };
  const getJson = store.getJson.bind(store);
  store.getJson = async (key: string) => { reads.push(key); return getJson(key); };
  if (store.getJsonWithGeneration) {
    const withGeneration = store.getJsonWithGeneration.bind(store);
    store.getJsonWithGeneration = async (key: string) => { reads.push(key); return withGeneration(key); };
  }
  for (const uploadId of ["../../tenant=other/session", "not-a-uuid", "", "00000000-0000-0000-0000-00000000000g", "/etc/passwd"]) {
    await assert.rejects(context.uploads.get(identity(), uploadId), (error: unknown) => error instanceof UploadRequestError && error.code === "upload_not_found", uploadId);
  }
  assert.deepEqual(reads, [], "a malformed id is refused before any storage read");
});

/** A purge failure is logged to the console as a structured event; keep it out of the test output. */
function silenceLogs(t: { mock: { method: (object: object, name: "error" | "warn") => unknown } }): void {
  t.mock.method(console, "error");
  t.mock.method(console, "warn");
}

test("a failed byte delete on abort never records purgedAt, and a later sweep deletes and records it", async (t) => {
  silenceLogs(t);
  const { uploads, store } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  store.failDeletes = 1;

  await rejects(uploads.abort(actor, session.uploadId), /could not be deleted/);
  const failed = storedSession(store, session);
  assert.equal(failed.state, "aborted", "the abort itself is durable");
  assert.equal(failed.purgedAt, undefined, "an object that was not deleted is not purged");
  assert.ok(store.objects.has(session.objectKey ?? ""));

  const result = await uploads.sweep(actor.tenantId);
  assert.equal(result.abandoned, 1);
  assert.deepEqual(store.deleted, [session.objectKey]);
  assert.ok(storedSession(store, session).purgedAt);

  const again = await uploads.sweep(actor.tenantId);
  assert.equal(again.abandoned, 0);
  assert.equal(store.deleted.length, 1, "a purged session is never deleted twice");
});

test("repeating an abort whose delete failed retries the delete", async (t) => {
  silenceLogs(t);
  const { uploads, store } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  store.failDeletes = 1;
  await rejects(uploads.abort(actor, session.uploadId), /could not be deleted/);

  await uploads.abort(actor, session.uploadId);
  assert.deepEqual(store.deleted, [session.objectKey]);
  assert.ok(storedSession(store, session).purgedAt);
});

test("a failed cancel of the resumable session is best effort and still purges the object", async () => {
  const { uploads, store } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  store.cancelResumableUpload = async () => { throw new Error("GCS resumable upload cancellation failed (503)"); };

  await uploads.abort(actor, session.uploadId);
  assert.deepEqual(store.deleted, [session.objectKey]);
  assert.ok(storedSession(store, session).purgedAt);
});

test("a failed delete of an abandoned session leaves it for the next sweep instead of failing the sweep", async (t) => {
  silenceLogs(t);
  const { uploads, store, db } = harness();
  const actor = identity();
  const stuck = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:stuck" }));
  const other = await uploads.initiate(actor, initiateInput({ idempotencyKey: "oidc|uploader-1:other" }));
  backdate(store, stuck, UPLOAD_SESSION_TTL_MS + 60_000);
  backdate(store, other, UPLOAD_SESSION_TTL_MS + 60_000);
  store.failDeletes = 1;

  const first = await uploads.sweep(actor.tenantId);
  assert.equal(first.scanned, 2);
  assert.equal(first.skipped, 1, "the session whose delete failed is skipped");
  assert.equal(first.abandoned, 1, "the rest of the page is still processed");
  const afterFirst = [stuck, other].map((session) => storedSession(store, session));
  assert.deepEqual(afterFirst.map((session) => session.state), ["aborted", "aborted"]);
  assert.equal(afterFirst.filter((session) => session.purgedAt).length, 1);
  assert.equal(db.documentStatuses().filter((status) => status === "aborted").length, 2);

  const second = await uploads.sweep(actor.tenantId);
  assert.equal(second.abandoned, 1);
  assert.ok([stuck, other].every((session) => storedSession(store, session).purgedAt));
  assert.equal(store.deleted.length, 2);
});

test("a failed delete while expiring a session still reports expiry and is retried by sweep", async (t) => {
  silenceLogs(t);
  const { uploads, store } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  backdate(store, session, UPLOAD_SESSION_TTL_MS + 60_000);
  store.failDeletes = 1;

  await rejectsWith(uploads.complete(actor, session.uploadId, session.idempotencyKey), "upload_expired", 410);
  const expired = storedSession(store, session);
  assert.equal(expired.state, "aborted");
  assert.equal(expired.purgedAt, undefined);

  await uploads.sweep(actor.tenantId);
  assert.deepEqual(store.deleted, [session.objectKey]);
  assert.ok(storedSession(store, session).purgedAt);
});

test("a failed delete of purged quarantine bytes is retried even though the registry row is already claimed", async (t) => {
  silenceLogs(t);
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  store.scan(session.objectKey ?? "", "threat");
  await uploads.get(actor, session.uploadId);
  store.failDeletes = 1;

  const first = await uploads.sweep(actor.tenantId);
  assert.equal(first.quarantinePurged, 0);
  assert.equal(first.skipped, 1);
  assert.equal(storedSession(store, session).purgedAt, undefined);
  assert.ok(store.objects.has(session.objectKey ?? ""));

  db.artifact = { malware_scan_status: "threat", quarantine_status: "purged" }; // the first sweep's claim stuck
  const second = await uploads.sweep(actor.tenantId);
  assert.equal(second.quarantinePurged, 1);
  assert.deepEqual(store.deleted, [session.objectKey]);
  assert.ok(storedSession(store, session).purgedAt);
});

test("a registry failure while marking the artifact purged is logged and does not fail the abort", async (t) => {
  const warn = t.mock.method(console, "warn");
  const store = new FakeObjectStore();
  const db = new (class extends FakeDb {
    override async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
      if (sql.includes("quarantine_status='purged'")) throw new Error("postgres unavailable");
      return super.execute(sql, parameters);
    }
  })();
  const uploads = new ProductionUploadSessions(store, db);
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());

  await uploads.abort(actor, session.uploadId);
  assert.deepEqual(store.deleted, [session.objectKey]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /upload\.mark_artifact_purged_failed/);
});

test("completion never overwrites a registry row a concurrent abort already purged", async () => {
  const { uploads, store, db } = harness();
  const actor = identity();
  const session = await uploads.initiate(actor, initiateInput());
  store.finalize(session.resumableUploadUrl ?? "", pdfBytes(session.sizeBytes));
  await uploads.complete(actor, session.uploadId, session.idempotencyKey);
  const quarantine = db.calls.find((call) => call.sql.includes("set storage_generation="));
  assert.ok(quarantine);
  assert.match(quarantine.sql, /and quarantine_status in \('pending','quarantined'\)/);
});
