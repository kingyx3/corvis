import test from "node:test";
import assert from "node:assert/strict";
import {
  computeWebhookRetryDelayMs,
  WEBHOOK_RETRY_BASE_DELAY_MS,
  WEBHOOK_RETRY_MAX_DELAY_MS,
  WEBHOOK_RETRY_JITTER_RATIO,
} from "./delivery.ts";

function jitterBounds(base: number) {
  const range = base * WEBHOOK_RETRY_JITTER_RATIO;
  return { min: base - range, max: base + range };
}

test("attempt 1 backs off around the original 5-minute base with no jitter when random is centered", () => {
  const delay = computeWebhookRetryDelayMs(1, () => 0.5);
  assert.equal(delay, WEBHOOK_RETRY_BASE_DELAY_MS);
});

test("delay grows monotonically with attempt number before hitting the cap", () => {
  const noJitter = () => 0.5;
  const attempt1 = computeWebhookRetryDelayMs(1, noJitter);
  const attempt2 = computeWebhookRetryDelayMs(2, noJitter);
  const attempt3 = computeWebhookRetryDelayMs(3, noJitter);
  const attempt4 = computeWebhookRetryDelayMs(4, noJitter);
  assert.ok(attempt2 > attempt1, "attempt 2 should back off longer than attempt 1");
  assert.ok(attempt3 > attempt2, "attempt 3 should back off longer than attempt 2");
  assert.ok(attempt4 > attempt3, "attempt 4 should back off longer than attempt 3");
  assert.equal(attempt2, WEBHOOK_RETRY_BASE_DELAY_MS * 2);
  assert.equal(attempt3, WEBHOOK_RETRY_BASE_DELAY_MS * 4);
  assert.equal(attempt4, WEBHOOK_RETRY_BASE_DELAY_MS * 8);
});

test("delay is capped at the maximum delay for large attempt numbers", () => {
  const noJitter = () => 0.5;
  const farFuture = computeWebhookRetryDelayMs(20, noJitter);
  assert.equal(farFuture, WEBHOOK_RETRY_MAX_DELAY_MS);
  // Confirm the exponential value would have exceeded the cap without it.
  const uncappedWouldBe = WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** 19;
  assert.ok(uncappedWouldBe > WEBHOOK_RETRY_MAX_DELAY_MS);
});

test("jitter stays within +/-20% of the (possibly capped) delay across the random range", () => {
  for (const attempt of [1, 2, 3, 4, 10, 25]) {
    const base = Math.min(WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), WEBHOOK_RETRY_MAX_DELAY_MS);
    const { min, max } = jitterBounds(base);
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = computeWebhookRetryDelayMs(attempt, () => r);
      assert.ok(delay >= min - 1 && delay <= max + 1, `attempt ${attempt} r=${r} delay ${delay} out of [${min},${max}]`);
    }
  }
});

test("jitter can push the delay both above and below the unjittered value", () => {
  const base = computeWebhookRetryDelayMs(2, () => 0.5);
  const low = computeWebhookRetryDelayMs(2, () => 0);
  const high = computeWebhookRetryDelayMs(2, () => 1);
  assert.ok(low < base, "random()=0 should jitter below the base delay");
  assert.ok(high > base, "random()=1 should jitter above the base delay");
});

test("delay never goes negative even with an out-of-range random source", () => {
  const delay = computeWebhookRetryDelayMs(1, () => -5);
  assert.ok(delay >= 0);
});

test("default random source (Math.random) stays within jittered bounds", () => {
  const base = WEBHOOK_RETRY_BASE_DELAY_MS * 4; // attempt 3
  const { min, max } = jitterBounds(base);
  for (let i = 0; i < 25; i++) {
    const delay = computeWebhookRetryDelayMs(3);
    assert.ok(delay >= min - 1 && delay <= max + 1);
  }
});
