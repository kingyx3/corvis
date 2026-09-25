"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { aggregateComposition, type CompositionInput } from "@/core/chart-data";
import { ChartFigure, type ChartTableColumn, type ChartTableRow } from "./chart-figure";
import { CHART_SERIES_OTHER_COLOR, CHART_SERIES_UNASSIGNED_COLOR, seriesColor } from "./chart-tokens";

function formatDefault(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

/**
 * A single 100%-stacked bar showing how a total breaks down across categories.
 * Every segment carries a direct label (value + percent), and the legend below
 * pairs each swatch with its text label — identity is never color-only.
 */
export function CompositionChart({
  eyebrow,
  title,
  description,
  items,
  valueFormatter = formatDefault,
  unitLabel,
  mutedKeys,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  items: CompositionInput[];
  valueFormatter?: (value: number) => string;
  unitLabel?: string;
  /**
   * Segments that are gaps in a classification rather than categories (e.g.
   * "Unclassified", "Not attributed"). They take muted colours, sit after
   * every real category, and never consume one of the categorical hues.
   */
  mutedKeys?: Readonly<Record<string, "other" | "unassigned">>;
}) {
  const aggregated = aggregateComposition(items);
  const total = aggregated.total;
  const segments = mutedKeys
    ? [...aggregated.segments.filter((segment) => !mutedKeys[segment.key]), ...aggregated.segments.filter((segment) => mutedKeys[segment.key])]
    : aggregated.segments;
  let hue = 0;
  const colors = segments.map((segment) => {
    const muted = mutedKeys?.[segment.key];
    if (muted) return muted === "other" ? CHART_SERIES_OTHER_COLOR : CHART_SERIES_UNASSIGNED_COLOR;
    return seriesColor(hue++, segment.key === "other");
  });
  const row: Record<string, number | string> = { category: title };
  for (const segment of segments) row[segment.key] = segment.value;

  const columns: ChartTableColumn[] = [
    { key: "label", label: "Category" },
    { key: "value", label: unitLabel ?? "Value", align: "end" },
    { key: "percent", label: "Share", align: "end" },
  ];
  const rows: ChartTableRow[] = segments.map((segment) => ({
    label: segment.label,
    value: valueFormatter(segment.value),
    percent: `${segment.percent.toFixed(1)}%`,
  }));

  return (
    <ChartFigure
      eyebrow={eyebrow}
      title={title}
      description={description}
      tableCaption={`${title} composition`}
      columns={columns}
      rows={rows}
      emptyMessage="No composition data available yet."
      legend={
        <ul className="chart-legend">
          {segments.map((segment, index) => (
            <li key={segment.key}>
              <span className="chart-legend-swatch" aria-hidden="true" style={{ background: colors[index] }} />
              <span>{segment.label}</span>
              <b>{segment.percent.toFixed(0)}%</b>
            </li>
          ))}
        </ul>
      }
    >
      <ResponsiveContainer width="100%" height={64}>
        <BarChart data={[row]} layout="vertical" barSize={28} margin={{ top: 0, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
          <XAxis type="number" domain={[0, total]} hide />
          <YAxis type="category" dataKey="category" hide />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              return (
                <div className="chart-tooltip">
                  {payload.map((entry) => {
                    const segment = segments.find((candidate) => candidate.key === entry.dataKey);
                    if (!segment || typeof entry.value !== "number" || entry.value <= 0) return null;
                    return <div className="chart-tooltip-row" key={String(entry.dataKey)}><span>{segment.label}</span><span>{valueFormatter(entry.value)} ({segment.percent.toFixed(1)}%)</span></div>;
                  })}
                </div>
              );
            }}
          />
          {segments.map((segment, index) => (
            <Bar
              key={segment.key}
              dataKey={segment.key}
              stackId="composition"
              fill={colors[index]}
              stroke="var(--surface)"
              strokeWidth={2}
              radius={index === 0 ? [4, 0, 0, 4] : index === segments.length - 1 ? [0, 4, 4, 0] : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}
