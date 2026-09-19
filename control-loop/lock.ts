import type { StateStore } from "./state.ts";

const LOCK_KEY = "lock";

export type LockRecord = { owner: string; acquiredAt: string };

export type LockResult =
  | { acquired: true }
  | { acquired: false; heldBy: LockRecord };

/**
 * Application-level mutation lock: only one writer may mutate Confluence or
 * GitHub at a time. GitHub Actions' own concurrency group already prevents
 * two scheduled runs of this workflow from overlapping, but this lock is the
 * one the orchestrator itself enforces and can be unit tested independently
 * of the workflow file, and it is what a future manual dry-run or a second
 * trigger path must also respect.
 *
 * A lock older than `staleAfterMs` is treated as abandoned (a crashed run)
 * and can be reclaimed, so a single failed run can never permanently wedge
 * the loop.
 */
export async function acquireLock(store: StateStore, owner: string, now: Date, staleAfterMs: number): Promise<LockResult> {
  const raw = await store.read(LOCK_KEY);
  if (raw) {
    const existing = JSON.parse(raw) as LockRecord;
    const age = now.getTime() - Date.parse(existing.acquiredAt);
    if (Number.isFinite(age) && age < staleAfterMs && existing.owner !== owner) {
      return { acquired: false, heldBy: existing };
    }
  }
  const record: LockRecord = { owner, acquiredAt: now.toISOString() };
  await store.write(LOCK_KEY, JSON.stringify(record));
  return { acquired: true };
}

/** Only releases a lock this owner actually holds, so a stale caller can never clear another run's lock. */
export async function releaseLock(store: StateStore, owner: string): Promise<void> {
  const raw = await store.read(LOCK_KEY);
  if (!raw) return;
  const existing = JSON.parse(raw) as LockRecord;
  if (existing.owner !== owner) return;
  await store.write(LOCK_KEY, null);
}
