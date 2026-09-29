/**
 * Shared cancellation primitives for the HTTP-backed processing stages.
 *
 * Two rules keep a hung provider from outliving its stage:
 *
 * 1. A per-call timeout stays live until the response BODY has been read. The
 *    previous helper disposed its timer as soon as headers arrived, so a
 *    provider that trickled or stalled its body pinned the handler with no
 *    bound and no abort.
 * 2. Every call in a stage draws from one stage-wide budget that is strictly
 *    smaller than the router's hard limit, so the router's own timeout (which
 *    rejects the caller but cannot stop an orphaned handler) is never the first
 *    thing to fire and the retry cannot run alongside a still-running attempt.
 */

import type { ProcessingStageHandler } from "./processing-stage-effects.ts";

/** Hard limit enforced by `BoundedProcessingStageEffectRouter` (its default). */
export const STAGE_ROUTER_TIMEOUT_MS = 30_000;
/** Stage-wide budget: every provider/metadata/GCS call in one stage shares it. */
export const STAGE_EXECUTION_BUDGET_MS = 27_000;
/** Ceiling for a configured provider timeout: identity token (5s) + provider must fit the stage budget. */
export const MAX_PROVIDER_TIMEOUT_MS = 20_000;
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

/**
 * Wraps a stage handler so every collaborator call shares one execution budget:
 * the signal it receives aborts when the router aborts OR when the budget is
 * spent, whichever is first. The timer is released when the handler settles.
 */
export function withStageBudget(
  handler: ProcessingStageHandler,
  budgetMs: number = STAGE_EXECUTION_BUDGET_MS,
): ProcessingStageHandler {
  return async (effect, routerSignal) => {
    const execution = boundedSignal(routerSignal, budgetMs, "processing stage execution budget");
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
  // The race below may settle first; never leave an unhandled rejection behind.
  promise.catch(() => undefined);
  return { promise, dispose() { if (listener) signal.removeEventListener("abort", listener); } };
}

/**
 * Fetches `url` and runs `read` on the response (typically `.text()`,
 * `.json()` or `.arrayBuffer()`) while the timeout and parent abort are still
 * armed. Both the fetch and the read are raced against the abort signal, so a
 * body that never ends rejects even when the transport ignores the signal. An
 * unread body is cancelled so the connection is released.
 */
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
