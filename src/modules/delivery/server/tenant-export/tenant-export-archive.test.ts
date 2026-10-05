import assert from "node:assert/strict";
import test from "node:test";
import type { TenantExportManifest, TenantExportProgress } from "../../domain/tenant-export.ts";
import {
  TENANT_EXPORT_DOCUMENT_PAGE,
  TENANT_EXPORT_PAGE_ROWS,
  TENANT_EXPORT_PROGRESS_INTERVAL_MS,
  TENANT_EXPORT_ROWS_PER_FILE,
  TenantExportLeaseLostError,
  TenantExportSourceIntegrityError,
  createTenantExportArchive,
  safeSourceFileName,
  sourceObjectKey,
  type TenantExportArchiveOptions,
} from "./tenant-export-archive.ts";
import { readStoredZip } from "../../../../test-support/zip-reader.ts";
import { BUCKET, FakeObjects, FakeTenantDb, TENANT, auditRow, claimedRow, documentRow, observationRow, sha256, uuid, type Script } from "../../../../test-support/tenant-export-fixtures.ts";

const NOW = Date.parse("2026-10-03T00:00:00.000Z");

async function drain(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

async function build(script: Script, options: TenantExportArchiveOptions = {}, objects = new FakeObjects()) {
  const db = new FakeTenantDb(script);
  objects.addDocuments(script.documents ?? []);
  const archive = createTenantExportArchive(claimedRow(), db, objects, { now: () => NOW, ...options });
  const bytes = await drain(archive.bytes);
  const entries = readStoredZip(bytes);
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as TenantExportManifest;
  return { db, objects, archive, bytes, entries, manifest, outcome: archive.outcome() };
}

const csvLines = (bytes: Buffer) => bytes.toString("utf8").split("\r\n").filter((line) => line.length > 0);
const names = (entries: Map<string, Buffer>) => [...entries.keys()];

test("the archive holds the data in numbered parts, the entitled source files, and a manifest that lists every file with its measured checksum", async () => {
  const pdfA = Buffer.from("%PDF-1.7 report one");
  const pdfB = Buffer.from("%PDF-1.7 report two, a little longer");
  const script: Script = {
    observations: [observationRow(1), observationRow(2, { value_number: null, version: null, report_date: null, instrument_id: 7, currency: "=cmd" })],
    audit: [auditRow(1), auditRow(2, { metadata: '{"a":1}' }), auditRow(3, { metadata: null, actor_subject: "=HYPERLINK(\"x\")" })],
    documents: [documentRow(1, pdfA), documentRow(2, pdfB, { display_name: "../../etc/passwd" })],
    coverage: { documents: 5, funds: 3, included_funds: 1 },
  };
  const { entries, manifest, outcome, bytes } = await build(script);

  assert.deepEqual(names(entries), [
    "README.txt",
    "published-data/observations-0001.csv",
    "access-audit/access-audit-0001.csv",
    "source-documents/inventory-0001.csv",
    `source-documents/files/${uuid("d0c00000", 1)}/Report 1.pdf`,
    `source-documents/files/${uuid("d0c00000", 2)}/_.._etc_passwd`,
    "manifest.json",
  ]);
  // The source files are the stored bytes, copied as they were.
  assert.ok(entries.get(`source-documents/files/${uuid("d0c00000", 1)}/Report 1.pdf`)!.equals(pdfA));
  assert.ok(entries.get(`source-documents/files/${uuid("d0c00000", 2)}/_.._etc_passwd`)!.equals(pdfB));

  // Every listed file verifies against the manifest, which does not list itself and is the last entry.
  assert.equal(manifest.manifestVersion, 2);
  assert.deepEqual(manifest.files.map((file) => file.path), names(entries).slice(0, -1));
  for (const file of manifest.files) {
    assert.equal(file.sha256, sha256(entries.get(file.path)!), `${file.path} checksum`);
    assert.equal(file.sizeBytes, entries.get(file.path)!.length, `${file.path} size`);
  }
  assert.deepEqual(manifest.files.map((file) => [file.dataset, file.rowCount]), [["readme", 0], ["observations", 2], ["access_audit", 3], ["source_inventory", 2], ["source_document", 0], ["source_document", 0]]);
  assert.deepEqual(manifest.files.filter((file) => file.documentId).map((file) => file.documentId), [uuid("d0c00000", 1), uuid("d0c00000", 2)]);
  assert.equal(manifest.fileCount, 6);
  assert.deepEqual(manifest.sourceFiles, { included: 2, excluded: 0, totalBytes: pdfA.length + pdfB.length });
  assert.deepEqual([manifest.requestId, manifest.tenantId, manifest.generatedAt, manifest.requestedBy, manifest.approvedBy], [claimedRow().request_id, TENANT, "2026-10-03T00:00:00.000Z", "idp|alex", "idp|morgan"]);
  assert.deepEqual(manifest.dataRights.funds, { included: 1, excluded: 2 });
  assert.deepEqual(manifest.dataRights.documents, { included: 2, excluded: 3 });
  assert.deepEqual(manifest.notIncluded, [], "every document that may be redistributed has its file in the archive");

  // The CSVs: numeric(38,10) stays exact, formulas are defused, and the audit filter is the one the admin already reads.
  const observations = entries.get("published-data/observations-0001.csv")!.toString("utf8");
  assert.match(observations, /125\.0000000000/);
  assert.match(observations, /'=cmd/);
  assert.match(entries.get("access-audit/access-audit-0001.csv")!.toString("utf8"), /'=HYPERLINK/);
  assert.match(entries.get("source-documents/inventory-0001.csv")!.toString("utf8"), /Report 1\.pdf/);

  // The scope an archive is re-checked against at download: funds, documents and the documents whose file it holds.
  assert.deepEqual(outcome.scope, { fundIds: ["fund-a", "fund-b"], documentIds: [uuid("d0c00000", 1), uuid("d0c00000", 2)], sourceDocumentIds: [uuid("d0c00000", 1), uuid("d0c00000", 2)] });
  assert.equal(outcome.manifest.files.length, 6);
  assert.equal(outcome.publicManifest.files.length, 4, "the API copy leaves out the individual source files");
  assert.ok(bytes.length > 0);
});

test("documents without source-file access, without a released file, or whose stored file has gone are counted, never listed", async () => {
  const kept = Buffer.from("kept");
  const script: Script = {
    documents: [
      documentRow(1, kept),
      documentRow(2, Buffer.from("no access"), { sourceAccess: false }),
      documentRow(3, Buffer.from("not released"), { released: false, object_uri: null, storage_generation: null }),
      documentRow(4, Buffer.from("gone"), { bytes: undefined }),
      documentRow(5, Buffer.from("elsewhere"), { object_uri: `gs://${BUCKET}/tenant=22222222-aaaa-4aaa-8aaa-222222222222/document=${uuid("d0c00000", 5)}/original.pdf` }),
      documentRow(6, Buffer.from("no generation"), { storage_generation: null }),
    ],
    coverage: { documents: 6, funds: 0, included_funds: 0 },
  };
  const { entries, manifest, objects } = await build(script);
  assert.deepEqual(names(entries).filter((name) => name.includes("/files/")), [`source-documents/files/${uuid("d0c00000", 1)}/Report 1.pdf`]);
  assert.deepEqual(manifest.sourceFiles, { included: 1, excluded: 5, totalBytes: kept.length });
  assert.equal(manifest.dataRights.documents.included, 6, "the inventory lists every document the organization may redistribute");
  assert.equal(manifest.notIncluded.length, 1);
  assert.match(manifest.notIncluded[0]!.reason, /^5 documents are listed in the inventory without their file/);
  // The stored file of the document with access but no object was asked for, pinned to its generation; the others were never read.
  assert.ok(objects.reads.some((read) => read.key.includes(uuid("d0c00000", 4)) && read.generation === "17"));
  assert.equal(objects.reads.some((read) => read.key.includes(uuid("d0c00000", 2))), false, "a file without source access is never read");
  // Left-out documents are counts, not names or ids.
  const text = JSON.stringify(manifest);
  for (const n of [2, 3, 5, 6]) assert.equal(text.includes(uuid("d0c00000", n)), false);

  const single = await build({ documents: [documentRow(1, kept), documentRow(2, kept, { sourceAccess: false })] });
  assert.match(single.manifest.notIncluded[0]!.reason, /^1 document is listed in the inventory without its file: source-file access is not granted for it,/);
});

test("a stored file that does not match its recorded size or checksum fails the build instead of being delivered", async () => {
  const good = Buffer.from("the real bytes");
  const tampered = documentRow(1, good, { bytes: Buffer.from("not what was uploaded") });
  await assert.rejects(build({ documents: [tampered] }), (error) => error instanceof TenantExportSourceIntegrityError && error.retryable === false && error.message.includes(uuid("d0c00000", 1)));
  // Same bytes in length, different content: only the checksum catches it.
  await assert.rejects(build({ documents: [documentRow(1, good, { bytes: Buffer.from("the fake  bytes") })] }), TenantExportSourceIntegrityError);
  // A wrong recorded size alone is a mismatch too, and a recorded value that was never set is not checked.
  await assert.rejects(build({ documents: [documentRow(1, good, { size_bytes: "3" })] }), TenantExportSourceIntegrityError);
  const unchecked = await build({ documents: [documentRow(1, good, { size_bytes: null, sha256: null })] });
  assert.equal(unchecked.manifest.sourceFiles!.included, 1);
  assert.equal(unchecked.manifest.files.find((file) => file.dataset === "source_document")!.sha256, sha256(good), "the manifest carries the measured checksum, not the recorded one");
});

test("a data set splits into parts at exactly the row limit: no row lost or repeated, no empty part left behind", async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, index) => observationRow(index + 1));
  const run = async (count: number) => {
    const { entries, manifest, db } = await build({ observations: rows(count) }, { rowsPerFile: 3, pageRows: 2 });
    const parts = names(entries).filter((name) => name.startsWith("published-data/"));
    return { entries, manifest, parts, db, lines: parts.map((name) => csvLines(entries.get(name)!)) };
  };

  // 7 rows: 3 + 3 + 1, every part with its own header, and the parts concatenate to exactly the rows in order.
  const seven = await run(7);
  assert.deepEqual(seven.parts, ["published-data/observations-0001.csv", "published-data/observations-0002.csv", "published-data/observations-0003.csv"]);
  assert.deepEqual(seven.lines.map((lines) => lines.length - 1), [3, 3, 1]);
  for (const lines of seven.lines) assert.match(lines[0]!, /^observation_id,fund_id,/);
  assert.deepEqual(seven.lines.flatMap((lines) => lines.slice(1).map((line) => line.split(",")[0])), rows(7).map((row) => row.observation_id));
  assert.deepEqual(seven.manifest.files.filter((file) => file.dataset === "observations").map((file) => file.rowCount), [3, 3, 1]);

  // 6 rows: exactly two full parts, and no empty third part.
  const six = await run(6);
  assert.deepEqual(six.parts, ["published-data/observations-0001.csv", "published-data/observations-0002.csv"]);
  assert.deepEqual(six.lines.map((lines) => lines.length - 1), [3, 3]);

  // 3 rows: one full part. 2 rows: one short part. 0 rows: one part holding only the header.
  assert.deepEqual((await run(3)).lines.map((lines) => lines.length - 1), [3]);
  assert.deepEqual((await run(2)).lines.map((lines) => lines.length - 1), [2]);
  const none = await run(0);
  assert.deepEqual(none.lines.map((lines) => lines.length - 1), [0]);
  assert.equal(none.manifest.files.find((file) => file.path === "published-data/observations-0001.csv")!.rowCount, 0);
});

