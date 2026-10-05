import assert from "node:assert/strict";
import test from "node:test";
import { SYNC_INTERVAL_MS, SYNC_LEASE_MS, emptySyncSummary, leaseExpiry, nextRunAt } from "./source-sync-schedule.ts";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

test("a healthy connection is collected again after the interval, well inside the staleness window", () => {
  assert.equal(nextRunAt({ outcome: "succeeded", status: "active", consecutiveFailures: 0, now: NOW })?.getTime(), NOW + SYNC_INTERVAL_MS);
  assert.ok(SYNC_INTERVAL_MS < 48 * 60 * 60 * 1000);
});

test("a failure backs off with a jittered delay that doubles with the failure streak and is capped at an hour", () => {
  const delays = (failures: number) => {
    const samples = Array.from({ length: 50 }, () => nextRunAt({ outcome: "failed", status: "active", consecutiveFailures: failures, now: NOW })!.getTime() - NOW);
    return { min: Math.min(...samples), max: Math.max(...samples) };
  };
  const first = delays(1);
  assert.ok(first.min >= 30_000 && first.max <= 60_000, `one failure waits 30-60s, got ${first.min}-${first.max}`);
  const third = delays(3);
  assert.ok(third.min >= 120_000 && third.max <= 240_000, `three failures wait 2-4 minutes, got ${third.min}-${third.max}`);
  const many = delays(40);
  assert.ok(many.max <= 60 * 60_000 && many.min >= 30 * 60_000, "never longer than an hour");
});

test("a connection that is not active has no schedule: it is due the moment it is reauthorized or resumed", () => {
  for (const status of ["pending_authorization", "paused", "reauthorization_required", "suspended", "revoked"] as const) {
    for (const outcome of ["succeeded", "failed"] as const) assert.equal(nextRunAt({ outcome, status, consecutiveFailures: 3, now: NOW }), null, `${status}/${outcome}`);
  }
});

test("a claimed connection is held for the lease, which is longer than the backoff cap so a retry never overlaps its own run", () => {
  assert.equal(leaseExpiry(NOW).getTime(), NOW + SYNC_LEASE_MS);
  assert.ok(SYNC_LEASE_MS >= 60 * 60_000);
});

test("a scheduler pass summary starts empty", () => {
  assert.deepEqual(emptySyncSummary(), { due: 0, succeeded: 0, failed: 0, refused: 0, skipped: 0, errors: 0 });
});
