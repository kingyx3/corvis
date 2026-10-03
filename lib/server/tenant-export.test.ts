import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import type { RedeemedTenantExport } from "./tenant-export.ts";

// data-governance.ts reaches the Next.js "@/..." alias through http.ts; see lib/server/http.test.ts.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);
const { DataGovernanceError } = await import("./data-governance.ts");
const {
  PostgresTenantExportBackend,
  TENANT_EXPORT_LINK_MINUTES,
  artifactScope,
  isUuid,
  tenantExportAuditEvent,
  toTenantExportRequest,
} = await import("./tenant-export.ts");

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";
const REQUEST = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "idp|alex", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], authMethod: "oidc", sessionId: "session-1", isTenantAdmin: true,
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const morgan = identity({ subject: "idp|morgan" });

const publicManifest = {
  manifestVersion: 1, requestId: REQUEST, tenantId: TENANT, generatedAt: "2026-10-03T00:00:00.000Z", requestedBy: "idp|alex", approvedBy: "idp|morgan",
  files: [], dataRights: { basis: "b", funds: { included: 1, excluded: 0 }, documents: { included: 1, excluded: 0 } }, notIncluded: [],
};
const storedManifest = { ...publicManifest, artifact: { contentType: "application/zip", sizeBytes: 10, objectKey: "exports/x", fundIds: ["fund-a"], documentIds: ["doc-a"] } };

function row(overrides: PostgresRow = {}): PostgresRow {
  return {
    request_id: REQUEST, state: "pending_approval", reason: "Records review", requested_by_auth_method: "oidc", requested_by_subject: "idp|alex",
    requested_at: "2026-10-01 10:00:00+00", approval_expires_at: "2026-10-08 10:00:00+00", decided_by_subject: null, decided_at: null, decision_note: null,
    cancelled_at: null, state_changed_at: "2026-10-01 10:00:00+00", checksum_sha256: null, size_bytes: null, artifact_expires_at: null, manifest: null,
    approval_lapsed: false, download_available: false, ...overrides,
  };
}
const completeRow = (overrides: PostgresRow = {}) => row({
  state: "complete", decided_by_subject: "idp|morgan", decided_at: "2026-10-01 11:00:00+00", checksum_sha256: "a".repeat(64), size_bytes: "4694",
  artifact_expires_at: "2026-10-04 10:00:00+00", manifest: storedManifest, download_available: true, ...overrides,
});

type Call = { sql: string; parameters: PostgresPrimitive[] };
class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  readonly executed: Call[] = [];
  private readonly handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[];
  failExecute?: (sql: string) => boolean;
  constructor(handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[] = () => []) { this.handler = handler; }
  async query(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); return this.handler(sql, parameters); }
  async execute(sql: string, parameters: PostgresPrimitive[] = []) {
    this.executed.push({ sql, parameters });
    if (this.failExecute?.(sql)) throw new Error(`execute failed: ${sql}`);
  }
  async health() { return true; }
}

const refusal = (code: string, status: number) => (error: unknown) => error instanceof DataGovernanceError && error.code === code && error.status === status;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const rightsRows = [{ resource_type: "fund", resource_id: "fund-a" }, { resource_type: "document", resource_id: "doc-a" }, { resource_type: "document", resource_id: "doc-extra" }];
const isRights = (sql: string) => /tenant_export_rights/.test(sql);

function backend(db: FakeDb, objectStore: { getObjectStream(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string; contentLength?: string } | null> } = { async getObjectStream() { return null; } }) {
  return new PostgresTenantExportBackend(() => db, () => objectStore);
}

test("ids are validated as UUIDs", () => {
  assert.equal(isUuid(REQUEST), true);
  assert.equal(isUuid("not-a-uuid"), false);
});

