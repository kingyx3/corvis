import assert from "node:assert/strict";
import test from "node:test";
import type { TenantExportManifest } from "../domain/tenant-export.ts";
import { TenantExportSourceIntegrityError } from "./tenant-export-archive.ts";
import { TENANT_EXPORT_BUILD_LEASE_MINUTES, processApprovedTenantExports, tenantExportObjectKey } from "./tenant-export-worker.ts";
import { readStoredZip } from "../../../test-support/zip-reader.ts";
import { BUCKET, FakeObjects, FakeTenantDb, REQUEST, TENANT, auditRow, claimedRow, documentRow, observationRow, sha256, uuid, type Script } from "../../../test-support/tenant-export-fixtures.ts";
import "../../../test-support/http-sql-driver.ts";

const NOW = Date.parse("2026-10-03T00:00:00.000Z");
const PDF = Buffer.from("%PDF-1.7 the source document");

const fullScript = (): Script => ({
  claims: [claimedRow()],
  observations: [observationRow(1), observationRow(2)],
  audit: [auditRow(1), auditRow(2)],
  documents: [documentRow(1, PDF), documentRow(2, Buffer.from("no source access"), { sourceAccess: false })],
  coverage: { documents: 5, funds: 3, included_funds: 1 },
});

function setup(script: Script) {
  const db = new FakeTenantDb(script);
  const objects = new FakeObjects();
  objects.addDocuments(script.documents ?? []);
  return { db, objects };
}
const completeCall = (db: FakeTenantDb) => db.calls.find((call) => /complete_tenant_export_build/.test(call.sql))!;
const failCall = (db: FakeTenantDb) => db.calls.find((call) => /fail_tenant_export_build/.test(call.sql))!;

test("object keys sit under the exports prefix, per request and attempt", () => {
  assert.equal(tenantExportObjectKey(TENANT, REQUEST, 2), `exports/${TENANT}/tenant-export-${REQUEST}/attempt-2/corvis-tenant-export.zip`);
});

test("a claimed request is streamed to the exports prefix and completed with the archive's checksum, size and manifest", async () => {
  const { db, objects } = setup(fullScript());
  const result = await processApprovedTenantExports(5, { store: db, objectStore: objects, now: () => NOW });
  assert.deepEqual(result, { processed: 1, failed: 0 });
  const key = tenantExportObjectKey(TENANT, REQUEST, 1);
  const stored = objects.puts.get(key)!;
  assert.equal(stored.contentType, "application/zip");

  const [tenant, request, attempt, uri, expiresAt, checksum, size, manifestJson] = completeCall(db).parameters;
  assert.deepEqual([tenant, request, attempt, uri], [TENANT, REQUEST, 1, `gs://${BUCKET}/${key}`]);
  assert.equal(expiresAt, new Date(NOW + 24 * 60 * 60 * 1000).toISOString(), "the link lives as long as every other export artifact");
  assert.equal(size, stored.bytes.length, "the size was measured on the way to the object store");
  assert.equal(checksum, sha256(stored.bytes), "and so was the checksum: it is the checksum of the bytes that were stored");

  // The archive that was stored holds the source file the organization may redistribute and a manifest that verifies it.
  const entries = readStoredZip(stored.bytes);
  const archiveManifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as TenantExportManifest;
  for (const file of archiveManifest.files) assert.equal(file.sha256, sha256(entries.get(file.path)!), file.path);
  assert.ok(entries.get(`source-documents/files/${uuid("d0c00000", 1)}/Report 1.pdf`)!.equals(PDF));
  assert.deepEqual(archiveManifest.sourceFiles, { included: 1, excluded: 1, totalBytes: PDF.length });

  // What is recorded with the request is the manifest without the individual source files, plus the internal scope.
  const manifest = JSON.parse(String(manifestJson)) as TenantExportManifest & { artifact: Record<string, unknown> };
  assert.equal(manifest.files.some((file) => file.dataset === "source_document"), false);
  assert.equal(manifest.fileCount, archiveManifest.fileCount);
  assert.deepEqual(manifest.artifact, {
    contentType: "application/zip", sizeBytes: stored.bytes.length, objectKey: key,
    fundIds: ["fund-a", "fund-b"], documentIds: [uuid("d0c00000", 1), uuid("d0c00000", 2)], sourceDocumentIds: [uuid("d0c00000", 1)],
  });
  assert.deepEqual(db.calls.find((call) => /claim_next_tenant_export_build/.test(call.sql))!.parameters, [10, 5]);
  assert.equal(objects.deleted.length, 0);
});

