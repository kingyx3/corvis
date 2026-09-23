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

export interface DeliveryPort {
  createExport(format: ExportFormat): Promise<ExportManifest>;
  listExports(): Promise<ExportDeliveryStatus[]>;
  /** Issues a fresh short-lived download link for one of the caller's exports, on demand. */
  prepareDownload(exportId: string): Promise<ExportDeliveryStatus>;
}
