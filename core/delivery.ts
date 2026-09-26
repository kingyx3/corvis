import type { ExportManifest } from "@/core/enterprise";
import type { StatementPeriodicity } from "@/core/contracts";

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
export type SnapshotExportScope = { snapshotId: string };
/** Exact analytics view scope persisted with a governed Position Financials export. */
export type PositionFinancialsExportScope = {
  positionFinancials: {
    fundId: string;
    holdingId: string;
    companyId: string;
    periodicity: StatementPeriodicity;
    portfolioId?: string;
  };
};
export type ExportScope = SnapshotExportScope | PositionFinancialsExportScope;
/** Which product surface is requesting the export, recorded on the manifest for delivery history (#182 D12). */
export type ExportSource = NonNullable<ExportManifest["source"]>;
export type ExportRequestOptions = { scope?: ExportScope; source?: ExportSource };
/** Compatibility for the pre-D12 scoped Review call while the workspace-isolation PR is rebased. */
export type ExportRequest = ExportRequestOptions | SnapshotExportScope;

export function normalizeExportRequest(options?: ExportRequest): ExportRequestOptions {
  if (!options) return {};
  if ("snapshotId" in options) return { scope: options, source: "review" };
  return options;
}

export interface DeliveryPort {
  createExport(format: ExportFormat, options?: ExportRequest): Promise<ExportManifest>;
  listExports(): Promise<ExportDeliveryStatus[]>;
  /** Issues a fresh short-lived download link for one of the caller's exports, on demand. */
  prepareDownload(exportId: string): Promise<ExportDeliveryStatus>;
}
