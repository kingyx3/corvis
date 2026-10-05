import type { ProcessingStage } from "../../../../shared/domain/enterprise.ts";
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
 * Most stages retain the short default bound. Extraction is allowed up to nine
 * minutes so bounded map/reduce inference can finish inside the worker's 600s
 * Cloud Run/PubSub deadline; its handler still owns the narrower 510s budget.
 */
export class BoundedProcessingStageEffectRouter implements ProcessingStageEffectPort {
  private readonly handlers: ProcessingStageHandlers;
  private readonly timeoutMs: number;

  constructor(handlers: ProcessingStageHandlers, timeoutMs = 30_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("processing stage timeout must be positive");
    this.handlers = handlers;
    this.timeoutMs = timeoutMs;
  }

  async execute(input: ProcessingStageEffectInput): Promise<Record<string, unknown> | void> {
    const handler = this.handlers[input.stage];
    if (!handler) throw new Error(`processing stage ${input.stage} has no configured effect handler`);

    const effectiveTimeoutMs = input.stage === "extracted" ? Math.max(this.timeoutMs, 540_000) : this.timeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProcessingStageTimeoutError(input.stage, effectiveTimeoutMs));
      }, effectiveTimeoutMs);
    });

    try {
      return await Promise.race([handler(input, controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
