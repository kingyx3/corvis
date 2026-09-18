import { createDemoDeliveryPort } from "@/adapters/delivery/demo-delivery";
import { createHttpDeliveryPort } from "@/adapters/delivery/http-delivery";

const demoMode = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true";
const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") || "";

export const deliveryPort = demoMode ? createDemoDeliveryPort() : createHttpDeliveryPort(apiBase);
