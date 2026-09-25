import assert from "node:assert/strict";
import test from "node:test";
import { aggregateComposition, trendDelta } from "./chart-data.ts";

test("aggregateComposition sorts descending and computes percent of total", () => {
  const { segments, total } = aggregateComposition([
    { key: "a", label: "Fund A", value: 30 },
    { key: "b", label: "Fund B", value: 70 },
  ]);
  assert.equal(total, 100);
  assert.deepEqual(segments.map((segment) => segment.key), ["b", "a"]);
  assert.equal(segments[0].percent, 70);
  assert.equal(segments[1].percent, 30);
});

test("aggregateComposition drops non-positive values and returns an empty result when nothing remains", () => {
  const { segments, total } = aggregateComposition([
    { key: "a", label: "Fund A", value: 0 },
    { key: "b", label: "Fund B", value: -5 },
  ]);
  assert.deepEqual(segments, []);
  assert.equal(total, 0);
});

test("aggregateComposition folds anything past the categorical cap into Other", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ key: `f${index}`, label: `Fund ${index}`, value: 10 - index }));
  const { segments } = aggregateComposition(items, 8);
  assert.equal(segments.length, 8);
  const other = segments[segments.length - 1];
  assert.equal(other.key, "other");
  assert.equal(other.label, "Other (3)");
  // Folded segment carries the summed value of the 3 lowest-ranked items (values 3,2,1).
  assert.equal(other.value, 6);
});

test("trendDelta compares the latest two numeric points and reports direction", () => {
  const up = trendDelta([{ period: "Q1", value: 100 }, { period: "Q2", value: 120 }]);
  assert.deepEqual(up, { absolute: 20, percent: 20, direction: "up" });

  const down = trendDelta([{ period: "Q1", value: 100 }, { period: "Q2", value: 80 }]);
  assert.equal(down?.direction, "down");

  const flat = trendDelta([{ period: "Q1", value: 100 }, { period: "Q2", value: 100 }]);
  assert.equal(flat?.direction, "flat");
});

test("trendDelta skips null points to find the latest two numeric values", () => {
  const delta = trendDelta([{ period: "Q1", value: 50 }, { period: "Q2", value: null }, { period: "Q3", value: 75 }]);
  assert.deepEqual(delta, { absolute: 25, percent: 50, direction: "up" });
});

test("trendDelta returns null with fewer than two numeric points", () => {
  assert.equal(trendDelta([]), null);
  assert.equal(trendDelta([{ period: "Q1", value: 10 }]), null);
  assert.equal(trendDelta([{ period: "Q1", value: null }, { period: "Q2", value: null }]), null);
});

test("trendDelta handles a zero previous value without dividing by zero", () => {
  const delta = trendDelta([{ period: "Q1", value: 0 }, { period: "Q2", value: 10 }]);
  assert.equal(delta?.absolute, 10);
  assert.equal(delta?.percent, null);
  assert.equal(delta?.direction, "up");
});
