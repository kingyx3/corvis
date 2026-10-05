import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { UPLOAD_SESSION_TTL_MS, UploadRequestError, uploads, uploadIdempotencyKey } from "./uploads.ts";

// The in-memory demo adapter is selected once per process, so this file owns that choice.
process.env.CORVIS_DEMO_MODE = "true";

const TENANT = "00000000-0000-0000-0000-0000000000d1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000d2";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "oidc|demo-uploader",
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    roles: ["analyst"],
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true },
    authMethod: "oidc",
    sessionId: "session-demo",
    ...overrides,
  };
}

function input(key: string, overrides: Partial<Parameters<ReturnType<typeof uploads>["initiate"]>[1]> = {}) {
  return { fileName: "demo.pdf", contentType: "application/pdf", sizeBytes: 2048, idempotencyKey: key, ...overrides };
}

async function failsWith(operation: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof UploadRequestError, `expected UploadRequestError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("demo mode serves one shared in-memory session store", () => {
  assert.equal(uploads(), uploads());
});

test("a demo initiate validates the request and replays one session per idempotency key", async () => {
  const demo = uploads();
  const actor = identity();
  const key = uploadIdempotencyKey(actor, "replay");
  await failsWith(demo.initiate(actor, input(key, { fileName: "payload.exe" })), "unsupported_file_type", 415);

  const first = await demo.initiate(actor, input(key));
  assert.equal(first.state, "initiated");
  assert.equal(first.contentValidated, true);
  assert.equal(first.malwareScanStatus, "clean");
  assert.equal(first.tenantId, TENANT);
  assert.equal(first.workspaceId, WORKSPACE);
  assert.match(first.resumableUploadUrl ?? "", /^\/api\/v1\/uploads\/[0-9a-f-]{36}\/demo$/);

  const replay = await demo.initiate(actor, input(key));
  assert.equal(replay.uploadId, first.uploadId);
  assert.equal(replay, first, "the replay returns the same session");
});

test("a demo initiate replay must be from the same uploader and describe the same file", async () => {
  const demo = uploads();
  const actor = identity();
  const key = uploadIdempotencyKey(actor, "guarded");
  await demo.initiate(actor, input(key));

  await failsWith(demo.initiate(actor, input(key, { sizeBytes: 4096 })), "upload_idempotency_mismatch", 409);
  await failsWith(demo.initiate(actor, input(key, { fileName: "other.pdf" })), "upload_idempotency_mismatch", 409);
  await failsWith(demo.initiate(actor, input(key, { checksumSha256: "a".repeat(64) })), "upload_idempotency_mismatch", 409);
  await failsWith(demo.initiate(identity({ subject: "oidc|someone-else" }), input(key)), "upload_idempotency_mismatch", 409);
  await failsWith(demo.initiate(identity({ workspaceId: "00000000-0000-0000-0000-0000000000d3" }), input(key)), "upload_idempotency_mismatch", 409);
});

test("an aborted demo session is replaced by a fresh one under the same idempotency key", async () => {
  const demo = uploads();
  const actor = identity();
  const key = uploadIdempotencyKey(actor, "restart");
  const first = await demo.initiate(actor, input(key));
  await demo.abort(actor, first.uploadId);
  assert.equal((await demo.get(actor, first.uploadId)).state, "aborted");

  const second = await demo.initiate(actor, input(key, { fileName: "different.pdf", sizeBytes: 512 }));
  assert.notEqual(second.uploadId, first.uploadId);
  assert.equal(second.state, "initiated");
  assert.equal(second.fileName, "different.pdf");
  assert.equal((await demo.initiate(actor, input(key, { fileName: "different.pdf", sizeBytes: 512 }))).uploadId, second.uploadId, "the key now maps to the new session");
});

test("demo sessions are tenant-scoped", async () => {
  const demo = uploads();
  const actor = identity();
  const session = await demo.initiate(actor, input(uploadIdempotencyKey(actor, "tenant")));
  const outsider = identity({ tenantId: "00000000-0000-0000-0000-0000000000e1" });
  await failsWith(demo.get(outsider, session.uploadId), "upload_not_found", 404);
  await failsWith(demo.get(actor, "00000000-0000-0000-0000-00000000dead"), "upload_not_found", 404);
  await failsWith(demo.abort(outsider, session.uploadId), "upload_not_found", 404);
  assert.equal((await demo.get(actor, session.uploadId)).uploadId, session.uploadId);
});

test("a demo complete needs the session's idempotency key and releases once", async () => {
  const demo = uploads();
  const actor = identity();
  const key = uploadIdempotencyKey(actor, "complete");
  const session = await demo.initiate(actor, input(key));
  await failsWith(demo.complete(actor, session.uploadId, "wrong-key"), "upload_idempotency_mismatch", 409);
  assert.equal((await demo.get(actor, session.uploadId)).state, "initiated");

  const done = await demo.complete(actor, session.uploadId, key);
  assert.equal(done.state, "complete");
  assert.ok(done.releasedAt);

  const repeat = await demo.complete(actor, session.uploadId, key);
  assert.equal(repeat.state, "complete");
  assert.equal(repeat.releasedAt, done.releasedAt, "a repeat complete does not re-release");
});

test("a demo abort cancels an active session but never a completed one", async () => {
  const demo = uploads();
  const actor = identity();
  const active = await demo.initiate(actor, input(uploadIdempotencyKey(actor, "abort-active")));
  await demo.abort(actor, active.uploadId);
  assert.equal((await demo.get(actor, active.uploadId)).state, "aborted");
  await demo.abort(actor, active.uploadId);
  assert.equal((await demo.get(actor, active.uploadId)).state, "aborted", "aborting twice is harmless");

  const key = uploadIdempotencyKey(actor, "abort-complete");
  const finished = await demo.initiate(actor, input(key));
  await demo.complete(actor, finished.uploadId, key);
  await failsWith(demo.abort(actor, finished.uploadId), "upload_not_active", 409);
  assert.equal((await demo.get(actor, finished.uploadId)).state, "complete");
});

test("the demo sweep abandons only stale unfinished sessions of its own tenant", async () => {
  const demo = uploads();
  const tenant = "00000000-0000-0000-0000-0000000000f1";
  const actor = identity({ tenantId: tenant });
  const stale = await demo.initiate(actor, input(uploadIdempotencyKey(actor, "stale")));
  const finishedKey = uploadIdempotencyKey(actor, "finished");
  const finished = await demo.initiate(actor, input(finishedKey));
  await demo.complete(actor, finished.uploadId, finishedKey);
  const cancelled = await demo.initiate(actor, input(uploadIdempotencyKey(actor, "cancelled")));
  await demo.abort(actor, cancelled.uploadId);
  const bystander = identity({ tenantId: "00000000-0000-0000-0000-0000000000f2" });
  const foreign = await demo.initiate(bystander, input(uploadIdempotencyKey(bystander, "foreign")));

  const early = await demo.sweep(tenant);
  assert.deepEqual(early, { scanned: 3, abandoned: 0, quarantinePurged: 0, retained: 1, skipped: 2 }, "nothing is abandoned while sessions are young");
  assert.equal((await demo.get(actor, stale.uploadId)).state, "initiated");

  const later = new Date(Date.now() + UPLOAD_SESSION_TTL_MS + 60_000);
  const swept = await demo.sweep(tenant, { now: later });
  assert.deepEqual(swept, { scanned: 3, abandoned: 1, quarantinePurged: 0, retained: 1, skipped: 1 });
  const abandoned = await demo.get(actor, stale.uploadId);
  assert.equal(abandoned.state, "aborted");
  assert.equal(abandoned.purgedAt, later.toISOString());
  assert.equal((await demo.get(actor, finished.uploadId)).state, "complete", "accepted evidence is retained");
  assert.equal((await demo.get(bystander, foreign.uploadId)).state, "initiated", "another tenant's sessions are untouched");

  const again = await demo.sweep(tenant, { now: later });
  assert.deepEqual(again, { scanned: 3, abandoned: 0, quarantinePurged: 0, retained: 1, skipped: 2 }, "a repeat sweep is idempotent");

  const custom = await demo.sweep(bystander.tenantId, { abandonedAfterMs: 0, now: new Date(Date.now() + 1000) });
  assert.equal(custom.abandoned, 1, "abandonedAfterMs overrides the default window");
  assert.equal((await demo.get(bystander, foreign.uploadId)).state, "aborted");
});
