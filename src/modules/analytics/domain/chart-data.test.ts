import assert from "node:assert/strict";
import test from "node:test";
import { aggregateComposition, compositionOmissionNote, trendDelta } from "./chart-data.ts";

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

test("trendDelta compares the latest two points and reports direction", () => {
  const up = trendDelta([{ period: "Q1", value: 100 }, { period: "Q2", value: 120 }]);
  assert.deepEqual(up, { absolute: 20, percent: 20, direction: "up" });

  const down = trendDelta([{ period: "Q1", value: 100 }, { period: "Q2", value: 80 }]);
  assert.equal(down?.direction, "down");

  const flat = trendDelta([{ period: "Q1", value: 100 }, { period: "Q2", value: 100 }]);
  assert.equal(flat?.direction, "flat");
});

test("trendDelta compares the last two points positionally, so a gap never borrows an older period", () => {
  // The prior period has no value: no "since the prior period" claim.
  assert.equal(trendDelta([{ period: "Q1", value: 100 }, { period: "Q2", value: null }, { period: "Q3", value: 120 }]), null);
  // The latest period has no value: nothing current to compare.
  assert.equal(trendDelta([{ period: "Q1", value: 100 }, { period: "Q2", value: 120 }, { period: "Q3", value: null }]), null);
  // An older gap does not matter once the last two points are present.
  assert.deepEqual(trendDelta([{ period: "Q1", value: null }, { period: "Q2", value: 50 }, { period: "Q3", value: 75 }]), { absolute: 25, percent: 50, direction: "up" });
  assert.equal(trendDelta([{ period: "Q1", value: 1 }, { period: "Q2", value: Number.NaN }]), null);
});

test("trendDelta returns null with fewer than two points", () => {
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

test("aggregateComposition surfaces omitted negative values so the total reconciles with the headline", () => {
  const { segments, total, omitted, netTotal } = aggregateComposition([
    { key: "a", label: "A", value: 100 },
    { key: "b", label: "B", value: 50 },
    { key: "c", label: "Not attributed", value: -30 },
  ]);
  assert.deepEqual(segments.map((segment) => segment.key), ["a", "b"]);
  assert.equal(total, 150);
  assert.deepEqual(omitted, { count: 1, value: -30 });
  assert.equal(netTotal, 120);
  assert.equal(total + omitted.value, netTotal);
  assert.equal(aggregateComposition([{ key: "a", label: "A", value: -5 }]).netTotal, -5);
  assert.deepEqual(aggregateComposition([{ key: "a", label: "A", value: 5 }]).omitted, { count: 0, value: 0 });
});

test("compositionOmissionNote reconciles drawn and net totals only when values were omitted", () => {
  const format = (value: number) => String(value);
  assert.equal(compositionOmissionNote(aggregateComposition([{ key: "a", label: "A", value: 5 }]), format), undefined);
  assert.equal(
    compositionOmissionNote(aggregateComposition([{ key: "a", label: "A", value: 10 }, { key: "b", label: "B", value: -3 }]), format),
    "1 negative value totalling -3 is not drawn. Drawn total 10; net total 7.",
  );
  assert.match(compositionOmissionNote(aggregateComposition([{ key: "a", label: "A", value: -1 }, { key: "b", label: "B", value: -2 }]), format) ?? "", /^2 negative values totalling -3 are not drawn/);
});
