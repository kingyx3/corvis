import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import { BoundedProcessingStageEffectRouter, ProcessingStageTimeoutError } from "./processing-stage-effects.ts";

const base: ProcessingStageEffectInput = {
  tenantId: "tenant-a",
  documentId: "document-a",
  jobId: "job-a",
  stage: "extracted",
  payload: { sourceGeneration: "7" },
  idempotencyKey: "effect-key-a",
  attempt: 1,
};

test("routes only to the owning stage and preserves the deterministic idempotency input", async () => {
  let extractedCalls = 0;
  let publishedCalls = 0;
  let observedInput: ProcessingStageEffectInput | undefined;
  const router = new BoundedProcessingStageEffectRouter({
    extracted: async (input) => {
      extractedCalls += 1;
      observedInput = input;
      return { key: input.idempotencyKey };
    },
    published: async () => {
      publishedCalls += 1;
      return { published: true };
    },
  });

  assert.deepEqual(await router.execute(base), { key: "effect-key-a" });
  assert.equal(extractedCalls, 1);
  assert.deepEqual(observedInput, base);
  assert.equal(publishedCalls, 0);
});

test("fails closed when a production stage has no configured effect implementation", async () => {
  const router = new BoundedProcessingStageEffectRouter({});
  await assert.rejects(router.execute(base), /has no configured effect handler/);
});

test("aborts a slow provider handler without invoking unrelated stages", async () => {
  let observedSignal: AbortSignal | undefined;
  let publishedCalls = 0;
  const router = new BoundedProcessingStageEffectRouter(
    {
      extracted: async (_input, signal) => {
        observedSignal = signal;
        await new Promise<void>(() => undefined);
      },
      published: async () => {
        publishedCalls += 1;
        return { published: true };
      },
    },
    10,
  );

  await assert.rejects(router.execute(base), ProcessingStageTimeoutError);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(publishedCalls, 0);
});

test("rejects an invalid timeout instead of silently disabling the execution bound", () => {
  assert.throws(() => new BoundedProcessingStageEffectRouter({}, 0), /timeout must be positive/);
});
