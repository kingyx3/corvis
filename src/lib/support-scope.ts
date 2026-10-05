/**
 * The workspace the signed-in user is currently working in, remembered for "Contact support". It lives
 * outside React on purpose: when an error boundary replaces the workspace shell, the identity the shell
 * had loaded is still here, so the error page can still say which workspace the failure happened in.
 * Only the two opaque ids are kept (no names, no roles, no subject).
 */
export type SupportScope = { tenantId?: string; workspaceId?: string };

let current: SupportScope = {};
const listeners = new Set<() => void>();

export function setSupportScope(next: SupportScope): void {
  if (next.tenantId === current.tenantId && next.workspaceId === current.workspaceId) return;
  current = { tenantId: next.tenantId, workspaceId: next.workspaceId };
  for (const listener of [...listeners]) listener();
}

/** Referentially stable until the scope changes, as `useSyncExternalStore` requires. */
export function currentSupportScope(): SupportScope {
  return current;
}

export function subscribeSupportScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
