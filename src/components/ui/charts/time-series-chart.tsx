"use client";
import { displayNumberFormatter } from "@/lib/display-format";
import { usePreferences } from "@/features/preferences/preference-provider";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DotProps } from "recharts";
import { ChartFigure, type ChartTableColumn, type ChartTableRow } from "./chart-figure";

export type TimeSeriesStatus = "final" | "preliminary" | "restated" | "derived";
export type TimeSeriesPoint = { period: string; label: string; value: number | null; status?: TimeSeriesStatus };

function formatDefault(value: number): string {
  return displayNumberFormatter( { maximumFractionDigits: 2 }).format(value);
}

function StatusDot(props: DotProps & { payload?: TimeSeriesPoint; onSelect?: (point: TimeSeriesPoint) => void }) {
  const { cx, cy, payload, onSelect } = props;
  if (cx == null || cy == null || payload?.value == null) return null;
  const isPreliminary = payload.status === "preliminary";
  if (payload.status === "restated") return <path d={`M ${cx} ${cy - 5} L ${cx + 5} ${cy} L ${cx} ${cy + 5} L ${cx - 5} ${cy} Z`} fill="var(--chart-series-1)" onClick={onSelect ? () => onSelect(payload) : undefined}/>;
  if (payload.status === "derived") return <rect x={cx - 4} y={cy - 4} width={8} height={8} fill="var(--surface)" stroke="var(--chart-series-1)" strokeWidth={2} onClick={onSelect ? () => onSelect(payload) : undefined}/>;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={isPreliminary ? 4 : 3.5}
      fill={isPreliminary ? "var(--surface)" : "var(--chart-series-1)"}
      stroke="var(--chart-series-1)"
      strokeWidth={isPreliminary ? 2 : 0}
      strokeDasharray={isPreliminary ? "2 1.5" : undefined}
      style={onSelect ? { cursor: "pointer" } : undefined}
      onClick={onSelect ? () => onSelect(payload) : undefined}
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
  emptyMessage = "Not enough published periods to chart a trend yet.",
  description,
  name,
  data,
  valueFormatter = formatDefault,
  unit,
  onSelectPoint,
  selectLabel = "Open",
}: {
  eyebrow?: string;
  title: string;
  emptyMessage?: string;
  description?: string;
  name: string;
  data: TimeSeriesPoint[];
  valueFormatter?: (value: number) => string;
  unit?: string;
  /** Drill-through from a point (click) or its table row (keyboard) to the underlying evidence. */
  onSelectPoint?: (point: TimeSeriesPoint) => void;
  selectLabel?: string;
}) {
  usePreferences();
  const hasPreliminary = data.some((point) => point.status === "preliminary");
  const plottable = data.filter((point) => point.value != null);
  const columns: ChartTableColumn[] = [
    { key: "period", label: "Period" },
    { key: "value", label: unit ? `${name} (${unit})` : name, align: "end" },
    { key: "status", label: "Status" },
    ...(onSelectPoint ? [{ key: "action", label: "Evidence" }] : []),
  ];
  const rows: ChartTableRow[] = data.map((point) => ({
    period: point.label,
    value: point.value == null ? "—" : valueFormatter(point.value),
    status: point.status ? point.status[0].toUpperCase() + point.status.slice(1) : "Final",
    ...(onSelectPoint ? { action: <button type="button" className="text-button" onClick={() => onSelectPoint(point)} aria-label={`${selectLabel}: ${point.label}`}>{selectLabel}</button> } : {}),
  }));

  return (
    <ChartFigure
      eyebrow={eyebrow}
      title={title}
      description={description}
      tableCaption={`${title} by period`}
      columns={columns}
      rows={rows}
      emptyMessage={emptyMessage}
      legend={(hasPreliminary || data.some((point) => point.status === "restated" || point.status === "derived")) && (
        <p className="chart-description" style={{ marginTop: 8, marginBottom: 0 }}>
          <span aria-hidden="true">○</span> Hollow circle: preliminary. Diamond: restated. Square: derived.
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
            <Line type="monotone" dataKey="value" name={name} stroke="var(--chart-series-1)" strokeWidth={2} dot={<StatusDot onSelect={onSelectPoint} />} activeDot={onSelectPoint ? { r: 5, cursor: "pointer", onClick: (_event: unknown, dot: unknown) => { const payload = (dot as { payload?: TimeSeriesPoint }).payload; if (payload) onSelectPoint(payload); } } : { r: 5 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <p className="chart-empty">{plottable.length === 1 ? "One published period is available in the data table." : emptyMessage}</p>
      )}
    </ChartFigure>
  );
}
