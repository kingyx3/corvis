/** Context selectors are untrusted; the server reauthorizes every request. */
export const WORKSPACE_CONTEXT_KEY = "corvis:workspace-context:v1";
export type WorkspaceContext = { tenantId: string; workspaceId: string };
let pageContext: WorkspaceContext | null | undefined;

export function workspaceContext(): WorkspaceContext | null {
  if (typeof window === "undefined") return null;
  // Pin each loaded page to one context, including outstanding uploads. Another
  // tab changing the preference must never redirect an in-flight command.
  if (pageContext !== undefined) return pageContext;
  try {
    const value = JSON.parse(window.localStorage.getItem(WORKSPACE_CONTEXT_KEY) ?? "null") as WorkspaceContext | null;
    pageContext = value && typeof value.tenantId === "string" && typeof value.workspaceId === "string" ? value : null;
  } catch { pageContext = null; }
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
