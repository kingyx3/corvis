import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach } from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { SOURCE_SYNC_SUBJECT, putResumableBytes, sourceSyncIdentity, uploadIngestSink } from "./source-ingest-sink.ts";
import { acquisitionKey, type IngestInput } from "./source-connectors.ts";
import { UploadRequestError, uploadIdempotencyKey, type UploadSession, type UploadSessionPort } from "./uploads.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

const originalDemo = process.env.CORVIS_DEMO_MODE;
const originalOrigins = process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS;
const originalFetch = globalThis.fetch;
afterEach(() => {
  if (originalDemo === undefined) delete process.env.CORVIS_DEMO_MODE; else process.env.CORVIS_DEMO_MODE = originalDemo;
  if (originalOrigins === undefined) delete process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS; else process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS = originalOrigins;
  globalThis.fetch = originalFetch;
});

function input(overrides: Partial<IngestInput> = {}): IngestInput {
  const bytes = Buffer.from("%PDF-1.4 demo");
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    tenantId: TENANT, workspaceId: WORKSPACE, providerKey: "acme-portal", fileName: "q1.pdf", bytes, contentType: "application/pdf", contentSha256,
    sourceConnectionId: "connection-1", acquisitionKey: acquisitionKey("remote-1", "v1", contentSha256), ...overrides,
  };
}

type Call = { method: string; identity: RequestIdentity; args: unknown[] };

class FakeUploads implements UploadSessionPort {
  readonly calls: Call[] = [];
  state: UploadSession["state"] = "initiated";
  initiateError?: Error;
  completeError?: Error;
  async initiate(identity: RequestIdentity, request: Parameters<UploadSessionPort["initiate"]>[1]): Promise<UploadSession> {
    this.calls.push({ method: "initiate", identity, args: [request] });
    if (this.initiateError) throw this.initiateError;
    return { uploadId: "upload-1", documentId: DOCUMENT_ID, artifactVersionId: ARTIFACT_ID, ingestionId: "ing", tenantId: identity.tenantId, workspaceId: identity.workspaceId, actorSubject: identity.subject, fileName: request.fileName, contentType: request.contentType, sizeBytes: request.sizeBytes, chunkSize: 1, state: this.state, idempotencyKey: request.idempotencyKey, createdAt: "2026-10-02T00:00:00.000Z", resumableUploadUrl: "https://upload.test/session-1" };
  }
  async get(): Promise<UploadSession> { throw new Error("unused"); }
  async complete(identity: RequestIdentity, uploadId: string, key: string): Promise<UploadSession> {
    this.calls.push({ method: "complete", identity, args: [uploadId, key] });
    if (this.completeError) throw this.completeError;
    return { uploadId, documentId: DOCUMENT_ID, artifactVersionId: ARTIFACT_ID, state: "quarantined" } as UploadSession;
  }
  async abort(): Promise<void> { throw new Error("unused"); }
  async sweep(): Promise<never> { throw new Error("unused"); }
}

test("collected documents are uploaded through the one upload pipeline as the scheduler's own system identity", async () => {
  const uploads = new FakeUploads();
  const sent: Array<{ url: string; bytes: string; contentType: string }> = [];
  const sink = uploadIngestSink({ uploads, putBytes: async (url, bytes, contentType) => { sent.push({ url, bytes: bytes.toString(), contentType }); } });
  const document = input();
  const result = await sink.ingest(document);

  assert.deepEqual(result, { accepted: true, documentId: DOCUMENT_ID, documentArtifactVersionId: ARTIFACT_ID });
  assert.deepEqual(uploads.calls.map((call) => call.method), ["initiate", "complete"]);
  assert.deepEqual(sent, [{ url: "https://upload.test/session-1", bytes: "%PDF-1.4 demo", contentType: "application/pdf" }]);
  const [initiate] = uploads.calls;
  assert.equal(initiate!.identity.subject, SOURCE_SYNC_SUBJECT);
  assert.equal(initiate!.identity.tenantId, TENANT);
  assert.equal(initiate!.identity.workspaceId, WORKSPACE);
  assert.deepEqual(initiate!.identity.roles, [], "the system identity holds no role");
  assert.deepEqual(initiate!.args[0], { fileName: "q1.pdf", contentType: "application/pdf", sizeBytes: document.bytes.length, checksumSha256: document.contentSha256, idempotencyKey: uploadIdempotencyKey(initiate!.identity, `connection-1:${document.acquisitionKey}`), origin: undefined });
});

test("the upload idempotency key is bound to the connection and the remote document version, so a re-run never duplicates", async () => {
  const keys = async (document: IngestInput) => {
    const uploads = new FakeUploads();
    await uploadIngestSink({ uploads, putBytes: async () => undefined }).ingest(document);
    return (uploads.calls[0]!.args[0] as { idempotencyKey: string }).idempotencyKey;
  };
  const first = await keys(input());
  assert.equal(await keys(input()), first, "the same remote version always maps to the same upload");
  assert.notEqual(await keys(input({ acquisitionKey: acquisitionKey("remote-1", "v2", "x".repeat(64)) })), first, "a new version is a new upload");
  assert.notEqual(await keys(input({ sourceConnectionId: "connection-2" })), first, "another connection never shares an upload");
});

