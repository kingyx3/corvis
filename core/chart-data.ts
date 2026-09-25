export type CompositionInput = { key: string; label: string; value: number };
export type CompositionSegment = CompositionInput & { percent: number };

// Fixed categorical hue order caps at 8 slots (see app/globals.css --chart-series-*
// and the dataviz palette this app validates against). Anything past the cap folds
// into "Other" rather than cycling hues, which would break CVD-safe adjacency.
export const MAX_CATEGORICAL_SEGMENTS = 8;

export function aggregateComposition(
  items: CompositionInput[],
  maxSegments: number = MAX_CATEGORICAL_SEGMENTS,
): { segments: CompositionSegment[]; total: number } {
  const positive = items.filter((item) => item.value > 0);
  const sorted = [...positive].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return { segments: [], total: 0 };

  const kept = sorted.length > maxSegments ? sorted.slice(0, maxSegments - 1) : sorted;
  const overflow = sorted.length > maxSegments ? sorted.slice(maxSegments - 1) : [];
  const segments: CompositionSegment[] = kept.map((item) => ({ ...item, percent: (item.value / total) * 100 }));
  if (overflow.length) {
    const overflowValue = overflow.reduce((sum, item) => sum + item.value, 0);
    segments.push({ key: "other", label: `Other (${overflow.length})`, value: overflowValue, percent: (overflowValue / total) * 100 });
  }
  return { segments, total };
}

export type TrendPoint = { period: string; value: number | null };
export type TrendDelta = { absolute: number; percent: number | null; direction: "up" | "down" | "flat" };

export function trendDelta(points: TrendPoint[]): TrendDelta | null {
  const numeric = points.filter((point): point is TrendPoint & { value: number } => point.value != null && Number.isFinite(point.value));
  if (numeric.length < 2) return null;
  const current = numeric[numeric.length - 1].value;
  const previous = numeric[numeric.length - 2].value;
  const absolute = current - previous;
  const percent = previous === 0 ? null : (absolute / Math.abs(previous)) * 100;
  return { absolute, percent, direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat" };
}
