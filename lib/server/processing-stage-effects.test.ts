import { describe, expect, it, vi } from "vitest";
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

describe("BoundedProcessingStageEffectRouter", () => {
  it("routes only to the owning stage and preserves the deterministic idempotency input", async () => {
    const extracted = vi.fn(async (input: ProcessingStageEffectInput) => ({ key: input.idempotencyKey }));
    const published = vi.fn(async () => ({ published: true }));
    const router = new BoundedProcessingStageEffectRouter({ extracted, published });

    await expect(router.execute(base)).resolves.toEqual({ key: "effect-key-a" });
    expect(extracted).toHaveBeenCalledOnce();
    expect(extracted.mock.calls[0]?.[0]).toEqual(base);
    expect(published).not.toHaveBeenCalled();
  });

  it("fails closed when a production stage has no configured effect implementation", async () => {
    const router = new BoundedProcessingStageEffectRouter({});
    await expect(router.execute(base)).rejects.toThrow("has no configured effect handler");
  });

  it("aborts a slow provider handler without invoking unrelated stages", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const extracted = vi.fn(async (_input: ProcessingStageEffectInput, signal: AbortSignal) => {
        observedSignal = signal;
        await new Promise<void>(() => undefined);
      });
      const published = vi.fn(async () => ({ published: true }));
      const router = new BoundedProcessingStageEffectRouter({ extracted, published }, 50);

      const execution = router.execute(base);
      await vi.advanceTimersByTimeAsync(50);
      await expect(execution).rejects.toBeInstanceOf(ProcessingStageTimeoutError);
      expect(observedSignal?.aborted).toBe(true);
      expect(published).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an invalid timeout instead of silently disabling the execution bound", () => {
    expect(() => new BoundedProcessingStageEffectRouter({}, 0)).toThrow("timeout must be positive");
  });
});
