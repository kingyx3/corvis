/**
 * The workspace shell is a single route; the active view lives in the URL hash (`#/review`) so
 * reload, Back/Forward and shared links land on the same view. The `/` prefix keeps these hashes
 * from colliding with element-id anchors such as the skip link's `#main-content`.
 */
export const WORKSPACE_VIEWS = ["overview", "analytics", "documents", "review", "delivery", "research", "access"] as const;
export type WorkspaceViewId = typeof WORKSPACE_VIEWS[number];

/** The view named by a location hash, or null when the hash is empty or not a view route. */
export function parseViewHash(hash: string): WorkspaceViewId | null {
  const match = /^#\/([a-z]+)\/?$/.exec(hash);
  const name = match?.[1];
  return WORKSPACE_VIEWS.find((view) => view === name) ?? null;
}

export function viewHash(view: WorkspaceViewId): string {
  return `#/${view}`;
}
