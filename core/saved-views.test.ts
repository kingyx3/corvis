import assert from "node:assert/strict";
import test from "node:test";
import { normalizeViewConfiguration, VIEW_COLUMNS, type SavedScreen } from "./saved-views.ts";

const invalid = (code: string) => (error: unknown) => error instanceof Error && error.message === code;

test("a valid view keeps only its declared fields and dedupes columns", () => {
  assert.deepEqual(
    normalizeViewConfiguration("review", { query: "acme", stateFilter: "Needs review", sortMode: "risk", columns: ["Company", "Company", "Metric"] }),
    { query: "acme", stateFilter: "Needs review", sortMode: "risk", columns: ["Company", "Metric"] },
  );
  assert.deepEqual(normalizeViewConfiguration("documents", {}), {});
  assert.deepEqual(normalizeViewConfiguration("analytics", { periodicity: "quarterly", density: "compact", selectedPosition: "p-1" }), { periodicity: "quarterly", density: "compact", selectedPosition: "p-1" });
});

test("only own declared field names are accepted, never inherited object properties", () => {
  for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
    const raw = JSON.parse(`{${JSON.stringify(key)}: "x"}`) as unknown; // JSON.parse keeps __proto__ as an own key
    assert.throws(() => normalizeViewConfiguration("review", raw), invalid("invalid_view_configuration"), key);
  }
  assert.throws(() => normalizeViewConfiguration("review", { notAField: "x" }), invalid("invalid_view_configuration"));
});

test("enumerated fields reject unknown values, and every value is a bounded string", () => {
  assert.throws(() => normalizeViewConfiguration("review", { stateFilter: "Archived" }), invalid("invalid_view_configuration"));
  assert.throws(() => normalizeViewConfiguration("review", { query: 7 }), invalid("invalid_view_configuration"));
  assert.throws(() => normalizeViewConfiguration("review", { query: "x".repeat(301) }), invalid("invalid_view_configuration"));
  assert.deepEqual(normalizeViewConfiguration("review", { query: "x".repeat(300) }), { query: "x".repeat(300) });
});

test("columns must be a non-empty list of known column names within the screen's column count", () => {
  for (const columns of ["Company", [], [7], ["Nope"], [...VIEW_COLUMNS.analytics, "Metric"]]) {
    assert.throws(() => normalizeViewConfiguration("analytics", { columns }), invalid("invalid_view_columns"), JSON.stringify(columns));
  }
});

test("the screen and the configuration object themselves are validated", () => {
  assert.throws(() => normalizeViewConfiguration("unknown" as SavedScreen, {}), invalid("invalid_view_configuration"));
  for (const raw of [null, undefined, "x", 3, ["a"]]) assert.throws(() => normalizeViewConfiguration("review", raw), invalid("invalid_view_configuration"));
});
