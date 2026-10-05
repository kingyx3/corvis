/**
 * Shared cancellation primitives for the HTTP-backed processing stages.
 *
 * Provider calls stay bounded through body consumption. Extraction is the one
 * deliberately long-running stage: map/reduce inference may take several minutes,
 * while registration/representation and metadata calls retain the short budget.
 */

import type { ProcessingStageHandler } from "./processing-stage-effects.ts";

/** Hard limit enforced by `BoundedProcessingStageEffectRouter` (its default). */
export const STAGE_ROUTER_TIMEOUT_MS = 30_000;
/** Stage-wide budget: every provider/metadata/GCS call in one stage shares it. */
export const STAGE_EXECUTION_BUDGET_MS = 27_000;
/** Extraction-only stage budget; the router allows 540s and the worker's Cloud Run deadline is 600s. */
export const EXTRACTION_STAGE_EXECUTION_BUDGET_MS = 510_000;
/** Ceiling for a configured provider timeout: identity token (5s) + provider must fit the stage budget. */
export const MAX_PROVIDER_TIMEOUT_MS = 20_000;
/** Ceiling for the extraction provider timeout only; must fit EXTRACTION_STAGE_EXECUTION_BUDGET_MS. */
export const MAX_EXTRACTION_PROVIDER_TIMEOUT_MS = 480_000;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
export const METADATA_TIMEOUT_MS = 5_000;

export function boundedSignal(parent: AbortSignal, timeoutMs: number, label: string): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out`)), timeoutMs);
  if (parent.aborted) onAbort();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

export function withStageBudget(
  handler: ProcessingStageHandler,
  budgetMs: number = STAGE_EXECUTION_BUDGET_MS,
): ProcessingStageHandler {
  return async (effect, routerSignal) => {
    const effectiveBudget = effect.stage === "extracted"
      ? Math.max(budgetMs, EXTRACTION_STAGE_EXECUTION_BUDGET_MS)
      : budgetMs;
    const execution = boundedSignal(routerSignal, effectiveBudget, "processing stage execution budget");
    try { return await handler(effect, execution.signal); }
    finally { execution.dispose(); }
  };
}

function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    if (signal.aborted) { fail(); return; }
    listener = fail;
    signal.addEventListener("abort", fail, { once: true });
  });
  promise.catch(() => undefined);
  return { promise, dispose() { if (listener) signal.removeEventListener("abort", listener); } };
}

export async function boundedFetch<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  parent: AbortSignal,
  timeoutMs: number,
  label: string,
  read: (response: Response) => Promise<T>,
): Promise<{ response: Response; value: T }> {
  const execution = boundedSignal(parent, timeoutMs, label);
  const aborted = abortRejection(execution.signal);
  let response: Response | undefined;
  try {
    response = await Promise.race([
      fetchImpl(url, { ...init, signal: execution.signal, cache: "no-store" }),
      aborted.promise,
    ]);
    const value = await Promise.race([read(response), aborted.promise]);
    return { response, value };
  } finally {
    aborted.dispose();
    execution.dispose();
    if (response && !response.bodyUsed && response.body && !response.body.locked) {
      try { void response.body.cancel().catch(() => undefined); } catch { /* already closed */ }
    }
  }
}
