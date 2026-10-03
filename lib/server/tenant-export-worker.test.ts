import assert from "node:assert/strict";
import test from "node:test";
import type { TenantExportManifest } from "../../core/tenant-export.ts";
import { ExportRowLimitError } from "./export-renderer.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { readStoredZip } from "./test-support/zip-reader.ts";
import { buildTenantExportArtifact, processApprovedTenantExports, tenantExportObjectKey } from "./tenant-export-worker.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const REQUEST = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const NOW = Date.parse("2026-10-03T00:00:00.000Z");

const claimedRow = (attempt = 1): PostgresRow => ({ tenant_id: TENANT, request_id: REQUEST, build_attempts: attempt, requested_by_subject: "idp|alex", decided_by_subject: "idp|morgan" });

type Call = { sql: string; parameters: PostgresPrimitive[] };
type Handlers = {
  claims?: PostgresRow[];
  rights?: PostgresRow[];
  observations?: PostgresRow[];
  inventory?: PostgresRow[];
  audit?: PostgresRow[];
  coverage?: PostgresRow;
  completed?: PostgresRow[];
  failWith?: Error;
  failOn?: RegExp;
};
class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  private readonly claims: PostgresRow[];
  private readonly h: Handlers;
  constructor(h: Handlers = {}) { this.h = h; this.claims = [...(h.claims ?? [])]; }
  async query(sql: string, parameters: PostgresPrimitive[] = []) {
    this.calls.push({ sql, parameters });
    if (this.h.failOn?.test(sql)) throw this.h.failWith ?? new Error("database fault");
    if (/claim_next_tenant_export_build/.test(sql)) return this.claims.splice(0, 1);
    if (/tenant_export_rights/.test(sql)) return this.h.rights ?? [];
    if (/with latest_snapshot/.test(sql)) return this.h.observations ?? [];
    if (/from corvis_source\.document d/.test(sql)) return this.h.inventory ?? [];
    if (/from corvis_control\.audit_event/.test(sql)) return this.h.audit ?? [];
    if (/included_funds/.test(sql)) return [this.h.coverage ?? { documents: 0, funds: 0, included_funds: 0 }];
    if (/complete_tenant_export_build/.test(sql)) return this.h.completed ?? [{ request_id: REQUEST }];
    if (/fail_tenant_export_build/.test(sql)) return [{ request_id: REQUEST }];
    return [];
  }
  async execute() {}
  async health() { return true; }
}

class FakeObjects {
  readonly bucket = "corvis-bucket";
  readonly puts = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly deleted: string[] = [];
  failPut?: Error;
  failDelete = false;
  async putObject(key: string, bytes: Buffer, contentType: string) {
    if (this.failPut) throw this.failPut;
    this.puts.set(key, { bytes, contentType });
  }
  async deleteObject(key: string) {
    this.deleted.push(key);
    if (this.failDelete) throw new Error("delete failed");
  }
}

const observation = (overrides: PostgresRow = {}): PostgresRow => ({
  observation_id: "o1", fund_id: "fund-a", company_id: "c1", holding_id: "h1", instrument_id: null, metric_code: "revenue", value_number: "125.0000000000",
  value_string: null, currency: "USD", economic_period: "LTM", report_date: new Date("2026-06-30T00:00:00.000Z"), review_state: "approved", source_reference_id: "s1",
  document_id: "doc-a", version: "3", updated_at: "2026-09-01 10:00:00+00", ...overrides,
});

