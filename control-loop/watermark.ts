import { isConditionalStateStore, type StateStore } from "./state.ts";
import type { Watermark } from "./types.ts";

const WATERMARK_KEY = "watermark";
const SCHEMA_VERSION = 1 as const;

export function emptyWatermark(): Watermark {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastSuccessfulDailyRunAt: null,
    lastSuccessfulWeeklyRunAt: null,
    lastWeeklyScanComplete: false,
    consecutiveFailures: 0,
    lastRunId: null,
  };
}

function parseWatermark(raw: string | null): Watermark {
  if (!raw) return emptyWatermark();
  try {
    const parsed = JSON.parse(raw) as Partial<Watermark>;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return emptyWatermark();
    return { ...emptyWatermark(), ...parsed };
  } catch {
    // A corrupted watermark must never crash the loop; it degrades to a full
    // rescan, which is safe, rather than trusting a partially-written file.
    return emptyWatermark();
  }
}

export async function readWatermark(store: StateStore): Promise<Watermark> {
  return parseWatermark(await store.read(WATERMARK_KEY));
}

/**
 * The watermark plus the store version it was read at (null when the store is
 * not conditional or the object does not exist yet). Pass the version back to
 * {@link writeWatermarkIfUnchanged} so a run that lost its lease cannot
 * silently overwrite a newer run's watermark.
 */
export type VersionedWatermark = { watermark: Watermark; version: string | null; conditional: boolean };

export async function readWatermarkVersioned(store: StateStore): Promise<VersionedWatermark> {
  if (!isConditionalStateStore(store)) return { watermark: await readWatermark(store), version: null, conditional: false };
  const current = await store.readVersioned(WATERMARK_KEY);
  return { watermark: parseWatermark(current?.value ?? null), version: current?.version ?? null, conditional: true };
}

/**
 * Compare-and-set watermark write for conditional stores; plain stores fall
 * back to an unconditional write (their callers serialize runs externally).
 * Returns false when another writer changed the watermark since it was read.
 */
export async function writeWatermarkIfUnchanged(store: StateStore, watermark: Watermark, read: VersionedWatermark): Promise<boolean> {
  if (!read.conditional || !isConditionalStateStore(store)) {
    await writeWatermark(store, watermark);
    return true;
  }
  return store.writeIfVersion(WATERMARK_KEY, JSON.stringify(watermark, null, 2), read.version);
}

export async function writeWatermark(store: StateStore, watermark: Watermark): Promise<void> {
  await store.write(WATERMARK_KEY, JSON.stringify(watermark, null, 2));
}
