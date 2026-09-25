// Fixed categorical hue order — assign by index in sequence, never by value or
// reassigned when a filter changes the series count. Matches app/globals.css
// --chart-series-* and core/chart-data.ts's MAX_CATEGORICAL_SEGMENTS cap.
export const CHART_SERIES_COLORS = [
  "var(--chart-series-1)",
  "var(--chart-series-2)",
  "var(--chart-series-3)",
  "var(--chart-series-4)",
  "var(--chart-series-5)",
  "var(--chart-series-6)",
  "var(--chart-series-7)",
  "var(--chart-series-8)",
] as const;

export const CHART_SERIES_OTHER_COLOR = "var(--chart-series-other)";
export const CHART_SERIES_UNASSIGNED_COLOR = "var(--chart-series-unassigned)";

export function seriesColor(index: number, isOther = false): string {
  if (isOther) return CHART_SERIES_OTHER_COLOR;
  return CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length];
}