const fullHandlers = (): Handlers => ({
  claims: [claimedRow()],
  rights: [{ resource_type: "fund", resource_id: "fund-a" }, { resource_type: "document", resource_id: "doc-a" }, { resource_type: "document", resource_id: "doc-b" }],
  observations: [observation(), observation({ observation_id: "o2", value_number: null, version: null, report_date: null, instrument_id: 7, currency: "=cmd" })],
  inventory: [
    { document_id: "doc-a", display_name: "Q2 report.pdf", media_type: "application/pdf", status: "published", created_at: "2026-08-01 10:00:00+00", size_bytes: "1024", sha256: "ab".repeat(32) },
    { document_id: "doc-b", display_name: "Notes.xlsx", media_type: "application/vnd.ms-excel", status: "published", created_at: "2026-08-02 10:00:00+00", size_bytes: null, sha256: null },
  ],
  audit: [
    { occurred_at: "2026-09-02 10:00:00+00", actor_subject: "idp|alex", action: "data_export.requested", workspace_id: "ws", target_type: "tenant_export_request", target_id: REQUEST, outcome: "success", metadata: { status: "pending_approval" } },
    { occurred_at: "2026-09-03 10:00:00+00", actor_subject: "=HYPERLINK(\"x\")", action: "access.member.role_changed", workspace_id: null, target_type: "membership", target_id: "m", outcome: "success", metadata: '{"a":1}' },
    { occurred_at: "2026-09-04 10:00:00+00", actor_subject: "idp|x", action: "data_issue.report", workspace_id: null, target_type: "data_issue_case", target_id: "d", outcome: "success", metadata: null },
  ],
  coverage: { documents: 5, funds: 3, included_funds: 1 },
});

test("object keys sit under the exports prefix, per request and attempt", () => {
  assert.equal(tenantExportObjectKey(TENANT, REQUEST, 2), `exports/${TENANT}/tenant-export-${REQUEST}/attempt-2/corvis-tenant-export.zip`);
});

