export type CompositionInput = { key: string; label: string; value: number };
export type CompositionSegment = CompositionInput & { percent: number };

// Fixed categorical hue order caps at 8 slots (see app/globals.css --chart-series-*
// and the dataviz palette this app validates against). Anything past the cap folds
// into "Other" rather than cycling hues, which would break CVD-safe adjacency.
export const MAX_CATEGORICAL_SEGMENTS = 8;

/**
 * Values that cannot be drawn as a share of a whole (negative, e.g. leverage or
 * a "not attributed" residual below zero) are left out of the segments but never
 * silently: `omitted` carries their count and summed value, and `netTotal` is
 * the sum of every finite input, so a caller can reconcile `total` (the sum of
 * the drawn, positive segments, and the basis of each `percent`) with the
 * headline figure: `total + omitted.value === netTotal`.
 */
export type CompositionOmission = { count: number; value: number };

export function aggregateComposition(
  items: CompositionInput[],
  maxSegments: number = MAX_CATEGORICAL_SEGMENTS,
): { segments: CompositionSegment[]; total: number; omitted: CompositionOmission; netTotal: number } {
  const finite = items.filter((item) => Number.isFinite(item.value));
  const positive = finite.filter((item) => item.value > 0);
  const dropped = finite.filter((item) => item.value < 0);
  const omitted: CompositionOmission = { count: dropped.length, value: dropped.reduce((sum, item) => sum + item.value, 0) };
  const netTotal = finite.reduce((sum, item) => sum + item.value, 0);
  const sorted = [...positive].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return { segments: [], total: 0, omitted, netTotal };

  const kept = sorted.length > maxSegments ? sorted.slice(0, maxSegments - 1) : sorted;
  const overflow = sorted.length > maxSegments ? sorted.slice(maxSegments - 1) : [];
  const segments: CompositionSegment[] = kept.map((item) => ({ ...item, percent: (item.value / total) * 100 }));
  if (overflow.length) {
    const overflowValue = overflow.reduce((sum, item) => sum + item.value, 0);
    segments.push({ key: "other", label: `Other (${overflow.length})`, value: overflowValue, percent: (overflowValue / total) * 100 });
  }
  return { segments, total, omitted, netTotal };
}

/**
 * Visible text reconciling a composition whose negative inputs were left out of
 * the drawn segments; `undefined` when nothing was omitted.
 */
export function compositionOmissionNote(
  result: { total: number; omitted: CompositionOmission; netTotal: number },
  format: (value: number) => string,
): string | undefined {
  const { omitted, total, netTotal } = result;
  if (omitted.count === 0) return undefined;
  const one = omitted.count === 1;
  return `${omitted.count} negative ${one ? "value" : "values"} totalling ${format(omitted.value)} ${one ? "is" : "are"} not drawn. Drawn total ${format(total)}; net total ${format(netTotal)}.`;
}

export type TrendPoint = { period: string; value: number | null };
export type TrendDelta = { absolute: number; percent: number | null; direction: "up" | "down" | "flat" };

/**
 * Change between the last two points, positionally. A missing (null or
 * non-finite) latest or immediately previous point yields null: skipping a gap
 * would present an older movement as "since the prior period", or report a
 * change when the latest period has no value.
 */
export function trendDelta(points: TrendPoint[]): TrendDelta | null {
  if (points.length < 2) return null;
  const current = points[points.length - 1].value;
  const previous = points[points.length - 2].value;
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const absolute = current - previous;
  const percent = previous === 0 ? null : (absolute / Math.abs(previous)) * 100;
  return { absolute, percent, direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat" };
}
