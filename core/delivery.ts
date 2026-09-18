import type { ExportManifest } from "@/core/enterprise";

export type ExportFormat = ExportManifest["format"];

export interface DeliveryPort {
  createExport(format: ExportFormat): Promise<ExportManifest>;
}
