import assert from "node:assert/strict";
import test from "node:test";
import { createLatestRequestGate } from "../../../shared/lib/latest-request.ts";
import { SessionExpiryTracker } from "./session-expiry.ts";

test("a load with no expiry reported since it began may clear the prompt, including the first load", () => {
  const tracker = new SessionExpiryTracker();
  assert.equal(tracker.loadMayClear(), true, "nothing was ever reported");
  tracker.beginLoad();
  assert.equal(tracker.loadMayClear(), true);
});

test("an expiry reported while a load is in flight is not cleared by that load, whichever response arrives last", () => {
  const tracker = new SessionExpiryTracker();
  tracker.beginLoad();
  tracker.report(); // e.g. the notification preferences answered 401 while the workspace modules were still loading
  assert.equal(tracker.loadMayClear(), false, "the load began before the report, so it cannot vouch for the session");
  tracker.report();
  assert.equal(tracker.loadMayClear(), false, "more reports change nothing");
});

test("a Retry that starts after the report clears the prompt, and a report during that Retry keeps it", () => {
  const tracker = new SessionExpiryTracker();
  tracker.beginLoad();
  tracker.report();
  tracker.beginLoad(); // the user signed in again and retried
  assert.equal(tracker.loadMayClear(), true, "a load that started after the last report can vouch for the session");
  tracker.report();
  assert.equal(tracker.loadMayClear(), false, "an expiry reported mid-retry is still newer than the retry");
  tracker.beginLoad();
  assert.equal(tracker.loadMayClear(), true);
});

test("with overlapping loads only the latest one applies, and it is judged by its own start", async () => {
  const tracker = new SessionExpiryTracker();
  const run = createLatestRequestGate();
  const decisions: boolean[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const first = run(async () => { tracker.beginLoad(); await slow; return "first"; }, () => decisions.push(tracker.loadMayClear()));
  tracker.report();
  const second = run(async () => { tracker.beginLoad(); return "second"; }, () => decisions.push(tracker.loadMayClear()));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(decisions, [true], "the older load is dropped; the newer began after the report");
});
