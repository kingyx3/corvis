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
  downloadUrl?: string;
  downloadExpiresAt?: string;
};

export interface DeliveryPort {
  createExport(format: ExportFormat): Promise<ExportManifest>;
  listExports(): Promise<ExportDeliveryStatus[]>;
}