test("pages are read by keyset: each page starts strictly after the last row of the previous one, a page never crosses a part, and nothing is counted twice", async () => {
  const observations = Array.from({ length: 7 }, (_, index) => observationRow(index + 1));
  const { db } = await build({ observations }, { rowsPerFile: 3, pageRows: 2 });
  const pages = db.calls.filter((call) => /with entitled_fund/.test(call.sql) && /order by o\.observation_id limit \$3/.test(call.sql));
  // Part 1: 2 rows (asks 3), then 1 row (asks 2). Part 2 the same. Part 3: the last row (asks 3).
  assert.deepEqual(pages.map((call) => [call.parameters[1], call.parameters[2]]), [
    [null, 3], [observations[1]!.observation_id, 2],
    [observations[2]!.observation_id, 3], [observations[4]!.observation_id, 2],
    [observations[5]!.observation_id, 3],
  ]);
  for (const call of pages) assert.equal(call.parameters[0], TENANT);
  assert.match(pages[0]!.sql, /\$2::uuid is null or fact_observation\.observation_id > \$2::uuid/, "the cursor is applied before the join, so a page does not re-read earlier rows");
  assert.match(pages[0]!.sql, /o\.review_state = 'approved'/);
  assert.match(pages[0]!.sql, /s\.status = 'published'/);
  assert.match(pages[0]!.sql, /tenant_export_rights\(\$1::uuid\)/, "rights are read inside the statement, never passed as a list of ids");

  const audit = Array.from({ length: 5 }, (_, index) => auditRow(index + 1));
  const auditRun = await build({ audit }, { rowsPerFile: 4, pageRows: 2 });
  const auditPages = auditRun.db.calls.filter((call) => /from corvis_control\.audit_event/.test(call.sql) && /limit \$4/.test(call.sql));
  assert.deepEqual(auditPages.map((call) => call.parameters.slice(1)), [
    [null, null, 3], [audit[1]!.cursor_at, audit[1]!.cursor_id, 3],
    [audit[3]!.cursor_at, audit[3]!.cursor_id, 3],
  ].slice(0, auditPages.length));
  assert.deepEqual(names(auditRun.entries).filter((name) => name.startsWith("access-audit/")), ["access-audit/access-audit-0001.csv", "access-audit/access-audit-0002.csv"]);
  const { TENANT_ACCESS_AUDIT_FILTER } = await import("../../../identity-access/server/tenants/tenant-admin-self-service.ts");
  assert.ok(auditPages[0]!.sql.includes(TENANT_ACCESS_AUDIT_FILTER), "the audit file is exactly what the admin could already read");
  assert.match(TENANT_ACCESS_AUDIT_FILTER, /action like 'data_export\.%'/);
  assert.match(auditPages[0]!.sql, /to_char\(occurred_at at time zone 'UTC'/, "the cursor keeps microseconds so rows sharing a millisecond are not skipped or repeated");
});

test("source documents are read a page at a time with the rights evaluated again for every page", async () => {
  const documents = Array.from({ length: 5 }, (_, index) => documentRow(index + 1, Buffer.from(`file ${index + 1}`)));
  const { db, entries, manifest } = await build({ documents }, { documentPage: 2 });
  const pages = db.calls.filter((call) => /source_document_access_allowed and/.test(call.sql));
  assert.deepEqual(pages.map((call) => [call.parameters[1], call.parameters[2]]), [[null, 2], [documents[1]!.document_id, 2], [documents[3]!.document_id, 2]]);
  assert.match(pages[0]!.sql, /tenant_export_rights\(\$1::uuid\) r/);
  assert.match(pages[0]!.sql, /r\.source_document_access_allowed/);
  assert.match(pages[0]!.sql, /malware_scan_status = 'clean' and av\.quarantine_status = 'released' and av\.storage_generation is not null/, "only a released, clean file is ever copied");
  assert.equal(names(entries).filter((name) => name.includes("/files/")).length, 5);
  assert.equal(manifest.sourceFiles!.included, 5);
  // An exact multiple of the page asks once more and finds nothing.
  const exact = await build({ documents: documents.slice(0, 4) }, { documentPage: 2 });
  assert.equal(exact.db.calls.filter((call) => /source_document_access_allowed and/.test(call.sql)).length, 3);
  assert.equal(TENANT_EXPORT_DOCUMENT_PAGE, 100);
});

test("source file names are made safe to unpack anywhere, and only this tenant's own pinned objects are read", () => {
  assert.equal(safeSourceFileName("Q2 report (final).pdf"), "Q2 report (final).pdf");
  assert.equal(safeSourceFileName("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(safeSourceFileName("a\\b:c*d?.pdf"), "a_b_c_d_.pdf");
  assert.equal(safeSourceFileName("..."), "document");
  assert.equal(safeSourceFileName("   "), "document");
  assert.equal(safeSourceFileName(null), "document");
  assert.equal(safeSourceFileName("name. "), "name");
  assert.equal(safeSourceFileName("\u0000\u0007"), "_");
  assert.equal([...safeSourceFileName("é".repeat(300))].length, 120);

  const document = uuid("d0c00000", 1);
  const uri = `gs://${BUCKET}/tenant=${TENANT}/document=${document}/original.pdf`;
  assert.equal(sourceObjectKey(BUCKET, TENANT, document, uri, "17"), `tenant=${TENANT}/document=${document}/original.pdf`);
  assert.equal(sourceObjectKey(BUCKET, TENANT, document, uri, null), null, "no generation: the bytes are not pinned");
  assert.equal(sourceObjectKey(BUCKET, TENANT, document, uri, ""), null);
  assert.equal(sourceObjectKey(BUCKET, TENANT, document, `gs://other/tenant=${TENANT}/document=${document}/x`, "1"), null);
  assert.equal(sourceObjectKey(BUCKET, TENANT, document, `gs://${BUCKET}/tenant=${TENANT}/document=${uuid("d0c00000", 2)}/x`, "1"), null, "another document's object");
  assert.equal(sourceObjectKey(BUCKET, TENANT, document, `gs://${BUCKET}/tenant=${TENANT}/document=${document}/../../secret`, "1"), null);
  assert.equal(sourceObjectKey(BUCKET, TENANT, document, null, "1"), null);
});

test("the build reports an estimate before writing and its progress as it goes, and each report is the heartbeat", async () => {
  const reports: TenantExportProgress[] = [];
  let clock = NOW;
  const script: Script = {
    observations: [observationRow(1), observationRow(2)],
    audit: [auditRow(1)],
    documents: [documentRow(1, Buffer.alloc(1000, 1)), documentRow(2, Buffer.alloc(3000, 2), { sourceAccess: false })],
  };
  const { entries } = await build(script, {
    now: () => (clock += 1000),
    progressIntervalMs: 1,
    onProgress: async (progress) => { reports.push(progress); return true; },
  });
  assert.ok(entries.size > 0);
  const first = reports[0]!;
  assert.equal(first.phase, "estimating");
  // The estimate: 2 observations + 1 audit event + 2 inventory rows at 256 bytes each, plus the 1000 bytes of the one file that will be copied.
  assert.deepEqual([first.estimatedRows, first.estimatedDocuments, first.estimatedBytes, first.bytesWritten], [5, 1, 5 * 256 + 1000, 0]);
  assert.deepEqual([...new Set(reports.map((report) => report.phase))].slice(0, 1), ["estimating"]);
  assert.equal(reports.at(-1)!.phase, "finalizing");
  const last = reports.at(-1)!;
  assert.equal(last.phase, "finalizing");
  assert.deepEqual([last.rowsWritten, last.documentsWritten], [5, 1]);
  assert.ok(last.bytesWritten >= 1000);
  assert.ok(last.percent >= 0 && last.percent <= 99, "never 100 before the request is complete");
  for (let index = 1; index < reports.length; index += 1) assert.ok(reports[index]!.bytesWritten >= reports[index - 1]!.bytesWritten, "progress only moves forward");
  assert.match(last.updatedAt, /^2026-10-03T00:00:\d{2}\.000Z$/);
});

test("progress is throttled to the interval, but the estimate and the final report are always sent", async () => {
  let calls = 0;
  const frozen = () => NOW;
  await build({ observations: [observationRow(1)], documents: [documentRow(1, Buffer.alloc(100))] }, { now: frozen, progressIntervalMs: 15_000, onProgress: async () => { calls += 1; return true; } });
  assert.equal(calls, 2, "the estimate, then the finalizing report; nothing in between at a frozen clock");
  assert.equal(TENANT_EXPORT_PROGRESS_INTERVAL_MS, 15_000);
  assert.equal(TENANT_EXPORT_ROWS_PER_FILE, 100_000);
  assert.equal(TENANT_EXPORT_PAGE_ROWS, 5_000);
});

test("a build that finds its lease lost to another attempt stops writing", async () => {
  const db = new FakeTenantDb({ observations: [observationRow(1)] });
  const archive = createTenantExportArchive(claimedRow(), db, new FakeObjects(), { now: () => NOW, onProgress: async () => false });
  await assert.rejects(drain(archive.bytes), (error) => error instanceof TenantExportLeaseLostError);
  assert.throws(() => archive.outcome(), /not been fully written/);
  assert.equal(db.calls.some((call) => /with entitled_fund/.test(call.sql) && /limit \$3/.test(call.sql)), false, "no data was read once the lease was gone");
});

test("a build with no progress sink still builds, and the outcome is unavailable until the archive is fully written", async () => {
  const db = new FakeTenantDb({});
  const archive = createTenantExportArchive(claimedRow(), db, new FakeObjects());
  assert.throws(() => archive.outcome(), /not been fully written/);
  const entries = readStoredZip(await drain(archive.bytes));
  assert.deepEqual(names(entries), ["README.txt", "published-data/observations-0001.csv", "access-audit/access-audit-0001.csv", "source-documents/inventory-0001.csv", "manifest.json"]);
  assert.equal(archive.outcome().manifest.manifestVersion, 2);
});

test("memory stays bounded however large the source files are: the archive is pulled through one chunk at a time", async () => {
  const chunkBytes = 64 * 1024;
  const chunks = 640; // 40 MiB per document, never materialized
  const documents = [1, 2].map((n) => documentRow(n, Buffer.alloc(0), { size_bytes: null, sha256: null }));
  let produced = 0;
  let consumed = 0;
  let peakAhead = 0;
  const objects = new FakeObjects();
  objects.keepBytes = false;
  objects.getObjectStream = async () => {
    const chunk = Buffer.alloc(chunkBytes, 7);
    let sent = 0;
    return { contentType: "application/pdf", body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === chunks) { controller.close(); return; }
        sent += 1;
        produced += chunkBytes;
        peakAhead = Math.max(peakAhead, produced - consumed);
        controller.enqueue(new Uint8Array(chunk));
      },
    }, { highWaterMark: 0 }) };
  };
  const original = objects.putObjectStream.bind(objects);
  objects.putObjectStream = async (key, source, contentType) => original(key, (async function* () { for await (const piece of source) { consumed += piece.length; yield piece; } })(), contentType);
  const db = new FakeTenantDb({ documents });
  const archive = createTenantExportArchive(claimedRow(), db, objects, { now: () => NOW });
  const result = await objects.putObjectStream("exports/k", archive.bytes, "application/zip");
  const total = 2 * chunks * chunkBytes;
  assert.ok(result.sizeBytes > total, "all 80 MiB of source files went through the archive");
  assert.ok(peakAhead <= 3 * chunkBytes, `the producer was never more than a few chunks ahead of the upload (peak ${peakAhead} bytes of ${total})`);
  assert.ok(objects.maxPiece <= chunkBytes + 1024, "no piece larger than a stream chunk (plus a header) was ever assembled");
  assert.equal(archive.outcome().manifest.sourceFiles!.totalBytes, total);
});
