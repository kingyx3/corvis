import { safeGetItem } from "./safe-storage.ts";

/** Context selectors are untrusted; the server reauthorizes every request. */
export const WORKSPACE_CONTEXT_KEY = "corvis:workspace-context:v1";
export type WorkspaceContext = { tenantId: string; workspaceId: string };
let pageContext: WorkspaceContext | null | undefined;
let pageWindow: Window | undefined;

function parseWorkspaceContext(raw: string | null): WorkspaceContext | null {
  try {
    const value = JSON.parse(raw ?? "null") as WorkspaceContext | null;
    return value && typeof value.tenantId === "string" && typeof value.workspaceId === "string" ? value : null;
  } catch { return null; }
}

export function workspaceContext(): WorkspaceContext | null {
  if (typeof window === "undefined") return null;
  // Pin each loaded page to one context, including outstanding uploads. Another
  // tab changing the preference must never redirect an in-flight command. The
  // Window identity changes only when a new page/runtime is created, which also
  // gives tests a deterministic way to exercise each initialization branch.
  if (pageWindow === window && pageContext !== undefined) return pageContext;
  pageWindow = window;
  pageContext = parseWorkspaceContext(safeGetItem("local", WORKSPACE_CONTEXT_KEY));
  return pageContext;
}

export function workspaceContextHeaders(): Record<string, string> {
  const context = workspaceContext();
  return context ? { "x-corvis-tenant": context.tenantId, "x-corvis-workspace": context.workspaceId } : {};
}

export function workspaceStorageKey(key: string): string {
  const context = workspaceContext();
  return `${key}:${context?.tenantId ?? "default"}:${context?.workspaceId ?? "default"}`;
}
