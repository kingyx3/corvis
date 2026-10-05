import type { WorkspacePort } from "@/shared/domain/workspace";
import { createHttpWorkspacePort } from "@/modules/workspace/adapters/http-workspace";
import { lazyPort } from "@/composition/lazy-port";

const apiBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") || "";

// The demo flag is compared inline (not through a const) so the bundler folds the condition and
// drops the dynamic import, and with it every demo fixture, from production builds.
export const workspacePort: WorkspacePort = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true"
  ? lazyPort(async () => (await import("@/modules/workspace/adapters/demo-workspace")).createDemoWorkspacePort())
  : createHttpWorkspacePort(apiBase);
