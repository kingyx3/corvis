import test from "node:test";
import assert from "node:assert/strict";
import type { ProcessingJob } from "../../core/enterprise.ts";
import { failAttempt, nextStage, retryDelayMs, startAttempt, succeedAttempt } from "./orchestration.ts";

const job: ProcessingJob = { id: "job-1", documentId: "doc-1", tenantId: "tenant-1", stage: "extracted", state: "queued", attempt: 0, maxAttempts: 2, correlationId: "corr-1", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

test("stage order is deterministic", () => {
  assert.equal(nextStage("registered"), "represented");
  assert.equal(nextStage("published"), null);
});

test("jobs retry then dead-letter after bounded attempts", () => {
  const first = startAttempt(job);
  assert.equal(first.attempt, 1);
  const retryable = failAttempt(first, "temporary");
  assert.equal(retryable.state, "retryable");
  const second = startAttempt(retryable);
  const dead = failAttempt(second, "still broken");
  assert.equal(dead.state, "dead_letter");
});

test("success is terminal for the attempt", () => {
  assert.equal(succeedAttempt(startAttempt(job)).state, "succeeded");
});

test("retry backoff is bounded", () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.ok(retryDelayMs(99) <= 15 * 60_000);
});