test("a row becomes a request with the status, the viewer's own flag and the actions the viewer may take", () => {
  const pending = toTenantExportRequest(row(), identity());
  assert.equal(pending.status, "pending_approval");
  assert.equal(pending.requestedByMe, true);
  assert.deepEqual(pending.actions, { canApprove: false, canReject: false, canCancel: true, canDownload: false });
  assert.equal(pending.artifact, null);
  assert.equal("history" in pending, false);

  const forColleague = toTenantExportRequest(row(), morgan);
  assert.equal(forColleague.requestedByMe, false);
  assert.deepEqual(forColleague.actions, { canApprove: true, canReject: true, canCancel: false, canDownload: false });
  assert.equal(toTenantExportRequest(row(), identity({ authMethod: "saml" })).requestedByMe, false, "the same subject text under another auth method is a different person");

  const lapsed = toTenantExportRequest(row({ approval_lapsed: true }), morgan);
  assert.equal(lapsed.status, "expired");
  assert.equal(lapsed.actions.canApprove, false);
  assert.equal(toTenantExportRequest(row({ approval_lapsed: "true" }), morgan).status, "expired");

  const complete = toTenantExportRequest(completeRow(), morgan, [{ eventType: "approved", fromState: "pending_approval", toState: "approved", actor: "idp|morgan", note: null, at: "t" }]);
  assert.equal(complete.status, "complete");
  assert.equal(complete.decidedBy, "idp|morgan");
  assert.deepEqual(complete.artifact, { checksumSha256: "a".repeat(64), sizeBytes: 4694, expiresAt: "2026-10-04 10:00:00+00", manifest: publicManifest });
  assert.equal("artifact" in complete.artifact!.manifest, false, "the internal artifact scope never reaches a client");
  assert.equal(complete.actions.canDownload, true);
  assert.equal(complete.history?.length, 1);
  assert.equal(toTenantExportRequest(completeRow({ download_available: false }), morgan).status, "download_expired");
  // A manifest that arrives as JSON text (a driver that does not parse jsonb) is read the same way.
  assert.deepEqual(toTenantExportRequest(completeRow({ manifest: JSON.stringify(storedManifest) }), morgan).artifact!.manifest, publicManifest);
  assert.deepEqual(toTenantExportRequest(completeRow({ manifest: "not json" }), morgan).artifact!.manifest, {});
  assert.deepEqual(toTenantExportRequest(completeRow({ manifest: [1] }), morgan).artifact!.manifest, {});

  const cancelled = toTenantExportRequest(row({ state: "cancelled", cancelled_at: "2026-10-01 12:00:00+00" }), identity());
  assert.equal(cancelled.cancelledAt, "2026-10-01 12:00:00+00");
  assert.equal(cancelled.status, "cancelled");
});

test("the artifact scope is read from the stored manifest and tolerates anything else", () => {
  assert.deepEqual(artifactScope(storedManifest), { fundIds: ["fund-a"], documentIds: ["doc-a"] });
  assert.deepEqual(artifactScope(JSON.stringify(storedManifest)), { fundIds: ["fund-a"], documentIds: ["doc-a"] });
  assert.deepEqual(artifactScope({ artifact: { fundIds: [1, "f"], documentIds: "nope" } }), { fundIds: ["1", "f"], documentIds: [] });
  assert.deepEqual(artifactScope(null), { fundIds: [], documentIds: [] });
  assert.deepEqual(artifactScope({ artifact: "nope" }), { fundIds: [], documentIds: [] });
});

test("the audit event carries identifiers and the status, attributed to the acting admin", () => {
  const event = tenantExportAuditEvent(identity(), "corr-1", "data_export.requested", { requestId: REQUEST, status: "pending_approval" }, { reason: "Records review" });
  assert.deepEqual(
    { ...event, id: "x", occurredAt: "t" },
    {
      id: "x", occurredAt: "t", tenantId: TENANT, workspaceId: WORKSPACE, actorSubject: "idp|alex", sessionId: "session-1", action: "data_export.requested",
      targetType: "tenant_export_request", targetId: REQUEST, outcome: "success", correlationId: "corr-1", metadata: { status: "pending_approval", reason: "Records review" },
    },
  );
  assert.deepEqual(tenantExportAuditEvent(identity(), "c", "a", { requestId: REQUEST, status: "complete" }).metadata, { status: "complete" });
});