test("every statement of a build stands alone: no transaction is held open across it, and the build never writes request state itself", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["./tenant-export-worker.ts", "./tenant-export-archive.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.transaction\(|\bbegin\b\s*;|update corvis_control\.tenant_export_request|insert into corvis_control\.audit_event/i, file);
  }
  const worker = await readFile(new URL("./tenant-export-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /claim_next_tenant_export_build[\s\S]*complete_tenant_export_build[\s\S]*fail_tenant_export_build/);
  assert.match(worker, /record_tenant_export_build_progress/, "progress and the lease heartbeat go through the database function");
});

test("progress is reported through the database function bound to this attempt, which extends the lease", async () => {
  const script = { ...fullScript(), claims: [claimedRow(2)] };
  const { db, objects } = setup(script);
  await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW, archive: { progressIntervalMs: 0 } });
  const reports = db.calls.filter((call) => /record_tenant_export_build_progress/.test(call.sql));
  assert.ok(reports.length >= 3, "an estimate, progress and a closing report");
  for (const report of reports) assert.deepEqual([report.parameters[0], report.parameters[1], report.parameters[2], report.parameters[4]], [TENANT, REQUEST, 2, TENANT_EXPORT_BUILD_LEASE_MINUTES]);
  const first = JSON.parse(String(reports[0]!.parameters[3])) as { phase: string; estimatedRows: number; estimatedBytes: number; percent: number };
  assert.deepEqual([first.phase, first.estimatedRows, first.percent], ["estimating", 2 + 2 + 2, 0]);
  assert.ok(first.estimatedBytes > PDF.length);
  const last = JSON.parse(String(reports.at(-1)!.parameters[3])) as { phase: string; rowsWritten: number; documentsWritten: number };
  assert.deepEqual([last.phase, last.rowsWritten, last.documentsWritten], ["finalizing", 6, 1]);
});

test("a report that cannot be stored does not abandon a build that is moving, but a build that lost its lease stops and is not completed", async () => {
  const flaky = setup({ ...fullScript(), failAlways: { pattern: /record_tenant_export_build_progress/, error: new Error("database blip") } });
  assert.deepEqual(await processApprovedTenantExports(1, { store: flaky.db, objectStore: flaky.objects, now: () => NOW }), { processed: 1, failed: 0 });

  const lost = setup({ ...fullScript(), owned: false });
  const result = await processApprovedTenantExports(1, { store: lost.db, objectStore: lost.objects, now: () => NOW, random: () => 0.5 });
  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.equal(lost.db.calls.some((call) => /complete_tenant_export_build/.test(call.sql)), false);
  assert.match(String(failCall(lost.db).parameters[3]), /lease was lost/);
  assert.equal(failCall(lost.db).parameters[4], false, "losing the lease is not a permanent failure");
  assert.equal(lost.objects.puts.size, 0);
});

test("an empty queue builds nothing, and the tick builds at most the limit", async () => {
  const idle = new FakeTenantDb();
  assert.deepEqual(await processApprovedTenantExports(5, { store: idle, objectStore: new FakeObjects() }), { processed: 0, failed: 0 });
  assert.equal(idle.calls.length, 1);
  const busy = setup({ ...fullScript(), claims: [claimedRow(), claimedRow(), claimedRow()] });
  const result = await processApprovedTenantExports(2, { store: busy.db, objectStore: busy.objects, now: () => NOW });
  assert.equal(result.processed, 2);
});

test("a build above the old 200,000-row cap is exported completely, in parts listed in the manifest, with memory bounded by the page (F10c)", async () => {
  // 25 rows per file would be 8,000 parts at the real size; the boundary behaviour is what matters, and it is the same code.
  const observations = Array.from({ length: 23 }, (_, index) => observationRow(index + 1));
  const { db, objects } = setup({ claims: [claimedRow()], observations });
  assert.deepEqual(await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW, archive: { rowsPerFile: 10, pageRows: 4 } }), { processed: 1, failed: 0 });
  const stored = objects.puts.get(tenantExportObjectKey(TENANT, REQUEST, 1))!;
  const entries = readStoredZip(stored.bytes);
  const manifest = JSON.parse(String(completeCall(db).parameters[7])) as TenantExportManifest;
  const parts = manifest.files.filter((file) => file.dataset === "observations");
  assert.deepEqual(parts.map((file) => [file.path, file.rowCount]), [["published-data/observations-0001.csv", 10], ["published-data/observations-0002.csv", 10], ["published-data/observations-0003.csv", 3]]);
  const ids = parts.flatMap((file) => entries.get(file.path)!.toString("utf8").split("\r\n").slice(1).filter(Boolean).map((line) => line.split(",")[0]));
  assert.deepEqual(ids, observations.map((row) => row.observation_id), "every row exactly once, in order, across the parts");
  assert.equal(db.calls.some((call) => /EXPORT_MAX|row cap/i.test(call.sql)), false);
  assert.ok(objects.maxPiece < 64 * 1024, "the upload only ever saw small pieces");
});

