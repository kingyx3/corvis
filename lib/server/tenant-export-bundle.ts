import { createHash } from "node:crypto";
import type { TenantExportFile, TenantExportManifest } from "../../core/tenant-export.ts";
import { zipStored } from "./export-renderer.ts";

/**
 * Assembles the archive for a full tenant export (F10, #266): the content files plus a checksum manifest, as one
 * stored (uncompressed) zip. Pure and deterministic given its inputs, so the Postgres build and the demo store
 * produce the same format and the same verification story: `manifest.json` lists every other file with its SHA-256,
 * and the archive's own SHA-256 is recorded with the request and sent with the download.
 */

export const TENANT_EXPORT_CONTENT_TYPE = "application/zip";

export type TenantExportContentFile = { path: string; description: string; bytes: Buffer; rowCount: number };

export type TenantExportBundleInput = {
  requestId: string;
  tenantId: string;
  generatedAt: string;
  requestedBy: string;
  approvedBy: string;
  files: TenantExportContentFile[];
  dataRights: TenantExportManifest["dataRights"];
  notIncluded: TenantExportManifest["notIncluded"];
};

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
  "This archive is your organization's export from Corvis. manifest.json lists every file with its SHA-256 checksum,",
  "the number of rows it holds, and what the export leaves out and why.",
  "",
  "To verify a file, compute its SHA-256 and compare it with the checksum in manifest.json. Corvis also showed you the",
  "SHA-256 of this archive when you requested the download link.",
  "",
  "Data you do not have the contractual right to redistribute is not included. The manifest reports how many funds and",
  "documents that left out, so nothing is dropped silently.",
  "",
].join("\n");

export function assembleTenantExportBundle(input: TenantExportBundleInput): TenantExportBundle {
  const readme: TenantExportContentFile = { path: "README.txt", description: "How to read and verify this export", bytes: Buffer.from(TENANT_EXPORT_README, "utf8"), rowCount: 0 };
  const contents = [readme, ...input.files];
  const files: TenantExportFile[] = contents.map((file) => ({
    path: file.path, description: file.description, sha256: sha256Hex(file.bytes), sizeBytes: file.bytes.length, rowCount: file.rowCount,
  }));
  const manifest: TenantExportManifest = {
    manifestVersion: 1,
    requestId: input.requestId,
    tenantId: input.tenantId,
    generatedAt: input.generatedAt,
    requestedBy: input.requestedBy,
    approvedBy: input.approvedBy,
    files,
    dataRights: input.dataRights,
    notIncluded: input.notIncluded,
  };
  const bytes = zipStored([
    { name: "manifest.json", bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    ...contents.map((file) => ({ name: file.path, bytes: file.bytes })),
  ]);
  return { bytes, contentType: TENANT_EXPORT_CONTENT_TYPE, checksumSha256: sha256Hex(bytes), manifest };
}
