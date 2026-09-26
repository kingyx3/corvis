import type { ExportManifest } from "@/core/enterprise";

export type ExportFormat = ExportManifest["format"];
export type ExportDeliveryStatus = {
  exportId: string;
  format: ExportFormat;
  state: string;
  createdAt: string;
  completedAt?: string;
  expiresAt?: string;
  checksumSha256?: string;
  manifest: ExportManifest;
  /** Complete and unexpired. History listings never carry a download link; request one with prepareDownload. */
  downloadAvailable?: boolean;
  downloadUrl?: string;
  downloadExpiresAt?: string;
};

/** Restricts a governed export to one already-entitled published snapshot (e.g. "export this view" from Review). */
export type ExportScope = { snapshotId: string };

export interface DeliveryPort {
  createExport(format: ExportFormat, scope?: ExportScope): Promise<ExportManifest>;
  listExports(): Promise<ExportDeliveryStatus[]>;
  /** Issues a fresh short-lived download link for one of the caller's exports, on demand. */
  prepareDownload(exportId: string): Promise<ExportDeliveryStatus>;
}
