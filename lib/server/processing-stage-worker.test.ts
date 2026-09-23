import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "@/core/enterprise";
import type {
  ProcessingStageClaim,
  ProcessingStageDelivery,
  PostgresProcessingStageRepository,
} from "./orchestration-stage.ts";
import {
  ProcessingStageBlockedError,
  runProcessingStageDelivery,
  type ProcessingStageEffectInput,
} from "./processing-stage-worker.ts";

type StageRepo = Pick<PostgresProcessingStageRepository, "claim" | "complete" | "block" | "fail">;

const identity: RequestIdentity = {
  subject: "worker:document-pipeline",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["api_client"],
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    documentIds: ["00000000-0000-0000-0000-000000000101"],
    sourceDocumentAccessAllowed: false,
  },
  authMethod: "service_account",
  sessionId: "worker-session",
};

const delivery: ProcessingStageDelivery = {
  tenantId: identity.tenantId,
  consumerName: "document-representation-worker",
  eventId: "00000000-0000-0000-0000-000000000111",
  eventType: "DocumentRegistered",
  documentId: "00000000-0000-0000-0000-000000000101",
  jobId: "registered:00000000-0000-0000-0000-000000000101",
  expectedStage: "registered",
  payload: { documentId: "00000000-0000-0000-0000-000000000101" },
  payloadSha256: "abc123",
};

function claimedStages(overrides: Partial<ProcessingStageClaim> = {}): StageRepo {
  return {
    async claim() {
      return {
        claimed: true,
        duplicateComplete: false,
        leaseToken: "00000000-0000-0000-0000-000000000222",
        attempt: 1,
        inboxState: "processing",
        jobVersion: 2,
        jobState: "running",
        ...overrides,
      };
    },
    async complete() {
      return { completed: true, completedJobVersion: 3, nextJobId: "represented:x", nextStage: "represented" };
    },
    async block() {
      return { blocked: true, jobVersion: 3 };
    },
    async fail() {
      return { nextState: "retryable", jobVersion: 3, inboxAttempt: 1, nextAttemptAt: "2026-09-19T10:00:00Z" };
    },
  };
}

test("worker requires a service-account identity before claiming delivery", async () => {
  let claimed = false;
  const stages = claimedStages();
  const originalClaim = stages.claim;
  stages.claim = async (input) => { claimed = true; return originalClaim(input); };
  await assert.rejects(() => runProcessingStageDelivery({
    identity: { ...identity, authMethod: "oidc" },
    delivery,
    stages,
    effects: { async begin() { throw new Error("unexpected"); }, async complete() { return true; } },
    handler: { async execute() {} },
  }), /service account identity/);
  assert.equal(claimed, false);
});

test("worker rejects cross-tenant and out-of-entitlement deliveries before side effects", async () => {
  await assert.rejects(() => runProcessingStageDelivery({
    identity,
    delivery: { ...delivery, tenantId: "00000000-0000-0000-0000-000000000099" },
    stages: claimedStages(),
    effects: { async begin() { throw new Error("unexpected"); }, async complete() { return true; } },
    handler: { async execute() {} },
  }), /tenant mismatch/);

  await assert.rejects(() => runProcessingStageDelivery({
    identity,
    delivery: { ...delivery, documentId: "00000000-0000-0000-0000-000000000999" },
    stages: claimedStages(),
    effects: { async begin() { throw new Error("unexpected"); }, async complete() { return true; } },
    handler: { async execute() {} },
  }), /access denied/i);
});

test("duplicate-complete delivery performs no stage effect", async () => {
  let executions = 0;
  const result = await runProcessingStageDelivery({
    identity,
    delivery,
    stages: claimedStages({ claimed: false, duplicateComplete: true, leaseToken: undefined, inboxState: "complete", jobState: "succeeded" }),
    effects: { async begin() { throw new Error("unexpected"); }, async complete() { return true; } },
    handler: { async execute() { executions += 1; } },
  });
  assert.deepEqual(result, { outcome: "duplicate" });
  assert.equal(executions, 0);
});

test("terminally-handled unclaimed deliveries are acknowledged, not reported busy", async () => {
  const noEffects = { async begin(): Promise<never> { throw new Error("unexpected"); }, async complete() { return true; } };
  const cases: Array<[Partial<ProcessingStageClaim>, unknown]> = [
    // Exhausted job dead-lettered by claim_processing_stage_delivery (migration 043).
    [{ inboxState: "failed", jobState: "dead_letter" }, { outcome: "dead_letter" }],
    // Superseded delivery for a job that already moved on.
    [{ inboxState: "failed", jobState: "succeeded" }, { outcome: "stale", state: "succeeded" }],
    [{ inboxState: "retryable", jobState: "blocked" }, { outcome: "stale", state: "blocked" }],
    // Inbox event exhausted while the job still waits on a newer event.
    [{ inboxState: "failed", jobState: "retryable" }, { outcome: "stale", state: "retryable" }],
    // Genuinely transient: another delivery holds the job lease.
    [{ inboxState: "processing", jobState: "running" }, { outcome: "busy", state: "running" }],
    [{ inboxState: "retryable", jobState: "retryable" }, { outcome: "busy", state: "retryable" }],
  ];
  for (const [claim, expected] of cases) {
    let executions = 0;
    const result = await runProcessingStageDelivery({
      identity,
      delivery,
      stages: claimedStages({ claimed: false, duplicateComplete: false, leaseToken: undefined, ...claim }),
      effects: noEffects,
      handler: { async execute() { executions += 1; } },
    });
    assert.deepEqual(result, expected, JSON.stringify(claim));
    assert.equal(executions, 0);
  }
});