test("a retry mid-build starts over from the first page and exports every row exactly once; the abandoned attempt's object is removed", async () => {
  const observations = Array.from({ length: 9 }, (_, index) => observationRow(index + 1));
  const script: Script = {
    claims: [claimedRow(1), claimedRow(2)],
    observations,
    // The database fails when the second page of observations is read, on the first attempt only.
    failOnce: { pattern: /with entitled_fund[\s\S]*order by o\.observation_id limit/, nth: 2, error: new Error("connection reset by peer") },
  };
  const { db, objects } = setup(script);
  const options = { store: db, objectStore: objects, now: () => NOW, random: () => 0.5, archive: { rowsPerFile: 4, pageRows: 2 } };

  // Attempt 1: some parts were already streamed when the fault hit. The failure is recorded as retryable, with a backoff.
  assert.deepEqual(await processApprovedTenantExports(1, options), { processed: 0, failed: 1 });
  assert.equal(db.calls.some((call) => /complete_tenant_export_build/.test(call.sql)), false);
  const failure = failCall(db);
  assert.deepEqual(failure.parameters.slice(0, 3), [TENANT, REQUEST, 1]);
  assert.match(String(failure.parameters[3]), /connection reset/);
  assert.equal(failure.parameters[4], false);
  assert.equal(failure.parameters[5], new Date(NOW + 60_000).toISOString(), "the first retry is a minute out (jitter at its midpoint)");
  assert.deepEqual(objects.deleted, [tenantExportObjectKey(TENANT, REQUEST, 1)], "the partial object is removed");
  assert.equal(objects.puts.size, 0);

  // Attempt 2 (claimed again after the backoff) rebuilds from the start: the keyset cursor lives in the attempt, never in the database.
  assert.deepEqual(await processApprovedTenantExports(1, options), { processed: 1, failed: 0 });
  const stored = objects.puts.get(tenantExportObjectKey(TENANT, REQUEST, 2))!;
  const entries = readStoredZip(stored.bytes);
  const ids = [...entries.keys()].filter((name) => name.startsWith("published-data/")).flatMap((name) => entries.get(name)!.toString("utf8").split("\r\n").slice(1).filter(Boolean).map((line) => line.split(",")[0]));
  assert.deepEqual(ids, observations.map((row) => row.observation_id));
  assert.deepEqual([completeCall(db).parameters[2], completeCall(db).parameters[5]], [2, sha256(stored.bytes)]);
  assert.ok(objects.deleted.filter((key) => key === tenantExportObjectKey(TENANT, REQUEST, 1)).length >= 1, "the first attempt's object stays removed");
});

test("a fault in the object store in the middle of the upload is retried the same way", async () => {
  const { db, objects } = setup({ ...fullScript() });
  objects.failPutAfterPieces = 3;
  objects.failDelete = true;
  assert.deepEqual(await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW, random: () => 0.5 }), { processed: 0, failed: 1 });
  assert.match(String(failCall(db).parameters[3]), /storage fault mid-write/);
  assert.equal(failCall(db).parameters[4], false);
  assert.deepEqual(objects.deleted, [tenantExportObjectKey(TENANT, REQUEST, 1)], "a failure to clean up is ignored");
});

test("a retry cleans up the objects earlier attempts left, and a failure to clean up is ignored", async () => {
  const { db, objects } = setup({ ...fullScript(), claims: [claimedRow(3)] });
  objects.failDelete = true;
  assert.deepEqual(await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW }), { processed: 1, failed: 0 });
  assert.deepEqual(objects.deleted, [tenantExportObjectKey(TENANT, REQUEST, 1), tenantExportObjectKey(TENANT, REQUEST, 2)]);
});

test("a stale attempt, whose lease was reclaimed, removes its own object and does not count as processed", async () => {
  const { db, objects } = setup({ ...fullScript(), completed: [] });
  objects.failDelete = true;
  assert.deepEqual(await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW }), { processed: 0, failed: 0 });
  assert.deepEqual(objects.deleted, [tenantExportObjectKey(TENANT, REQUEST, 1)]);
});

test("a source file that fails its recorded checksum fails permanently: retrying cannot help, and nothing is delivered", async () => {
  const { db, objects } = setup({ ...fullScript(), documents: [documentRow(1, PDF, { bytes: Buffer.from("%PDF-1.7 a different file!!!!") })] });
  assert.deepEqual(await processApprovedTenantExports(1, { store: db, objectStore: objects, now: () => NOW }), { processed: 0, failed: 1 });
  assert.equal(failCall(db).parameters[4], true);
  assert.match(String(failCall(db).parameters[3]), /does not match its recorded size or checksum/);
  assert.equal(objects.puts.size, 0);
  assert.equal(new TenantExportSourceIntegrityError("d").retryable, false);
});

test("a failure with no object store configured still fails the request", async () => {
  delete process.env.CORVIS_OBJECT_STORE_BUCKET;
  const unconfigured = new FakeTenantDb({ claims: [claimedRow()] });
  assert.deepEqual(await processApprovedTenantExports(1, { store: unconfigured, now: () => NOW }), { processed: 0, failed: 1 });
  assert.equal(unconfigured.calls.some((call) => /fail_tenant_export_build/.test(call.sql)), true);
});

test("the default store, clock and randomness are used when none are injected", async () => {
  process.env.CORVIS_DATABASE_DSN = "https://fake-postgres.test/sql";
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
    delete process.env.CORVIS_DATABASE_DSN;
  }
});
