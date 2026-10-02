import assert from "node:assert/strict";
import test from "node:test";
import { compareReceivedNewestFirst, formatReceivedTime } from "./received-time.ts";

test("machine timestamps are formatted and every other label is shown as given", () => {
  const upper = (value: string) => `fmt(${value})`;
  assert.equal(formatReceivedTime("2026-07-01T14:02:11.000Z", upper), "fmt(2026-07-01T14:02:11.000Z)");
  assert.equal(formatReceivedTime("2026-07-01 14:02:11+00", upper), "fmt(2026-07-01 14:02:11+00)");
  for (const label of ["Just now", "18 Sep, 08:31", "24m ago", "—", ""]) assert.equal(formatReceivedTime(label, upper), label);
});

test("received sorting compares real times, not their text, and keeps this session's uploads first", () => {
  const sorted = [
    "2026-07-01T09:00:00.000+08:00", // 01:00Z, but sorts after "…T02:00Z" as text
    "2026-07-01T02:00:00.000Z",
    "Just now",
    "2026-06-30T23:59:59.000Z",
  ].sort(compareReceivedNewestFirst);
  assert.deepEqual(sorted, ["Just now", "2026-07-01T02:00:00.000Z", "2026-07-01T09:00:00.000+08:00", "2026-06-30T23:59:59.000Z"]);
  assert.deepEqual(["18 Sep, 07:54", "18 Sep, 08:31"].sort(compareReceivedNewestFirst), ["18 Sep, 08:31", "18 Sep, 07:54"]);
});
