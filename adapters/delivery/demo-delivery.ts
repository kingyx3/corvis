import type { DeliveryPort } from "@/core/delivery";
import { assertDemoModuleAvailable, demoCustomerJourneyStore } from "@/adapters/demo/customer-journey-store";

export function createDemoDeliveryPort(): DeliveryPort {
  return {
    async createExport(format) {
      assertDemoModuleAvailable("delivery");
      return demoCustomerJourneyStore.createExport(format);
    },
  };
}