test("the archive holds only redistributable data, the audit trail and the inventory, and counts what it leaves out", async () => {
  const db = new FakeDb(fullHandlers());
  const { bundle, scope } = await buildTenantExportArtifact(claimedRow(), db, () => NOW);
  const entries = readStoredZip(bundle.bytes);
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as TenantExportManifest;
  assert.deepEqual([manifest.requestId, manifest.tenantId, manifest.generatedAt, manifest.requestedBy, manifest.approvedBy], [REQUEST, TENANT, "2026-10-03T00:00:00.000Z", "idp|alex", "idp|morgan"]);
  assert.deepEqual(manifest.files.map((file) => [file.path, file.rowCount]), [
    ["README.txt", 0], ["published-data/observations.csv", 2], ["access-audit/access-audit.csv", 3], ["source-documents/inventory.csv", 2],
  ]);
  assert.deepEqual(manifest.dataRights.funds, { included: 1, excluded: 2 });
  assert.deepEqual(manifest.dataRights.documents, { included: 2, excluded: 3 });
  assert.match(manifest.notIncluded[0]!.item, /Source document files/);
  assert.deepEqual(scope, { fundIds: ["fund-a"], documentIds: ["doc-a", "doc-b"] });

  const observations = entries.get("published-data/observations.csv")!.toString("utf8");
  assert.match(observations, /125\.0000000000/, "numeric(38,10) stays a decimal string");
  assert.match(observations, /'=cmd/, "text that looks like a formula is defused");
  const audit = entries.get("access-audit/access-audit.csv")!.toString("utf8");
  assert.match(audit, /'=HYPERLINK/);
  assert.match(audit, /data_export\.requested/);
  assert.match(entries.get("source-documents/inventory.csv")!.toString("utf8"), /Q2 report\.pdf/);

  // Every query is scoped to the claimed tenant, and the data queries to the rights the SQL function returned.
  const dataCalls = db.calls.filter((call) => !/tenant_export_rights/.test(call.sql));
  for (const call of dataCalls) assert.equal(call.parameters[0], TENANT);
  const observationCall = db.calls.find((call) => /with latest_snapshot/.test(call.sql))!;
  assert.deepEqual([observationCall.parameters[1], observationCall.parameters[2]], [JSON.stringify(["fund-a"]), JSON.stringify(["doc-a", "doc-b"])]);
  assert.match(observationCall.sql, /o\.review_state = 'approved'/);
  assert.match(observationCall.sql, /s\.status = 'published'/);
});

test("with no redistribution right nothing but the audit trail is exported, and nothing is queried for funds or documents", async () => {
  const db = new FakeDb({ claims: [claimedRow()], audit: fullHandlers().audit, coverage: { documents: 4, funds: 2, included_funds: 0 } });
  const { bundle, scope } = await buildTenantExportArtifact(claimedRow(), db);
  const manifest = readStoredZip(bundle.bytes).get("manifest.json")!.toString("utf8");
  const parsed = JSON.parse(manifest) as TenantExportManifest;
  assert.deepEqual(parsed.files.map((file) => file.rowCount), [0, 0, 3, 0]);
  assert.deepEqual(parsed.dataRights, { ...parsed.dataRights, funds: { included: 0, excluded: 2 }, documents: { included: 0, excluded: 4 } });
  assert.deepEqual(scope, { fundIds: [], documentIds: [] });
  assert.equal(db.calls.some((call) => /with latest_snapshot|from corvis_source\.document d/.test(call.sql)), false);
  // Left-out counts can never go negative.
  const odd = await buildTenantExportArtifact(claimedRow(), new FakeDb({ coverage: { documents: 0, funds: 0, included_funds: 2 } }));
  assert.deepEqual((JSON.parse(readStoredZip(odd.bundle.bytes).get("manifest.json")!.toString("utf8")) as TenantExportManifest).dataRights.funds, { included: 2, excluded: 0 });
});

test("a file over the row cap fails the build with a non-retryable error instead of buffering without bound", async () => {
  const rows = Array.from({ length: 200_001 }, () => ({ occurred_at: "t", actor_subject: "a", action: "x", workspace_id: null, target_type: "t", target_id: "i", outcome: "success", metadata: {} }));
  await assert.rejects(() => buildTenantExportArtifact(claimedRow(), new FakeDb({ audit: rows })), (error) => error instanceof ExportRowLimitError && error.retryable === false);
  const manyObservations = Array.from({ length: 200_001 }, () => observation());
  await assert.rejects(() => buildTenantExportArtifact(claimedRow(), new FakeDb({ rights: fullHandlers().rights, observations: manyObservations })), ExportRowLimitError);
  const manyDocuments = Array.from({ length: 200_001 }, () => ({ document_id: "d" }));
  await assert.rejects(() => buildTenantExportArtifact(claimedRow(), new FakeDb({ rights: fullHandlers().rights, inventory: manyDocuments })), ExportRowLimitError);
});

test("a claimed request is built, stored under the exports prefix and completed with its checksum, size and manifest", async () => {
  const db = new FakeDb(fullHandlers());
  const objects = new FakeObjects();
  const result = await processApprovedTenantExports(5, { store: db, objectStore: objects, now: () => NOW });
  assert.deepEqual(result, { processed: 1, failed: 0 });
  const key = tenantExportObjectKey(TENANT, REQUEST, 1);
  const stored = objects.puts.get(key)!;
  assert.equal(stored.contentType, "application/zip");
  const complete = db.calls.find((call) => /complete_tenant_export_build/.test(call.sql))!;
  const [tenant, request, attempt, uri, expiresAt, checksum, size, manifestJson] = complete.parameters;
  assert.deepEqual([tenant, request, attempt, uri], [TENANT, REQUEST, 1, `gs://corvis-bucket/${key}`]);
  assert.equal(expiresAt, new Date(NOW + 24 * 60 * 60 * 1000).toISOString(), "the link lives as long as every other export artifact");
  assert.equal(size, stored.bytes.length);
  const { createHash } = await import("node:crypto");
  assert.equal(checksum, createHash("sha256").update(stored.bytes).digest("hex"));
  const manifest = JSON.parse(String(manifestJson)) as TenantExportManifest & { artifact: Record<string, unknown> };
  assert.deepEqual(manifest.artifact, { contentType: "application/zip", sizeBytes: stored.bytes.length, objectKey: key, fundIds: ["fund-a"], documentIds: ["doc-a", "doc-b"] });
  assert.deepEqual(db.calls.find((call) => /claim_next_tenant_export_build/.test(call.sql))!.parameters, [10, 5]);
  assert.equal(objects.deleted.length, 0);
});

test("an empty queue builds nothing, and the tick builds at most the limit", async () => {
  const idle = new FakeDb();
  assert.deepEqual(await processApprovedTenantExports(5, { store: idle, objectStore: new FakeObjects() }), { processed: 0, failed: 0 });
  assert.equal(idle.calls.length, 1);
  const busy = new FakeDb({ ...fullHandlers(), claims: [claimedRow(), claimedRow(), claimedRow()] });
  const result = await processApprovedTenantExports(2, { store: busy, objectStore: new FakeObjects(), now: () => NOW });
  assert.equal(result.processed, 2);
});

test("a retry cleans up the objects earlier attempts left, and a failure to clean up is ignored", async () => {
  const db = new FakeDb({ ...fullHandlers(), claims: [claimedRow(3)] });
  const objects = new FakeObjects();
  objects.failDelete = true;
  assert.deepEqual(await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW }), { processed: 1, failed: 0 });
  assert.deepEqual(objects.deleted, [tenantExportObjectKey(TENANT, REQUEST, 1), tenantExportObjectKey(TENANT, REQUEST, 2)]);
});

