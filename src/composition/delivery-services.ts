import type { DeliveryPort } from "@/modules/delivery/domain/delivery";
import { createHttpDeliveryPort } from "@/modules/delivery/adapters/http-delivery";
import { lazyPort } from "@/composition/lazy-port";

const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") || "";

// See src/composition/workspace-services.ts: the inline flag keeps demo code out of production bundles.
export const deliveryPort: DeliveryPort = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true"
  ? lazyPort(async () => (await import("@/modules/delivery/adapters/demo-delivery")).createDemoDeliveryPort())
  : createHttpDeliveryPort(apiBase);