test("requesting calls the SQL function with the caller's tenant, identity and the approval window, never anything from the client", async () => {
  const db = new FakeDb(() => [row()]);
  const created = await backend(db).request(identity(), { reason: "Records review" });
  assert.equal(created.status, "pending_approval");
  assert.equal(created.requestedByMe, true);
  const call = db.calls[0]!;
  assert.match(call.sql, /corvis_control\.request_tenant_export\(/);
  assert.equal(call.parameters[0], TENANT);
  assert.match(String(call.parameters[1]), /^[0-9a-f-]{36}$/);
  assert.deepEqual([call.parameters[2], call.parameters[3], call.parameters[4], call.parameters[5], call.parameters[6]], [WORKSPACE, "oidc", "idp|alex", "Records review", 168]);
});

test("a malformed workspace, and a concurrent request that loses the race, are client errors", async () => {
  await assert.rejects(() => backend(new FakeDb()).request(identity({ workspaceId: "workspace_demo" }), { reason: "Records review" }), refusal("invalid_request", 400));
  const raced = new FakeDb(() => { throw Object.assign(new Error("duplicate key"), { code: "23505" }); });
  await assert.rejects(() => backend(raced).request(identity(), { reason: "Records review" }), refusal("data_export_already_active", 409));
  const broken = new FakeDb(() => { throw new Error("connection reset"); });
  await assert.rejects(() => backend(broken).request(identity(), { reason: "Records review" }), /connection reset/);
  const odd = new FakeDb(() => { throw null; });
  await assert.rejects(() => backend(odd).request(identity(), { reason: "Records review" }), (error) => error === null);
});

test("listing is tenant-scoped, newest first and bounded", async () => {
  const db = new FakeDb(() => [row(), completeRow({ request_id: "9f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f" })]);
  const items = await backend(db).list(morgan);
  assert.equal(items.length, 2);
  assert.match(db.calls[0]!.sql, /where r\.tenant_id = \$1::uuid order by r\.requested_at desc, r\.request_id desc limit 50/);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT]);
});

test("one request is read with its history; a missing or malformed id is the same 404", async () => {
  const db = new FakeDb((sql) => /tenant_export_request_event/.test(sql)
    ? [{ event_type: "requested", from_state: null, to_state: "pending_approval", actor_subject: "idp|alex", note: null, occurred_at: "2026-10-01 10:00:00+00" },
      { event_type: "approved", from_state: "pending_approval", to_state: "approved", actor_subject: "idp|morgan", note: "ok", occurred_at: "2026-10-01 11:00:00+00" }]
    : [row()]);
  const item = await backend(db).get(identity(), REQUEST);
  assert.deepEqual(item.history, [
    { eventType: "requested", fromState: null, toState: "pending_approval", actor: "idp|alex", note: null, at: "2026-10-01 10:00:00+00" },
    { eventType: "approved", fromState: "pending_approval", toState: "approved", actor: "idp|morgan", note: "ok", at: "2026-10-01 11:00:00+00" },
  ]);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, REQUEST]);
  await assert.rejects(() => backend(db).get(identity(), "not-a-uuid"), refusal("data_export_not_found", 404));
  await assert.rejects(() => backend(new FakeDb()).get(identity(), REQUEST), refusal("data_export_not_found", 404));
});

test("a decision passes the actor and the guard to SQL, where independence is enforced; no row is a 404", async () => {
  const db = new FakeDb(() => [row({ state: "approved", decided_by_subject: "idp|morgan", decided_at: "2026-10-01 11:00:00+00" })]);
  const approved = await backend(db).decide(morgan, REQUEST, { action: "approve", note: "ok", expectedStatus: "pending_approval" });
  assert.equal(approved.status, "approved");
  assert.match(db.calls[0]!.sql, /corvis_control\.decide_tenant_export\(/);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT, REQUEST, "approve", "oidc", "idp|morgan", "ok", "pending_approval"]);
  await backend(db).decide(morgan, REQUEST, { action: "cancel" });
  assert.deepEqual(db.calls[1]!.parameters, [TENANT, REQUEST, "cancel", "oidc", "idp|morgan", null, null]);
  await assert.rejects(() => backend(db).decide(morgan, "nope", { action: "approve" }), refusal("data_export_not_found", 404));
  await assert.rejects(() => backend(new FakeDb()).decide(morgan, REQUEST, { action: "approve" }), refusal("data_export_not_found", 404));
});

