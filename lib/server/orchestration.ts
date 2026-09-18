import type { ProcessingJob, ProcessingStage } from "@/core/enterprise";

const STAGE_ORDER: ProcessingStage[] = ["registered","represented","extracted","reviewed","canonicalized","reconciled","consolidated","published"];

export function nextStage(stage: ProcessingStage): ProcessingStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  return index >= 0 && index < STAGE_ORDER.length - 1 ? STAGE_ORDER[index + 1] : null;
}

export function startAttempt(job: ProcessingJob, now = new Date().toISOString()): ProcessingJob {
  if (!["queued","retryable"].includes(job.state)) throw new Error(`Job ${job.id} cannot start from ${job.state}`);
  if (job.attempt >= job.maxAttempts) return { ...job, state: "dead_letter", updatedAt: now, version: job.version + 1 };
  return { ...job, state: "running", attempt: job.attempt + 1, updatedAt: now, version: job.version + 1, lastError: undefined };
}

export function failAttempt(job: ProcessingJob, error: string, now = new Date().toISOString()): ProcessingJob {
  if (job.state !== "running") throw new Error(`Job ${job.id} cannot fail from ${job.state}`);
  const exhausted = job.attempt >= job.maxAttempts;
  return { ...job, state: exhausted ? "dead_letter" : "retryable", lastError: error.slice(0, 2000), updatedAt: now, version: job.version + 1 };
}

export function succeedAttempt(job: ProcessingJob, now = new Date().toISOString()): ProcessingJob {
  if (job.state !== "running") throw new Error(`Job ${job.id} cannot succeed from ${job.state}`);
  return { ...job, state: "succeeded", updatedAt: now, version: job.version + 1, lastError: undefined };
}

export function retryDelayMs(attempt: number): number {
  const bounded = Math.max(1, Math.min(attempt, 8));
  return Math.min(15 * 60_000, 1_000 * 2 ** (bounded - 1));
}
