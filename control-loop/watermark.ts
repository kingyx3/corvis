import type { StateStore } from "./state.ts";
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

export async function readWatermark(store: StateStore): Promise<Watermark> {
  const raw = await store.read(WATERMARK_KEY);
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

export async function writeWatermark(store: StateStore, watermark: Watermark): Promise<void> {
  await store.write(WATERMARK_KEY, JSON.stringify(watermark, null, 2));
}