test("a link is issued only for a downloadable export whose data is still redistributable, and is single-use and hashed at rest", async () => {
  const db = new FakeDb((sql) => isRights(sql) ? rightsRows : /insert into corvis_control\.tenant_export_download_grant/.test(sql) ? [{ expires_at: "2026-10-03 10:10:00+00" }] : [completeRow()]);
  const { request, download } = await backend(db).issueDownload(morgan, REQUEST);
  assert.equal(request.status, "complete");
  assert.equal(download.downloadExpiresAt, "2026-10-03 10:10:00+00");
  const url = new URL(download.downloadUrl, "https://corvis.test");
  assert.equal(url.pathname, `/api/v1/access/data-exports/${REQUEST}/download`);
  const token = url.searchParams.get("grant")!;
  assert.ok(token.length >= 43);
  const insert = db.calls.find((call) => /insert into corvis_control\.tenant_export_download_grant/.test(call.sql))!;
  assert.deepEqual(insert.parameters, [TENANT, REQUEST, "idp|morgan", sha(token), TENANT_EXPORT_LINK_MINUTES]);
  assert.match(insert.sql, /least\(r\.artifact_expires_at, now\(\) \+ make_interval\(mins => \$5\)\)/);
  assert.equal(JSON.stringify(db.calls).includes(token), false, "the token itself is never stored or logged in a query");
  assert.match(db.executed[0]!.sql, /delete from corvis_control\.tenant_export_download_grant[\s\S]*expires_at < now\(\) - interval '1 day'/);

  const second = await backend(db).issueDownload(morgan, REQUEST);
  assert.notEqual(second.download.downloadUrl, download.downloadUrl, "every link is fresh");
});

test("no link is issued for an export that is not complete, has lapsed, or whose data rights changed", async () => {
  await assert.rejects(() => backend(new FakeDb(() => [row()])).issueDownload(morgan, REQUEST), refusal("data_export_not_available", 409));
  await assert.rejects(() => backend(new FakeDb(() => [completeRow({ download_available: false })])).issueDownload(morgan, REQUEST), refusal("data_export_not_available", 409));
  await assert.rejects(() => backend(new FakeDb()).issueDownload(morgan, REQUEST), refusal("data_export_not_found", 404));
  const revoked = new FakeDb((sql) => isRights(sql) ? [{ resource_type: "fund", resource_id: "fund-a" }] : [completeRow()]);
  await assert.rejects(() => backend(revoked).issueDownload(morgan, REQUEST), refusal("data_export_rights_changed", 409));
  assert.equal(revoked.calls.some((call) => /insert into/.test(call.sql)), false, "nothing is issued when rights no longer cover the archive");
  // A right on the wrong resource type is no right: the fund id does not cover a document of the same text.
  const wrongType = new FakeDb((sql) => isRights(sql) ? [{ resource_type: "document", resource_id: "fund-a" }, { resource_type: "document", resource_id: "doc-a" }] : [completeRow()]);
  await assert.rejects(() => backend(wrongType).issueDownload(morgan, REQUEST), refusal("data_export_rights_changed", 409));
});

test("redeeming consumes the link in the statement that validates it, bound to tenant, request, subject and token hash", async () => {
  const db = new FakeDb((sql) => isRights(sql) ? rightsRows : [{ object_uri: "gs://bucket/exports/t/x.zip", checksum_sha256: "b".repeat(64), size_bytes: "99", manifest: storedManifest }]);
  const redeemed = await backend(db).redeemDownload(morgan, REQUEST, "token-1");
  assert.deepEqual(redeemed, { objectUri: "gs://bucket/exports/t/x.zip", checksumSha256: "b".repeat(64), sizeBytes: 99 });
  const update = db.calls[0]!;
  assert.match(update.sql, /update corvis_control\.tenant_export_download_grant g set consumed_at = now\(\)/);
  assert.match(update.sql, /g\.consumed_at is null/);
  assert.match(update.sql, /g\.expires_at > now\(\)/);
  assert.match(update.sql, /r\.state = 'complete' and r\.artifact_expires_at > now\(\)/);
  assert.deepEqual(update.parameters, [TENANT, REQUEST, "idp|morgan", sha("token-1")]);
});

