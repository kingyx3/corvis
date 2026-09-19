import type { ProcessingStage } from "../../core/enterprise.ts";
import type { ProcessingStageEffectInput, ProcessingStageEffectPort } from "./processing-stage-worker.ts";

export type ProcessingStageHandler = (input: ProcessingStageEffectInput, signal: AbortSignal) => Promise<Record<string, unknown> | void>;

export type ProcessingStageHandlers = Partial<Record<ProcessingStage, ProcessingStageHandler>>;

export class ProcessingStageTimeoutError extends Error {
  readonly stage: ProcessingStage;
  readonly timeoutMs: number;

  constructor(stage: ProcessingStage, timeoutMs: number) {
    super(`processing stage ${stage} exceeded its execution timeout`);
    this.name = "ProcessingStageTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Provider-neutral production stage dispatcher.
 *
 * Every concrete extraction/canonical/publication integration is injected behind a
 * stage-local handler. Missing handlers fail closed, and each external stage gets
 * a cancellation signal with a hard upper bound so one provider cannot pin the
 * processing worker indefinitely. The deterministic idempotency key is created by
 * the worker and passed through unchanged to the stage implementation.
 */
export class BoundedProcessingStageEffectRouter implements ProcessingStageEffectPort {
  constructor(
    private readonly handlers: ProcessingStageHandlers,
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("processing stage timeout must be positive");
  }

  async execute(input: ProcessingStageEffectInput): Promise<Record<string, unknown> | void> {
    const handler = this.handlers[input.stage];
    if (!handler) throw new Error(`processing stage ${input.stage} has no configured effect handler`);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProcessingStageTimeoutError(input.stage, this.timeoutMs));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([handler(input, controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
