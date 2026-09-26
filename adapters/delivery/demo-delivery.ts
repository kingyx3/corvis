import type { DeliveryPort, ExportDeliveryStatus, ExportScope } from "@/core/delivery";
import { assertDemoModuleAvailable, demoCustomerJourneyStore } from "@/adapters/demo/customer-journey-store";

const history: ExportDeliveryStatus[] = [];

export function createDemoDeliveryPort(): DeliveryPort {
  return {
    async createExport(format, scope?: ExportScope) {
      assertDemoModuleAvailable("delivery");
      const manifest = await demoCustomerJourneyStore.createExport(format, scope?.snapshotId);
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