test("a link that matches nothing, or is malformed, redeems to nothing and never reaches the database when malformed", async () => {
  const none = new FakeDb();
  assert.equal(await backend(none).redeemDownload(morgan, REQUEST, "token-1"), null);
  assert.equal(none.calls.length, 1);
  const untouched = new FakeDb();
  for (const [id, token] of [["nope", "token-1"], [REQUEST, ""], [REQUEST, "x".repeat(257)]] as const) assert.equal(await backend(untouched).redeemDownload(morgan, id, token), null);
  assert.equal(untouched.calls.length, 0);
});

test("a download is refused when the organization's data rights no longer cover the archive", async () => {
  const db = new FakeDb((sql) => isRights(sql) ? [{ resource_type: "fund", resource_id: "fund-a" }] : [{ object_uri: "gs://b/exports/x", checksum_sha256: "b".repeat(64), size_bytes: 1, manifest: storedManifest }]);
  await assert.rejects(() => backend(db).redeemDownload(morgan, REQUEST, "token-1"), refusal("data_export_rights_changed", 409));
});

test("the archive is streamed from the object store with its length when known", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
  const keys: string[] = [];
  const store = { async getObjectStream(key: string) { keys.push(key); return { body, contentType: "application/zip", contentLength: "3" }; } };
  const redeemed: RedeemedTenantExport = { objectUri: "gs://corvis-bucket/exports/t/x.zip", checksumSha256: "b".repeat(64), sizeBytes: 3 };
  process.env.CORVIS_OBJECT_STORE_BUCKET = "corvis-bucket";
  const stream = await backend(new FakeDb(), store).openArtifact(morgan, REQUEST, "token-1", redeemed);
  assert.deepEqual(keys, ["exports/t/x.zip"]);
  assert.deepEqual({ contentType: stream!.contentType, contentLength: stream!.contentLength }, { contentType: "application/zip", contentLength: "3" });
  assert.equal(stream!.body, body);

  const bare = { async getObjectStream() { return { body }; } };
  const without = await backend(new FakeDb(), bare).openArtifact(morgan, REQUEST, "token-1", redeemed);
  assert.deepEqual({ contentType: without!.contentType, hasLength: "contentLength" in without! }, { contentType: "application/zip", hasLength: false });
});

test("when no byte could be read the link is given back, and a failure to give it back never hides the cause", async () => {
  process.env.CORVIS_OBJECT_STORE_BUCKET = "corvis-bucket";
  const redeemed: RedeemedTenantExport = { objectUri: "gs://corvis-bucket/exports/t/x.zip", checksumSha256: "b".repeat(64), sizeBytes: 3 };
  const missing = new FakeDb();
  assert.equal(await backend(missing, { async getObjectStream() { return null; } }).openArtifact(morgan, REQUEST, "token-1", redeemed), null);
  assert.match(missing.executed[0]!.sql, /set consumed_at = null[\s\S]*consumed_at is not null and expires_at > now\(\)/);
  assert.deepEqual(missing.executed[0]!.parameters, [TENANT, REQUEST, "idp|morgan", sha("token-1")]);

  const failing = new FakeDb();
  const fault = new Error("object store down");
  await assert.rejects(() => backend(failing, { async getObjectStream() { throw fault; } }).openArtifact(morgan, REQUEST, "token-1", redeemed), (error) => error === fault);
  assert.equal(failing.executed.length, 1, "the link was restored");

  const cannotRestore = new FakeDb();
  cannotRestore.failExecute = () => true;
  await assert.rejects(() => backend(cannotRestore, { async getObjectStream() { throw fault; } }).openArtifact(morgan, REQUEST, "token-1", redeemed), (error) => error === fault);
  assert.equal(await backend(cannotRestore, { async getObjectStream() { return null; } }).openArtifact(morgan, REQUEST, "token-1", redeemed), null);
});

test("an object that is not under the exports prefix is never read", async () => {
  process.env.CORVIS_OBJECT_STORE_BUCKET = "corvis-bucket";
  const store = { async getObjectStream(): Promise<null> { throw new Error("must not be read"); } };
  await assert.rejects(
    () => backend(new FakeDb(), store).openArtifact(morgan, REQUEST, "token-1", { objectUri: "gs://corvis-bucket/uploads/secret.pdf", checksumSha256: "b".repeat(64), sizeBytes: 1 }),
    /invalid_export_object_uri/,
  );
});
