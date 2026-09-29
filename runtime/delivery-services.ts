import type { DeliveryPort } from "@/core/delivery";
import { createHttpDeliveryPort } from "@/adapters/delivery/http-delivery";
import { lazyPort } from "@/runtime/lazy-port";

const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") || "";

// See runtime/workspace-services.ts: the inline flag keeps demo code out of production bundles.
export const deliveryPort: DeliveryPort = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true"
  ? lazyPort(async () => (await import("@/adapters/delivery/demo-delivery")).createDemoDeliveryPort())
  : createHttpDeliveryPort(apiBase);
