"use client";

import { Line, LineChart, ResponsiveContainer } from "recharts";
import { trendDelta, type TrendPoint } from "@/core/chart-data";

function formatDefault(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

/**
 * A tiny inline trend indicator for metric cards. The line is decorative;
 * the accessible name and the numeric delta (arrow glyph + text, not color
 * alone) carry the information, and a disclosure exposes the full series.
 */
export function Sparkline({
  label,
  points,
  valueFormatter = formatDefault,
  width = 72,
  height = 28,
}: {
  label: string;
  points: TrendPoint[];
  valueFormatter?: (value: number) => string;
  width?: number;
  height?: number;
}) {
  const plottable = points.filter((point): point is TrendPoint & { value: number } => point.value != null && Number.isFinite(point.value));
  const delta = trendDelta(points);
  const accessibleName = delta
    ? `${label} trend: ${delta.direction === "up" ? "up" : delta.direction === "down" ? "down" : "flat"} ${valueFormatter(Math.abs(delta.absolute))}${delta.percent != null ? ` (${delta.percent > 0 ? "+" : ""}${delta.percent.toFixed(1)}%)` : ""} since the prior period`
    : `${label} trend: not enough periods yet`;

  return (
    <span className="sparkline">
      <span className="visually-hidden">{accessibleName}</span>
      {plottable.length >= 2 && (
        <span className="sparkline-plot" aria-hidden="true">
          <ResponsiveContainer width={width} height={height}>
            <LineChart data={points} margin={{ top: 2, right: 2, bottom: 2, left: 2 }} accessibilityLayer={false}>
              <Line type="monotone" dataKey="value" stroke={delta?.direction === "down" ? "var(--danger)" : "var(--success)"} strokeWidth={1.75} dot={false} connectNulls isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </span>
      )}
      {delta && (
        <span className="sparkline-delta" data-direction={delta.direction} aria-hidden="true">
          {valueFormatter(Math.abs(delta.absolute))}
          {delta.percent != null && ` (${delta.percent > 0 ? "+" : delta.percent < 0 ? "−" : ""}${Math.abs(delta.percent).toFixed(1)}%)`}
        </span>
      )}
      {plottable.length > 0 && (
        <details className="sparkline-caption">
          <summary>Values</summary>
          <div className="chart-data-table-wrap">
            <table className="chart-data-table">
              <caption>{label} by period</caption>
              <thead><tr><th scope="col">Period</th><th scope="col" style={{ textAlign: "right" }}>Value</th></tr></thead>
              <tbody>{points.map((point) => <tr key={point.period}><td>{point.period}</td><td style={{ textAlign: "right" }}>{point.value == null ? "—" : valueFormatter(point.value)}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
    </span>
  );
}
