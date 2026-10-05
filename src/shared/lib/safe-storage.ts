/**
 * Web Storage throws in private windows, with site data blocked, or when the quota is full — even
 * merely reading `window.localStorage` can throw. Storage here is only ever a convenience (UI
 * state, pending-invitation token, workspace selection), so every failure degrades to "nothing
 * stored" instead of crashing a render or failing an otherwise successful command.
 */
export type StorageKind = "local" | "session";

function area(kind: StorageKind): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch { return null; }
}

export function safeGetItem(kind: StorageKind, key: string): string | null {
  try { return area(kind)?.getItem(key) ?? null; } catch { return null; }
}

/** Returns whether the value was persisted. */
export function safeSetItem(kind: StorageKind, key: string, value: string): boolean {
  try {
    const storage = area(kind);
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch { return false; }
}

export function safeRemoveItem(kind: StorageKind, key: string): void {
  try { area(kind)?.removeItem(key); } catch { /* storage unavailable: nothing to remove */ }
}
