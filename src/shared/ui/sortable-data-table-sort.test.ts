import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const { sortRows } = await import("@/shared/ui/sortable-data-table-sort.ts");

type Row = { id: string; value: number | string | null };
const byValue = (row: Row) => row.value;

test("sort is stable: equal values keep their original relative order", () => {
  const rows: Row[] = [{ id: "a", value: 1 }, { id: "b", value: 1 }, { id: "c", value: 1 }];
  assert.deepEqual(sortRows(rows, byValue, "ascending").map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(sortRows(rows, byValue, "descending").map((r) => r.id), ["a", "b", "c"]);
});

test("rows with no value stay last in both ascending and descending order", () => {
  const rows: Row[] = [{ id: "missing", value: null }, { id: "mid", value: 5 }, { id: "high", value: 10 }];
  assert.deepEqual(sortRows(rows, byValue, "ascending").map((r) => r.id), ["mid", "high", "missing"]);
  assert.deepEqual(sortRows(rows, byValue, "descending").map((r) => r.id), ["high", "mid", "missing"]);
});

test("numeric values compare numerically, not lexicographically", () => {
  const rows: Row[] = [{ id: "a", value: 2 }, { id: "b", value: 10 }, { id: "c", value: 1 }];
  assert.deepEqual(sortRows(rows, byValue, "ascending").map((r) => r.id), ["c", "a", "b"]);
});

test("string values compare case-insensitively with numeric-aware ordering", () => {
  const rows: Row[] = [{ id: "a", value: "item 10" }, { id: "b", value: "Item 2" }, { id: "c", value: "item 1" }];
  assert.deepEqual(sortRows(rows, byValue, "ascending").map((r) => r.id), ["c", "b", "a"]);
});

test("every row with no value is treated equally (stable among themselves)", () => {
  const rows: Row[] = [{ id: "a", value: null }, { id: "b", value: null }, { id: "c", value: 1 }];
  assert.deepEqual(sortRows(rows, byValue, "ascending").map((r) => r.id), ["c", "a", "b"]);
  assert.deepEqual(sortRows(rows, byValue, "descending").map((r) => r.id), ["c", "a", "b"]);
});