test("a stale attempt, whose lease was reclaimed, removes its own object and does not count as processed", async () => {
  const db = new FakeDb({ ...fullHandlers(), completed: [] });
  const objects = new FakeObjects();
  objects.failDelete = true;
  assert.deepEqual(await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW }), { processed: 0, failed: 0 });
  assert.deepEqual(objects.deleted, [tenantExportObjectKey(TENANT, REQUEST, 1)]);
});

test("a transient failure is recorded with a redacted message and a backoff, and its partial object is removed", async () => {
  const objects = new FakeObjects();
  objects.failPut = new Error("storage unavailable");
  objects.failDelete = true;
  const db = new FakeDb(fullHandlers());
  const result = await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW, random: () => 0.5 });
  assert.deepEqual(result, { processed: 0, failed: 1 });
  const fail = db.calls.find((call) => /fail_tenant_export_build/.test(call.sql))!;
  assert.deepEqual(fail.parameters.slice(0, 3), [TENANT, REQUEST, 1]);
  assert.match(String(fail.parameters[3]), /storage unavailable/);
  assert.equal(fail.parameters[4], false);
  assert.equal(fail.parameters[5], new Date(NOW + 60_000).toISOString(), "the first retry is a minute out (jitter at its midpoint)");
  assert.equal(fail.parameters[6], 5);
  assert.deepEqual(objects.deleted, [tenantExportObjectKey(TENANT, REQUEST, 1)]);
  assert.equal(db.calls.some((call) => /complete_tenant_export_build/.test(call.sql)), false);
});

test("a deterministic failure (the row cap) is permanent, and a failure with no object store configured still fails the request", async () => {
  const rows = Array.from({ length: 200_001 }, () => ({ occurred_at: "t", actor_subject: "a", action: "x", workspace_id: null, target_type: "t", target_id: "i", outcome: "success", metadata: {} }));
  const db = new FakeDb({ ...fullHandlers(), audit: rows });
  assert.deepEqual(await processApprovedTenantExports(1, { store: db, objectStore: new FakeObjects(), now: () => NOW }), { processed: 0, failed: 1 });
  assert.equal(db.calls.find((call) => /fail_tenant_export_build/.test(call.sql))!.parameters[4], true);

  // No injected store and no bucket configured: gcs() throws before any object exists, and the failure is still recorded.
  delete process.env.CORVIS_OBJECT_STORE_BUCKET;
  const unconfigured = new FakeDb({ claims: [claimedRow()] });
  assert.deepEqual(await processApprovedTenantExports(1, { store: unconfigured, now: () => NOW }), { processed: 0, failed: 1 });
  assert.equal(unconfigured.calls.some((call) => /fail_tenant_export_build/.test(call.sql)), true);
});

test("the default store, clock and randomness are used when none are injected", async () => {
  process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    seen.push((JSON.parse(String(init?.body)) as { sql: string }).sql);
    return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await processApprovedTenantExports(), { processed: 0, failed: 0 });
    assert.match(seen[0]!, /claim_next_tenant_export_build/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CORVIS_POSTGRES_DSN;
  }
});

test("a build is attributed through the database function that records and audits it, never by this module", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./tenant-export-worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /update corvis_control\.tenant_export_request|insert into corvis_control\.audit_event/i);
  assert.match(source, /claim_next_tenant_export_build[\s\S]*complete_tenant_export_build[\s\S]*fail_tenant_export_build/);
});

test("the access-audit file is exactly what the admin could already read, now including every export step", async () => {
  const { TENANT_ACCESS_AUDIT_FILTER } = await import("./tenant-admin-self-service.ts");
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /action like 'data_export\.%'/);
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /'tenant_export_request'/);
  const db = new FakeDb(fullHandlers());
  await buildTenantExportArtifact(claimedRow(), db);
  assert.ok(db.calls.find((call) => /from corvis_control\.audit_event/.test(call.sql))!.sql.includes(TENANT_ACCESS_AUDIT_FILTER));
});
