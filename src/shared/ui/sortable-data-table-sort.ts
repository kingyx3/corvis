export type SortValue = string | number | null | undefined;
export type Direction = "ascending" | "descending";

function compareSortValues(left: SortValue, right: SortValue): number {
  if (left == null && right == null) return 0;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Stable tie-break, nulls always last regardless of direction. Kept in its own
 * JSX-free module so it's testable with `node --test`, which cannot load `.tsx`.
 */
export function sortRows<Row>(rows: readonly Row[], sortValue: (row: Row) => SortValue, direction: Direction): Row[] {
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const leftValue = sortValue(left.row);
    const rightValue = sortValue(right.row);
    // A row with no value (for example a metric that was "Not reported") stays last in both directions instead of leading a descending sort.
    if ((leftValue == null) !== (rightValue == null)) return leftValue == null ? 1 : -1;
    const compared = compareSortValues(leftValue, rightValue);
    if (compared !== 0) return direction === "ascending" ? compared : -compared;
    // Ties always keep their original relative order, in either direction — that's what "stable" means.
    return left.index - right.index;
  }).map(({ row }) => row);
}
