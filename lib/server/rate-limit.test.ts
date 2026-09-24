import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RATE_LIMIT_WINDOW_MS, RateLimitError, RateLimiter, SWEEP_THRESHOLD, enforceRateLimit } from "./rate-limit.ts";

// lib/server/http.ts intentionally imports through the "@/..." path alias
// that only Next.js's bundler resolves (see e.g. security-contract.test.ts,
// which reads route source rather than importing it for the same reason), so
// its RateLimitError -> 429 wiring is checked here by inspecting its source
// rather than importing the module directly under node:test.
test("http.ts maps RateLimitError to a 429 response with a Retry-After header", async () => {
  const source = await readFile(new URL("./http.ts", import.meta.url), "utf8");
  assert.match(source, /RateLimitError/);
  const errorBranch = source.slice(source.indexOf("instanceof RateLimitError"));
  assert.match(errorBranch, /status:\s*429/);
  assert.match(errorBranch, /retry-after/i);
  assert.match(errorBranch, /error:\s*"rate_limited"/);
});

test("requests under the limit pass through untouched", () => {
  const limiter = new RateLimiter(3, 1_000);
  const now = 1_000_000;
  assert.deepEqual(limiter.consume("tenant-a:service-x", now), { allowed: true });
  assert.deepEqual(limiter.consume("tenant-a:service-x", now + 1), { allowed: true });
  assert.deepEqual(limiter.consume("tenant-a:service-x", now + 2), { allowed: true });
});

test("requests over the limit are rejected with a Retry-After in seconds", () => {
  const limiter = new RateLimiter(2, 1_000);
  const now = 1_000_000;
  assert.equal(limiter.consume("tenant-a:service-x", now).allowed, true);
  assert.equal(limiter.consume("tenant-a:service-x", now + 10).allowed, true);
  const third = limiter.consume("tenant-a:service-x", now + 20);
  assert.equal(third.allowed, false);
  if (third.allowed) throw new Error("unreachable");
  // Window opened at `now` and is 1000ms long, so 980ms remain at now+20.
  assert.equal(third.retryAfterSeconds, 1);
});

test("the limit resets once the fixed window elapses", () => {
  const limiter = new RateLimiter(1, 1_000);
  const now = 1_000_000;
  assert.equal(limiter.consume("tenant-a:service-x", now).allowed, true);
  assert.equal(limiter.consume("tenant-a:service-x", now + 500).allowed, false);
  // Exactly at the window boundary a fresh window starts.
  assert.equal(limiter.consume("tenant-a:service-x", now + 1_000).allowed, true);
  // ...and is exhausted again until the next window.
  assert.equal(limiter.consume("tenant-a:service-x", now + 1_000).allowed, false);
});

test("distinct tenant/service-account keys have independent budgets", () => {
  const limiter = new RateLimiter(1, 1_000);
  const now = 1_000_000;
  assert.equal(limiter.consume("tenant-a:service-x", now).allowed, true);
  assert.equal(limiter.consume("tenant-a:service-x", now).allowed, false);
  assert.equal(limiter.consume("tenant-b:service-x", now).allowed, true);
  assert.equal(limiter.consume("tenant-a:service-y", now).allowed, true);
});

test("reset() clears accumulated state", () => {
  const limiter = new RateLimiter(1, 1_000);
  const now = 1_000_000;
  assert.equal(limiter.consume("tenant-a:service-x", now).allowed, true);
  assert.equal(limiter.consume("tenant-a:service-x", now).allowed, false);
  limiter.reset();
  assert.equal(limiter.consume("tenant-a:service-x", now).allowed, true);
});

test("the default window is one minute", () => {
  assert.equal(RATE_LIMIT_WINDOW_MS, 60_000);
});

test("enforceRateLimit throws a RateLimitError carrying Retry-After seconds once exhausted", () => {
  const limiter = new RateLimiter(1, 60_000);
  const now = 1_000_000;
  assert.doesNotThrow(() => enforceRateLimit("tenant-a:service-x", { limiter, now }));
  assert.throws(
    () => enforceRateLimit("tenant-a:service-x", { limiter, now: now + 1_000 }),
    (error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds === 59,
  );
});

test("expired identities are evicted instead of accumulating without bound", () => {
  const limiter = new RateLimiter(5, RATE_LIMIT_WINDOW_MS);
  const start = 1_000_000;
  for (let index = 0; index < SWEEP_THRESHOLD; index += 1) limiter.consume(`old-${index}`, start);
  assert.equal(limiter.size, SWEEP_THRESHOLD);

  // A live identity inside its window survives the sweep with its count intact.
  const live = start + RATE_LIMIT_WINDOW_MS - 1;
  for (let index = 0; index < 5; index += 1) limiter.consume("live", live);
  limiter.consume("new-key", start + RATE_LIMIT_WINDOW_MS + 1);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.consume("live", start + RATE_LIMIT_WINDOW_MS + 2).allowed, false);
});
