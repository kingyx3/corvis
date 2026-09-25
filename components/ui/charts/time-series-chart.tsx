"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DotProps } from "recharts";
import { ChartFigure, type ChartTableColumn, type ChartTableRow } from "./chart-figure";

export type TimeSeriesStatus = "final" | "preliminary" | "restated" | "derived";
export type TimeSeriesPoint = { period: string; label: string; value: number | null; status?: TimeSeriesStatus };

function formatDefault(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function StatusDot(props: DotProps & { payload?: TimeSeriesPoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.value == null) return null;
  const isPreliminary = payload.status === "preliminary";
  return (
    <circle
      cx={cx}
      cy={cy}
      r={isPreliminary ? 4 : 3.5}
      fill={isPreliminary ? "var(--surface)" : "var(--chart-series-1)"}
      stroke="var(--chart-series-1)"
      strokeWidth={isPreliminary ? 2 : 0}
      strokeDasharray={isPreliminary ? "2 1.5" : undefined}
    />
  );
}

function ChartTooltip({ active, payload, valueFormatter }: { active?: boolean; payload?: Array<{ payload: TimeSeriesPoint }>; valueFormatter: (value: number) => string }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  if (point.value == null) return null;
  return (
    <div className="chart-tooltip">
      <strong>{point.label}</strong>
      <div className="chart-tooltip-row">
        <span>{valueFormatter(point.value)}</span>
        {point.status && point.status !== "final" && <span>({point.status})</span>}
      </div>
    </div>
  );
}

/**
 * A single-series trend line. Per the dataviz method, one series needs no
 * legend box — the title names it. Preliminary values get a hollow, dashed
 * marker instead of a solid one so trust state isn't color-only.
 */
export function TimeSeriesChart({
  eyebrow,
  title,
  description,
  name,
  data,
  valueFormatter = formatDefault,
  unit,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  name: string;
  data: TimeSeriesPoint[];
  valueFormatter?: (value: number) => string;
  unit?: string;
}) {
  const hasPreliminary = data.some((point) => point.status === "preliminary");
  const plottable = data.filter((point) => point.value != null);
  const columns: ChartTableColumn[] = [
    { key: "period", label: "Period" },
    { key: "value", label: unit ? `${name} (${unit})` : name, align: "end" },
    { key: "status", label: "Status" },
  ];
  const rows: ChartTableRow[] = data.map((point) => ({
    period: point.label,
    value: point.value == null ? "—" : valueFormatter(point.value),
    status: point.status ? point.status[0].toUpperCase() + point.status.slice(1) : "Final",
  }));

  return (
    <ChartFigure
      eyebrow={eyebrow}
      title={title}
      description={description}
      tableCaption={`${title} by period`}
      columns={columns}
      rows={rows}
      emptyMessage="Not enough published periods to chart a trend yet."
      legend={hasPreliminary && (
        <p className="chart-description" style={{ marginTop: 8, marginBottom: 0 }}>
          <span aria-hidden="true">○</span> Hollow marker indicates a preliminary value.
        </p>
      )}
    >
      {plottable.length >= 2 ? (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--chart-axis)" }} tick={{ fontSize: 11 }} />
            <YAxis tickLine={false} axisLine={false} width={56} tick={{ fontSize: 11 }} tickFormatter={(value: number) => valueFormatter(value)} />
            <Tooltip content={<ChartTooltip valueFormatter={valueFormatter} />} />
            <Line type="monotone" dataKey="value" name={name} stroke="var(--chart-series-1)" strokeWidth={2} dot={<StatusDot />} activeDot={{ r: 5 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <p className="chart-empty">Not enough published periods to chart a trend yet.</p>
      )}
    </ChartFigure>
  );
}
