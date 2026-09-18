import { createDemoWorkspacePort } from "@/adapters/workspace/demo-workspace";
import { createHttpWorkspacePort } from "@/adapters/workspace/http-workspace";

const demoMode = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true";
const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") || "";

export const workspacePort = demoMode ? createDemoWorkspacePort() : createHttpWorkspacePort(apiBase);
