import { createHash } from "node:crypto";
import type { TenantExportDataset, TenantExportFile, TenantExportManifest } from "../../domain/tenant-export.ts";
import { ZipStreamWriter } from "./zip-stream.ts";

/**
 * The pieces of the archive of a full tenant export (F10, #266; at scale F10b #322 and F10c #323) that do not depend on
 * where the data comes from: the README, the checksum manifest and the archive format. The production build
 * (`tenant-export-archive.ts`) streams the same pieces; `assembleTenantExportBundle` assembles a small archive in memory
 * for the demo store. Both write one format: a stored (uncompressed) zip with `README.txt` first, the data in the order
 * it was written, and `manifest.json` LAST, because the manifest lists every other file with its SHA-256 and so can only
 * be written once those files have been. The archive's own SHA-256 is recorded with the request and sent with the
 * download.
 */

export const TENANT_EXPORT_CONTENT_TYPE = "application/zip";
export const TENANT_EXPORT_MANIFEST_VERSION = 2;
export const TENANT_EXPORT_MANIFEST_PATH = "manifest.json";
export const TENANT_EXPORT_README_PATH = "README.txt";

export type TenantExportContentFile = { path: string; description: string; bytes: Buffer; rowCount: number; dataset: TenantExportDataset; documentId?: string };

type ManifestHeader = Pick<TenantExportManifest, "requestId" | "tenantId" | "generatedAt" | "requestedBy" | "approvedBy" | "dataRights" | "notIncluded">;
export type TenantExportManifestInput = ManifestHeader & {
  /** Documents the organization may redistribute whose file is not in the archive (counted, never listed). */
  sourceFilesExcluded: number;
};

export type TenantExportBundleInput = TenantExportManifestInput & { files: TenantExportContentFile[] };

export type TenantExportBundle = {
  bytes: Buffer;
  contentType: typeof TENANT_EXPORT_CONTENT_TYPE;
  checksumSha256: string;
  manifest: TenantExportManifest;
};

export function sha256Hex(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export const TENANT_EXPORT_README = [
  "Corvis full data export",
  "",
  "This archive is your organization's export from Corvis. manifest.json (the last file in the archive) lists every other",
  "file with its SHA-256 checksum and size, the number of rows each data file holds, and what the export leaves out and why.",
  "",
  "Layout:",
  "  published-data/observations-0001.csv, -0002.csv, ...   approved observations in published snapshots",
  "  access-audit/access-audit-0001.csv, ...                 the access, support, source-connection, data-issue and export audit trail",
  "  source-documents/inventory-0001.csv, ...                every source document you may redistribute, with its size and SHA-256",
  "  source-documents/files/<document_id>/<name>             the source document files you may redistribute",
  "",
  "A data set with many rows is split into numbered parts of a fixed maximum number of rows. Every part starts with the same",
  "header row, so the parts can be concatenated after dropping the repeated header. Every part is listed in manifest.json.",
  "",
  "To verify a file, compute its SHA-256 and compare it with the checksum in manifest.json. Corvis also showed you the",
  "SHA-256 of this archive when you requested the download link.",
  "",
  "Data you do not have the contractual right to redistribute is not included. The manifest reports how many funds and",
  "documents that left out, and how many documents are listed in the inventory without their file, so nothing is dropped",
  "silently.",
  "",
].join("\n");

export function tenantExportReadme(): Buffer { return Buffer.from(TENANT_EXPORT_README, "utf8"); }

/** The manifest of an archive, from the files it holds (not counting manifest.json, which cannot checksum itself). */
export function buildTenantExportManifest(input: TenantExportManifestInput, files: TenantExportFile[]): TenantExportManifest {
  const documentFiles = files.filter((file) => file.dataset === "source_document");
  return {
    manifestVersion: TENANT_EXPORT_MANIFEST_VERSION,
    requestId: input.requestId,
    tenantId: input.tenantId,
    generatedAt: input.generatedAt,
    requestedBy: input.requestedBy,
    approvedBy: input.approvedBy,
    files,
    fileCount: files.length,
    sourceFiles: { included: documentFiles.length, excluded: input.sourceFilesExcluded, totalBytes: documentFiles.reduce((sum, file) => sum + file.sizeBytes, 0) },
    dataRights: input.dataRights,
    notIncluded: input.notIncluded,
  };
}

/** The manifest as the API returns it: without the individual source document files, which can number many thousands (they are in the archive's own manifest.json). */
export function publicTenantExportManifest(manifest: TenantExportManifest): TenantExportManifest {
  return { ...manifest, files: manifest.files.filter((file) => file.dataset !== "source_document") };
}

export function tenantExportManifestBytes(manifest: TenantExportManifest): Buffer { return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"); }

/** Assembles a whole archive in memory. For small archives only (the demo): the production build streams. */
export function assembleTenantExportBundle(input: TenantExportBundleInput): TenantExportBundle {
  const readme: TenantExportContentFile = { path: TENANT_EXPORT_README_PATH, description: "How to read and verify this export", bytes: tenantExportReadme(), rowCount: 0, dataset: "readme" };
  const contents = [readme, ...input.files];
  const manifest = buildTenantExportManifest(input, contents.map((file) => ({
    path: file.path, description: file.description, sha256: sha256Hex(file.bytes), sizeBytes: file.bytes.length, rowCount: file.rowCount, dataset: file.dataset,
    ...(file.documentId ? { documentId: file.documentId } : {}),
  })));
  const writer = new ZipStreamWriter();
  const parts: Buffer[] = [];
  const add = (name: string, bytes: Buffer) => {
    parts.push(writer.begin(name, bytes.length));
    writer.write(bytes);
    parts.push(bytes, writer.end().bytes);
  };
  for (const file of contents) add(file.path, file.bytes);
  add(TENANT_EXPORT_MANIFEST_PATH, tenantExportManifestBytes(manifest));
  parts.push(writer.finish());
  const bytes = Buffer.concat(parts);
  return { bytes, contentType: TENANT_EXPORT_CONTENT_TYPE, checksumSha256: sha256Hex(bytes), manifest };
}
