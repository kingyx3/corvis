"use client";

import { Fragment, useMemo, useState, type HTMLAttributes, type Key, type ReactNode } from "react";
import type { TableDensity } from "./table-density-toggle";

type SortValue = string | number | null | undefined;
export type Direction = "ascending" | "descending";
type SortableRowAttributes = HTMLAttributes<HTMLTableRowElement> & { "data-role"?: string };

export type SortableColumn<Row> = {
  id: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  sortValue?: (row: Row) => SortValue;
  rowHeader?: boolean;
  align?: "start" | "end";
  headerClassName?: string;
  cellClassName?: string;
  cellTitle?: (row: Row) => string | undefined;
};

function compareSortValues(left: SortValue, right: SortValue): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * One implementation for dense, keyboard-sortable tables. Sorting is always
 * initiated by native header buttons and announced by aria-sort on <th>.
 */
export function SortableDataTable<Row>({
  caption, sort: controlledSort, onSortChange,
  rows,
  columns,
  rowKey,
  density = "comfortable",
  className = "",
  getRowAttributes,
  renderRowDetail,
}: {
  caption: string;
  sort?: { columnId: string; direction: Direction } | null;
  onSortChange?: (sort: { columnId: string; direction: Direction }) => void;
  rows: readonly Row[];
  columns: readonly SortableColumn<Row>[];
  rowKey: (row: Row) => Key;
  density?: TableDensity;
  className?: string;
  getRowAttributes?: (row: Row) => SortableRowAttributes;
  /** Optional content for a full-width row directly under `row` (e.g. an expanded child table); null renders no row. */
  renderRowDetail?: (row: Row) => ReactNode | null;
}) {
  const [localSort, setSort] = useState<{ columnId: string; direction: Direction } | null>(null);
  const sort = controlledSort === undefined ? localSort : controlledSort;
  const orderedRows = useMemo(() => {
    if (!sort) return [...rows];
    const column = columns.find((candidate) => candidate.id === sort.columnId);
    if (!column?.sortValue) return [...rows];
    return rows.map((row, index) => ({ row, index })).sort((left, right) => {
      const leftValue = column.sortValue!(left.row);
      const rightValue = column.sortValue!(right.row);
      // A row with no value (for example a metric that was "Not reported") stays last in both directions instead of leading a descending sort.
      if ((leftValue == null) !== (rightValue == null)) return leftValue == null ? 1 : -1;
      const compared = compareSortValues(leftValue, rightValue);
      const stable = compared || left.index - right.index;
      return sort.direction === "ascending" ? stable : -stable;
    }).map(({ row }) => row);
  }, [columns, rows, sort]);

  const toggleSort = (columnId: string) => {
    const next = sort?.columnId === columnId ? { columnId, direction: sort.direction === "ascending" ? "descending" as const : "ascending" as const } : { columnId, direction: "ascending" as const };
    if (onSortChange) onSortChange(next); else setSort(next);
  };

  return (
    <table className={`data-table${className ? ` ${className}` : ""}`} data-density={density}>
      <caption className="visually-hidden">{caption}</caption>
      <thead><tr>{columns.map((column) => {
        const active = sort?.columnId === column.id;
        const ariaSort = column.sortValue ? (active ? sort.direction : "none") : undefined;
        return <th key={column.id} scope="col" className={column.headerClassName} aria-sort={ariaSort} style={{ textAlign: column.align === "end" ? "right" : "left" }}>
          {column.sortValue ? <button type="button" className="sortable-header-button" data-align={column.align === "end" ? "end" : "start"} onClick={() => toggleSort(column.id)} aria-label={`Sort by ${typeof column.header === "string" ? column.header : column.id}${active ? `, currently ${sort.direction}` : ""}`}>
            <span>{column.header}</span><span className="sort-indicator" aria-hidden="true">{active ? (sort.direction === "ascending" ? "↑" : "↓") : "↕"}</span>
          </button> : column.header}
        </th>;
      })}</tr></thead>
      <tbody>{orderedRows.map((row) => {
        const detail = renderRowDetail?.(row);
        return <Fragment key={rowKey(row)}>
          <tr {...getRowAttributes?.(row)}>{columns.map((column) => {
            const content = column.render(row);
            const common = { className: column.cellClassName, title: column.cellTitle?.(row), style: { textAlign: column.align === "end" ? "right" as const : "left" as const } };
            return column.rowHeader ? <th key={column.id} scope="row" {...common}>{content}</th> : <td key={column.id} {...common}>{content}</td>;
          })}</tr>
          {detail != null && <tr className="data-table-detail-row"><td colSpan={columns.length}>{detail}</td></tr>}
        </Fragment>;
      })}</tbody>
    </table>
  );
}
