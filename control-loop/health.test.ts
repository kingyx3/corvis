import assert from "node:assert/strict";
import test from "node:test";
import { closureDecision, DAILY_STALENESS_LIMIT_MS, evaluateHealth, healthFinding, MAX_CONSECUTIVE_FAILURES } from "./reports/health.ts";
import type { Watermark } from "./types.ts";

function watermark(overrides: Partial<Watermark> = {}): Watermark {
  return {
    schemaVersion: 1,
    lastSuccessfulDailyRunAt: null,
    lastSuccessfulWeeklyRunAt: null,
    lastWeeklyScanComplete: true,
    consecutiveFailures: 0,
    lastRunId: null,
    ...overrides,
  };
}

const NOW = new Date("2026-09-19T00:00:00.000Z");

test("no successful daily run ever recorded is unhealthy", () => {
  const health = evaluateHealth({ now: NOW, watermark: watermark(), weeklyScanComplete: true });
  assert.equal(health.healthy, false);
  assert.deepEqual(health.reasons, ["no_successful_daily_run_in_36h"]);
});

test("a daily run inside the 36-hour window is healthy on that dimension", () => {
  const recent = new Date(NOW.getTime() - (DAILY_STALENESS_LIMIT_MS - 1));
  const health = evaluateHealth({ now: NOW, watermark: watermark({ lastSuccessfulDailyRunAt: recent.toISOString() }), weeklyScanComplete: true });
  assert.equal(health.healthy, true);
});

test("a daily run exactly at or past the 36-hour boundary is unhealthy", () => {
  const stale = new Date(NOW.getTime() - DAILY_STALENESS_LIMIT_MS - 1);
  const health = evaluateHealth({ now: NOW, watermark: watermark({ lastSuccessfulDailyRunAt: stale.toISOString() }), weeklyScanComplete: true });
  assert.equal(health.healthy, false);
});

test(`${MAX_CONSECUTIVE_FAILURES} consecutive failures make the loop unhealthy even with a recent success`, () => {
  const health = evaluateHealth({
    now: NOW,
    watermark: watermark({ lastSuccessfulDailyRunAt: NOW.toISOString(), consecutiveFailures: MAX_CONSECUTIVE_FAILURES }),
    weeklyScanComplete: true,
  });
  assert.equal(health.healthy, false);
  assert.ok(health.reasons.includes("two_consecutive_failures"));
});

test("an incomplete weekly scan is unhealthy independent of daily freshness", () => {
  const health = evaluateHealth({ now: NOW, watermark: watermark({ lastSuccessfulDailyRunAt: NOW.toISOString() }), weeklyScanComplete: false });
  assert.equal(health.healthy, false);
  assert.deepEqual(health.reasons, ["incomplete_weekly_scan"]);
});

test("healthFinding returns null when healthy and a finding when not", () => {
  assert.equal(healthFinding({ healthy: true, reasons: [], automaticClosureEnabled: true }), null);
  const finding = healthFinding({ healthy: false, reasons: ["two_consecutive_failures"], automaticClosureEnabled: false });
  assert.ok(finding);
  assert.equal(finding?.ruleId, "CL-HEALTH-001");
  assert.match(finding!.detail, /two_consecutive_failures/);
});

test("closureDecision denies closure for anything but a complete, fully-scanned, healthy run", () => {
  const healthy = { healthy: true, reasons: [], automaticClosureEnabled: true };
  const unhealthy = { healthy: false, reasons: ["x"], automaticClosureEnabled: false };

  assert.equal(closureDecision({ status: "complete", health: healthy, scanComplete: true }).allowed, true);
  assert.equal(closureDecision({ status: "incomplete", health: healthy, scanComplete: true }).allowed, false);
  assert.equal(closureDecision({ status: "failed", health: healthy, scanComplete: true }).allowed, false);
  assert.equal(closureDecision({ status: "complete", health: healthy, scanComplete: false }).allowed, false);
  assert.equal(closureDecision({ status: "complete", health: unhealthy, scanComplete: true }).allowed, false);
});
