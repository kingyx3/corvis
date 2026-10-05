import { normalizeExportRequest, type DeliveryPort, type ExportRequest, type ExportScope as ExportRequestScope } from "@/core/delivery";
import { assertDemoModuleAvailable, demoCustomerJourneyStore } from "@/adapters/demo/customer-journey-store";
import type { ExportManifest } from "@/core/enterprise";
import { buildScorecard, scorecardExportRows, scorecardScopeLabel } from "@/core/performance-scorecard";
import { demoPerformanceScorecard } from "@/lib/server/performance-scorecard-demo";

const history: import("@/core/delivery").ExportDeliveryStatus[] = [];

export function createDemoDeliveryPort(): DeliveryPort {
  return {
    async createExport(format, request?: ExportRequest) {
      assertDemoModuleAvailable("delivery");
      const options = normalizeExportRequest(request);
      if (options.scope && "positionFinancials" in options.scope) throw new Error("Position Financials governed exports require the production delivery pipeline");
      const snapshotId = options.scope && "snapshotId" in options.scope ? options.scope.snapshotId : undefined;
      const stored = demoCustomerJourneyStore.createExport(format, snapshotId, options.source);
      // The scorecard export lists exactly the rows the scorecard view shows (reported figures and explicit Not reported rows).
      const manifest: ExportManifest & { scope?: ExportRequestScope; scopeLabel?: string } = options.scope && "performanceScorecard" in options.scope
        ? {
          ...stored,
          rowCounts: { performanceScorecard: scorecardExportRows(buildScorecard(demoPerformanceScorecard(options.scope))).length, snapshots: stored.snapshotIds.length },
          scope: options.scope,
          scopeLabel: scorecardScopeLabel(options.scope),
        }
        : stored;
      history.unshift({
        exportId: manifest.exportId,
        format: manifest.format,
        state: "complete",
        createdAt: manifest.generatedAt,
        completedAt: manifest.generatedAt,
        checksumSha256: manifest.checksumSha256,
        manifest,
        // The demo produces manifests only; there is no physical artifact to download.
        downloadAvailable: false,
      });
      return manifest;
    },
    async listExports() {
      assertDemoModuleAvailable("delivery");
      return history.slice(0, 20);
    },
    async prepareDownload(exportId) {
      assertDemoModuleAvailable("delivery");
      const item = history.find((entry) => entry.exportId === exportId);
      if (!item) throw new Error("not_found");
      return item;
    },
  };
}
