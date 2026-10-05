import assert from "node:assert/strict";
import test from "node:test";
import { TENANT_EXPORT_README, assembleTenantExportBundle, publicTenantExportManifest, sha256Hex, tenantExportReadme, type TenantExportBundleInput } from "./tenant-export-bundle.ts";
import { readStoredZip } from "./test-support/zip-reader.ts";

const input: TenantExportBundleInput = {
  requestId: "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f",
  tenantId: "11111111-aaaa-4aaa-8aaa-111111111111",
  generatedAt: "2026-10-03T00:00:00.000Z",
  requestedBy: "idp|alex",
  approvedBy: "idp|morgan",
  files: [
    { path: "published-data/observations-0001.csv", description: "Observations", bytes: Buffer.from("a,b\r\n1,2\r\n"), rowCount: 1, dataset: "observations" },
    { path: "access-audit/access-audit-0001.csv", description: "Audit", bytes: Buffer.from("when,what\r\n"), rowCount: 0, dataset: "access_audit" },
    { path: "source-documents/files/d1/Q2.pdf", description: "Source document Q2.pdf", bytes: Buffer.from("%PDF-1.7 fake"), rowCount: 0, dataset: "source_document", documentId: "d1" },
  ],
  dataRights: { basis: "rights basis", funds: { included: 2, excluded: 1 }, documents: { included: 3, excluded: 0 } },
  sourceFilesExcluded: 2,
  notIncluded: [{ item: "Source document files", reason: "Not for two documents." }],
};

test("the archive is a well-formed zip whose manifest is last and lists every other file with its size, rows and SHA-256", () => {
  const bundle = assembleTenantExportBundle(input);
  const entries = readStoredZip(bundle.bytes);
  assert.deepEqual([...entries.keys()], ["README.txt", "published-data/observations-0001.csv", "access-audit/access-audit-0001.csv", "source-documents/files/d1/Q2.pdf", "manifest.json"]);
  assert.equal(entries.get("README.txt")!.toString("utf8"), TENANT_EXPORT_README);
  assert.equal(tenantExportReadme().toString("utf8"), TENANT_EXPORT_README);

  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as typeof bundle.manifest;
  assert.deepEqual(manifest, bundle.manifest);
  assert.equal(manifest.manifestVersion, 2);
  assert.deepEqual([manifest.requestId, manifest.tenantId, manifest.generatedAt, manifest.requestedBy, manifest.approvedBy], [input.requestId, input.tenantId, input.generatedAt, "idp|alex", "idp|morgan"]);
  assert.deepEqual(manifest.files.map((file) => file.path), ["README.txt", "published-data/observations-0001.csv", "access-audit/access-audit-0001.csv", "source-documents/files/d1/Q2.pdf"]);
  for (const file of manifest.files) {
    const content = entries.get(file.path)!;
    assert.equal(file.sha256, sha256Hex(content), `${file.path} checksum`);
    assert.equal(file.sizeBytes, content.length, `${file.path} size`);
  }
  assert.deepEqual(manifest.files.map((file) => file.rowCount), [0, 1, 0, 0]);
  assert.deepEqual(manifest.files.map((file) => file.dataset), ["readme", "observations", "access_audit", "source_document"]);
  assert.equal(manifest.files[3]!.documentId, "d1");
  assert.equal("documentId" in manifest.files[1]!, false, "only a source document file names a document");
  assert.equal(manifest.fileCount, 4);
  assert.deepEqual(manifest.sourceFiles, { included: 1, excluded: 2, totalBytes: Buffer.byteLength("%PDF-1.7 fake") });
  assert.deepEqual(manifest.dataRights, input.dataRights);
  assert.deepEqual(manifest.notIncluded, input.notIncluded);
  assert.equal(manifest.files.some((file) => file.path === "manifest.json"), false, "a manifest cannot checksum itself");
});

test("the manifest the API returns leaves out the individual source document files and keeps the counts", () => {
  const { manifest } = assembleTenantExportBundle(input);
  const shown = publicTenantExportManifest(manifest);
  assert.deepEqual(shown.files.map((file) => file.dataset), ["readme", "observations", "access_audit"]);
  assert.equal(shown.fileCount, 4, "the archive's file count still includes the documents");
  assert.deepEqual(shown.sourceFiles, manifest.sourceFiles);
  assert.equal(manifest.files.length, 4, "the full manifest is untouched");
});

test("the archive's own checksum is the SHA-256 of its bytes, and the same input always assembles the same archive", () => {
  const first = assembleTenantExportBundle(input);
  const second = assembleTenantExportBundle(input);
  assert.equal(first.contentType, "application/zip");
  assert.equal(first.checksumSha256, sha256Hex(first.bytes));
  assert.equal(first.checksumSha256, second.checksumSha256);
  const changed = assembleTenantExportBundle({ ...input, files: [{ ...input.files[0]!, bytes: Buffer.from("a,b\r\n1,3\r\n") }, ...input.files.slice(1)] });
  assert.notEqual(changed.checksumSha256, first.checksumSha256);
});

test("the reader rejects a truncated or corrupted archive", () => {
  const bundle = assembleTenantExportBundle(input);
  assert.throws(() => readStoredZip(bundle.bytes.subarray(0, bundle.bytes.length - 5)), /end-of-central-directory/);
  assert.throws(() => readStoredZip(Buffer.alloc(3)), /end-of-central-directory/);
  const corrupted = Buffer.from(bundle.bytes);
  const at = corrupted.indexOf(Buffer.from("1,2"));
  corrupted[at] = 0x39;
  assert.throws(() => readStoredZip(corrupted), /fails its CRC-32/);
});