test("a session that already has its bytes is completed again, never re-sent", async () => {
  for (const state of ["quarantined", "complete"] as const) {
    const uploads = new FakeUploads();
    uploads.state = state;
    let sends = 0;
    const result = await uploadIngestSink({ uploads, putBytes: async () => { sends += 1; } }).ingest(input());
    assert.equal(result.accepted, true);
    assert.equal(sends, 0, state);
    assert.deepEqual(uploads.calls.map((call) => call.method), ["initiate", "complete"]);
  }
  const uploading = new FakeUploads();
  uploading.state = "uploading";
  let sends = 0;
  await uploadIngestSink({ uploads: uploading, putBytes: async () => { sends += 1; } }).ingest(input());
  assert.equal(sends, 1, "a session still waiting for its bytes receives them");
});

test("the first allowed upload origin is presented when one is configured", async () => {
  process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS = "https://app.corvis.test,https://other.test";
  const uploads = new FakeUploads();
  await uploadIngestSink({ uploads, putBytes: async () => undefined }).ingest(input());
  assert.equal((uploads.calls[0]!.args[0] as { origin?: string }).origin, "https://app.corvis.test");
});

test("a problem with this one document is a rejection, and a failed integrity check is a quarantine", async () => {
  const outcome = async (where: "initiate" | "complete", code: ConstructorParameters<typeof UploadRequestError>[0]) => {
    const uploads = new FakeUploads();
    if (where === "initiate") uploads.initiateError = new UploadRequestError(code, "x"); else uploads.completeError = new UploadRequestError(code, "x");
    return uploadIngestSink({ uploads, putBytes: async () => undefined }).ingest(input());
  };
  assert.deepEqual(await outcome("initiate", "unsupported_file_type"), { accepted: false, reason: "unsupported_file_type", quarantined: false });
  assert.deepEqual(await outcome("initiate", "invalid_file_size"), { accepted: false, reason: "invalid_file_size", quarantined: false });
  assert.deepEqual(await outcome("complete", "invalid_file_content"), { accepted: false, reason: "invalid_file_content", quarantined: false });
  assert.deepEqual(await outcome("complete", "upload_integrity_failed"), { accepted: false, reason: "upload_integrity_failed", quarantined: true });
});

test("an infrastructure fault is not mistaken for a rejected document: it propagates so the run records it", async () => {
  const conflict = new FakeUploads();
  conflict.completeError = new UploadRequestError("upload_conflict", "busy");
  await assert.rejects(uploadIngestSink({ uploads: conflict, putBytes: async () => undefined }).ingest(input()), (error: unknown) => error instanceof UploadRequestError && error.code === "upload_conflict");
  const broken = new FakeUploads();
  await assert.rejects(uploadIngestSink({ uploads: broken, putBytes: async () => { throw new Error("storage down"); } }).ingest(input()), /storage down/);
  assert.deepEqual(broken.calls.map((call) => call.method), ["initiate"], "an upload that did not transfer is never completed");
});

test("demo mode has no object store to send to, so the transfer is skipped and the demo session is completed", async () => {
  process.env.CORVIS_DEMO_MODE = "true";
  const uploads = new FakeUploads();
  globalThis.fetch = (async () => { throw new Error("demo mode must not send bytes anywhere"); }) as typeof fetch;
  const result = await uploadIngestSink({ uploads }).ingest(input());
  assert.equal(result.accepted, true);
});

test("outside demo mode the default transfer is one ranged PUT to the session URL", async () => {
  delete process.env.CORVIS_DEMO_MODE;
  const requests: Array<{ url: string; method?: string; headers: Record<string, string>; size: number }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method, headers: init.headers as Record<string, string>, size: (init.body as Uint8Array).length });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const uploads = new FakeUploads();
  const document = input();
  const result = await uploadIngestSink({ uploads }).ingest(document);
  assert.equal(result.accepted, true);
  assert.deepEqual(requests, [{
    url: "https://upload.test/session-1", method: "PUT",
    headers: { "content-type": "application/pdf", "content-range": `bytes 0-${document.bytes.length - 1}/${document.bytes.length}` },
    size: document.bytes.length,
  }]);
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(putResumableBytes("https://upload.test/x", Buffer.from("a"), "application/pdf"), /failed \(503\)/);
});

test("the system identity is scoped to one workspace and is not a customer user", () => {
  const identity = sourceSyncIdentity(TENANT, WORKSPACE);
  assert.equal(identity.subject, "system:source-sync");
  assert.deepEqual(identity.entitlements.workspaceIds, [WORKSPACE]);
  assert.equal(identity.entitlements.sourceDocumentAccessAllowed, false);
  assert.equal(identity.isTenantAdmin, undefined);
});
