import type { ReactNode } from "react";

export type ChartTableColumn = { key: string; label: string; align?: "start" | "end" };
export type ChartTableRow = Record<string, ReactNode>;

/**
 * Shared accessible wrapper for every chart primitive. The plot itself is
 * visual/decorative (hidden from assistive tech); a real, keyboard-reachable
 * <table> with the same data is always present behind a native <details>
 * disclosure so no chart ships without a tabular fallback.
 */
export function ChartFigure({
  eyebrow,
  title,
  description,
  legend,
  tableCaption,
  columns,
  rows,
  emptyMessage,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  legend?: ReactNode;
  tableCaption: string;
  columns: ChartTableColumn[];
  rows: ChartTableRow[];
  emptyMessage?: string;
  children: ReactNode;
}) {
  return (
    <figure className="chart-figure">
      <figcaption>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h3>{title}</h3>
        {description && <p className="chart-description">{description}</p>}
      </figcaption>
      {rows.length > 0 ? (
        <>
          <div className="chart-plot" aria-hidden="true">{children}</div>
          {legend}
        </>
      ) : (
        <p className="chart-empty">{emptyMessage ?? "Not enough data to chart yet."}</p>
      )}
      {rows.length > 0 && (
        <details className="chart-data-toggle">
          <summary>View as table</summary>
          <div className="chart-data-table-wrap">
            <table className="chart-data-table">
              <caption>{tableCaption}</caption>
              <thead>
                <tr>{columns.map((column) => <th key={column.key} scope="col" style={column.align === "end" ? { textAlign: "right" } : undefined}>{column.label}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => <td key={column.key} style={column.align === "end" ? { textAlign: "right" } : undefined}>{row[column.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
