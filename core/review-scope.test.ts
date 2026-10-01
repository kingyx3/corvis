import assert from "node:assert/strict";
import test from "node:test";
import type { FundSnapshot, ObservationRecord } from "./contracts.ts";
import { scopeObservationsToSnapshot } from "./review-scope.ts";

function row(id: string, overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return { id, fund: "Fund A", fundId: "fund-a", company: "Co", metric: "revenue", value: "1", period: "2026 Q2", source: "p. 1", confidence: 90, state: "Needs review", delta: "—", ...overrides };
}
function snapshot(overrides: Partial<FundSnapshot> = {}): FundSnapshot {
  return { id: "snap-a", version: 1, fund: "Fund A", fundId: "fund-a", period: "2026 Q2", status: "Review", holdings: 1, facts: 1, changed: "now", ...overrides };
}
const ids = (rows: ObservationRecord[]) => rows.map((item) => item.id);

test("rows without snapshotId are scoped to the selected snapshot's fund and period", () => {
  const rows = [
    row("a-q2"),
    row("a-q2-pending", { state: "Approved" }),
    row("b-q2", { fund: "Fund B", fundId: "fund-b" }),
    row("a-q1", { period: "2026 Q1" }),
  ];
  assert.deepEqual(ids(scopeObservationsToSnapshot(rows, snapshot())), ["a-q2", "a-q2-pending"]);
  assert.deepEqual(ids(scopeObservationsToSnapshot(rows, snapshot({ id: "snap-b", fund: "Fund B", fundId: "fund-b" }))), ["b-q2"]);
});

test("another fund's pending rows do not count toward the selected snapshot", () => {
  const rows = [row("a-ok", { state: "Approved" }), row("b-pending", { fund: "Fund B", fundId: "fund-b" })];
  const scoped = scopeObservationsToSnapshot(rows, snapshot());
  assert.equal(scoped.filter((item) => item.state === "Needs review").length, 0);
});

test("rows carrying snapshotId are scoped by it, whatever their fund or period", () => {
  const rows = [row("mine", { snapshotId: "snap-a", period: "LTM Jun-26" }), row("theirs", { snapshotId: "snap-b" }), row("unstamped")];
  assert.deepEqual(ids(scopeObservationsToSnapshot(rows, snapshot())), ["mine", "unstamped"]);
});

test("a stamped row never matches a snapshot without an id", () => {
  assert.deepEqual(scopeObservationsToSnapshot([row("x", { snapshotId: "snap-a" })], snapshot({ id: undefined })), []);
});

test("falls back to display names when fund ids are unavailable and ignores case and padding", () => {
  const rows = [row("named", { fundId: undefined, period: " 2026 q2 " }), row("other", { fundId: undefined, fund: "Fund B" })];
  assert.deepEqual(ids(scopeObservationsToSnapshot(rows, snapshot({ fundId: undefined }))), ["named"]);
  // A row without a fund id still matches by name when only one side has an id.
  assert.deepEqual(ids(scopeObservationsToSnapshot(rows, snapshot())), ["named"]);
});

test("never falls through to every row when nothing matches", () => {
  const rows = [row("b", { fund: "Fund B", fundId: "fund-b" }), row("old", { period: "2025 Q4" }), row("blank", { period: "" })];
  assert.deepEqual(scopeObservationsToSnapshot(rows, snapshot()), []);
  assert.deepEqual(scopeObservationsToSnapshot(rows, snapshot({ fundId: undefined, fund: "" })), []);
});

test("with no snapshot selected the rows are returned unchanged (copied)", () => {
  const rows = [row("a"), row("b", { fundId: "fund-b" })];
  const result = scopeObservationsToSnapshot(rows, undefined);
  assert.deepEqual(result, rows);
  assert.notEqual(result, rows);
});
