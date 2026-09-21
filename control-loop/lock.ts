import { isConditionalStateStore, type StateStore } from "./state.ts";

const LOCK_KEY = "lock";

export type LockRecord = { owner: string; acquiredAt: string };

export type LockResult =
  | { acquired: true }
  | { acquired: false; heldBy: LockRecord };

function activeOtherOwner(raw: string | null, owner: string, now: Date, staleAfterMs: number): LockRecord | null {
  if (!raw) return null;
  const existing = JSON.parse(raw) as LockRecord;
  const age = now.getTime() - Date.parse(existing.acquiredAt);
  return Number.isFinite(age) && age < staleAfterMs && existing.owner !== owner ? existing : null;
}

/**
 * Acquire the single-writer mutation lease. Conditional stores use an atomic
 * generation precondition so overlapping Cloud Run Job executions cannot both
 * win a read-then-write race. File stores retain the legacy outer-concurrency
 * behavior used by GitHub Actions.
 */
export async function acquireLock(store: StateStore, owner: string, now: Date, staleAfterMs: number): Promise<LockResult> {
  const record: LockRecord = { owner, acquiredAt: now.toISOString() };

  if (isConditionalStateStore(store)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await store.readVersioned(LOCK_KEY);
      const heldBy = activeOtherOwner(current?.value ?? null, owner, now, staleAfterMs);
      if (heldBy) return { acquired: false, heldBy };
      if (await store.writeIfVersion(LOCK_KEY, JSON.stringify(record), current?.version ?? null)) {
        return { acquired: true };
      }
    }
    throw new Error("control_loop_lock_contention_retry_exhausted");
  }

  const raw = await store.read(LOCK_KEY);
  const heldBy = activeOtherOwner(raw, owner, now, staleAfterMs);
  if (heldBy) return { acquired: false, heldBy };
  await store.write(LOCK_KEY, JSON.stringify(record));
  return { acquired: true };
}

/** Only releases a lock this owner still holds. */
export async function releaseLock(store: StateStore, owner: string): Promise<void> {
  if (isConditionalStateStore(store)) {
    const current = await store.readVersioned(LOCK_KEY);
    if (!current) return;
    const existing = JSON.parse(current.value) as LockRecord;
    if (existing.owner !== owner) return;
    await store.writeIfVersion(LOCK_KEY, null, current.version);
    return;
  }

  const raw = await store.read(LOCK_KEY);
  if (!raw) return;
  const existing = JSON.parse(raw) as LockRecord;
  if (existing.owner !== owner) return;
  await store.write(LOCK_KEY, null);
}