test("completed effect is not executed again after redelivery", async () => {
  let executions = 0;
  let completed = 0;
  const result = await runProcessingStageDelivery({
    identity,
    delivery,
    stages: claimedStages(),
    effects: {
      async begin() { return { shouldExecute: false, alreadyComplete: true, attempt: 2 }; },
      async complete() { completed += 1; return true; },
    },
    handler: { async execute() { executions += 1; } },
  });
  assert.equal(result.outcome, "completed");
  assert.equal(executions, 0);
  assert.equal(completed, 0);
});

test("governed human review blocks without completing effect or consuming technical retries", async () => {
  let effectCompletions = 0;
  let blockCalls = 0;
  let failCalls = 0;
  let stageCompletions = 0;
  const stages = claimedStages();
  stages.complete = async () => { stageCompletions += 1; return { completed: true, completedJobVersion: 3 }; };
  stages.block = async (input) => {
    blockCalls += 1;
    assert.equal(input.reason, "review_required");
    return { blocked: true, jobVersion: 3 };
  };
  stages.fail = async () => {
    failCalls += 1;
    return { nextState: "dead_letter", jobVersion: 3, inboxAttempt: 5 };
  };

  const result = await runProcessingStageDelivery({
    identity,
    delivery: { ...delivery, jobId: `reviewed:${delivery.documentId}`, expectedStage: "reviewed" },
    stages,
    effects: {
      async begin() { return { shouldExecute: true, alreadyComplete: false, attempt: 1 }; },
      async complete() { effectCompletions += 1; return true; },
    },
    handler: {
      async execute() {
        throw new ProcessingStageBlockedError("review_required", { blockingCandidateCount: 2 });
      },
    },
  });

  assert.deepEqual(result, {
    outcome: "blocked",
    reason: "review_required",
    metadata: { blockingCandidateCount: 2 },
  });
  assert.equal(blockCalls, 1);
  assert.equal(failCalls, 0);
  assert.equal(stageCompletions, 0);
  assert.equal(effectCompletions, 0);
});

test("crash/redelivery reuses the same deterministic idempotency key", async () => {
  const seen: ProcessingStageEffectInput[] = [];
  let failCalls = 0;
  let effectAttempts = 0;
  const stages = claimedStages();
  stages.fail = async () => {
    failCalls += 1;
    return { nextState: "retryable", jobVersion: 3, inboxAttempt: 1, nextAttemptAt: "2026-09-19T10:00:00Z" };
  };
  const effects = {
    async begin() { effectAttempts += 1; return { shouldExecute: true, alreadyComplete: false, attempt: effectAttempts }; },
    async complete() { return true; },
  };
  let first = true;
  const handler = {
    async execute(input: ProcessingStageEffectInput) {
      seen.push(input);
      if (first) { first = false; throw new Error("crash after provider write"); }
      return { externalWrite: "already-applied" };
    },
  };

  const firstResult = await runProcessingStageDelivery({ identity, delivery, stages, effects, handler });
  assert.equal(firstResult.outcome, "retryable");
  const secondResult = await runProcessingStageDelivery({ identity, delivery, stages, effects, handler });
  assert.equal(secondResult.outcome, "completed");
  assert.equal(failCalls, 1);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.idempotencyKey, seen[1]?.idempotencyKey);
  assert.equal(seen[0]?.jobId, delivery.jobId);
});

test("handler failure delegates authoritative retry/dead-letter transition", async () => {
  let failedError = "";
  const stages = claimedStages();
  stages.fail = async (input) => {
    failedError = input.error;
    return { nextState: "dead_letter", jobVersion: 4, inboxAttempt: 5, nextAttemptAt: undefined };
  };
  const result = await runProcessingStageDelivery({
    identity,
    delivery,
    stages,
    effects: {
      async begin() { return { shouldExecute: true, alreadyComplete: false, attempt: 1 }; },
      async complete() { return true; },
    },
    handler: { async execute() { throw new Error("permanent stage failure"); } },
  });
  assert.deepEqual(result, { outcome: "dead_letter" });
  assert.equal(failedError, "permanent stage failure");
});
