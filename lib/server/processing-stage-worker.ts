import { createHash } from "crypto";
import { assertDocumentAccess, type ProcessingStage, type RequestIdentity } from "../../core/enterprise.ts";
import type {
  ProcessingStageDelivery,
  PostgresProcessingStageRepository,
} from "./orchestration-stage.ts";
import type { PostgresProcessingStageEffectRepository } from "./orchestration-stage-effect.ts";
import { countMetric } from "./telemetry.ts";

export type ProcessingStageEffectInput = {
  tenantId: string;
  documentId: string;
  jobId: string;
  stage: ProcessingStage;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempt: number;
};

export interface ProcessingStageEffectPort {
  execute(input: ProcessingStageEffectInput): Promise<Record<string, unknown> | void>;
}

type StageRepository = Pick<PostgresProcessingStageRepository, "claim" | "complete" | "block" | "fail">;
type EffectRepository = Pick<PostgresProcessingStageEffectRepository, "begin" | "complete">;

export class ProcessingStageBlockedError extends Error {
  readonly reason: string;
  readonly metadata: Record<string, unknown>;

  constructor(reason: string, metadata: Record<string, unknown> = {}) {
    super(`processing stage blocked: ${reason}`);
    this.name = "ProcessingStageBlockedError";
    this.reason = reason;
    this.metadata = metadata;
  }
}

export type ProcessingStageWorkerResult =
  | { outcome: "duplicate" }
  | { outcome: "busy"; state: string }
  | { outcome: "completed"; nextJobId?: string; nextStage?: ProcessingStage }
  | { outcome: "blocked"; reason: string; metadata: Record<string, unknown> }
  | { outcome: "retryable"; nextAttemptAt?: string }
  | { outcome: "dead_letter" }
  /** The delivery is superseded (job already succeeded/blocked/failed, or this inbox event is exhausted); acknowledge and drop it. */
  | { outcome: "stale"; state: string };

/**
 * Job states in which a non-claimed delivery is terminal for this event.
 * `claim_processing_stage_delivery` (migration 043) returns these instead of
 * raising, having already marked the inbox row `failed`.
 */
const TERMINAL_UNCLAIMED_JOB_STATES: ReadonlySet<string> = new Set(["succeeded", "blocked", "failed", "missing"]);

function effectKey(delivery: ProcessingStageDelivery): string {
  return createHash("sha256")
    .update(`${delivery.tenantId}:${delivery.jobId}:${delivery.expectedStage}:${delivery.documentId}`)
    .digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function telemetryContext(delivery: ProcessingStageDelivery) {
  return {
    correlationId: delivery.eventId,
    tenantId: delivery.tenantId,
    jobId: delivery.jobId,
    documentId: delivery.documentId,
  };
}

export async function runProcessingStageDelivery(input: {
  identity: RequestIdentity;
  delivery: ProcessingStageDelivery;
  stages: StageRepository;
  effects: EffectRepository;
  handler: ProcessingStageEffectPort;
}): Promise<ProcessingStageWorkerResult> {
  const { identity, delivery, stages, effects, handler } = input;
  if (identity.authMethod !== "service_account") throw new Error("processing stage worker requires service account identity");
  if (identity.tenantId !== delivery.tenantId) throw new Error("processing stage tenant mismatch");
  assertDocumentAccess(identity, delivery.documentId);

  const claim = await stages.claim(delivery);
  if (claim.duplicateComplete) return { outcome: "duplicate" };
  if (!claim.claimed || !claim.leaseToken) {
    // A terminally-handled delivery must be acknowledged (2xx), never answered
    // with a retryable 503/500: redelivering it can never succeed and would
    // loop in Pub/Sub or Cloud Tasks indefinitely.
    if (claim.jobState === "dead_letter") return { outcome: "dead_letter" };
    if (claim.inboxState === "failed" || TERMINAL_UNCLAIMED_JOB_STATES.has(claim.jobState)) {
      return { outcome: "stale", state: claim.jobState };
    }
    return { outcome: "busy", state: claim.jobState };
  }

  const idempotencyKey = effectKey(delivery);
  try {
    const effect = await effects.begin({
      tenantId: delivery.tenantId,
      jobId: delivery.jobId,
      effectKey: idempotencyKey,
      documentId: delivery.documentId,
      stage: delivery.expectedStage,
    });

    if (effect.shouldExecute) {
      const result = await handler.execute({
        tenantId: delivery.tenantId,
        documentId: delivery.documentId,
        jobId: delivery.jobId,
        stage: delivery.expectedStage,
        payload: delivery.payload,
        idempotencyKey,
        attempt: effect.attempt,
      });
      const recorded = await effects.complete({
        tenantId: delivery.tenantId,
        jobId: delivery.jobId,
        effectKey: idempotencyKey,
        result: result ?? {},
      });
      if (!recorded) throw new Error("processing stage effect completion was not recorded");
    }

    const completed = await stages.complete({
      tenantId: delivery.tenantId,
      consumerName: delivery.consumerName,
      eventId: delivery.eventId,
      leaseToken: claim.leaseToken,
      jobId: delivery.jobId,
    });
    if (!completed?.completed) throw new Error("processing stage completion lease was lost");
    if (delivery.expectedStage === "registered") {
      countMetric("document_pipeline.accepted", 1, telemetryContext(delivery), { stage: delivery.expectedStage });
    }
    if (delivery.expectedStage === "published" && completed.nextStage === undefined) {
      countMetric("document_pipeline.completed", 1, telemetryContext(delivery), { stage: delivery.expectedStage });
    }
    return { outcome: "completed", nextJobId: completed.nextJobId, nextStage: completed.nextStage };
  } catch (error) {
    if (error instanceof ProcessingStageBlockedError) {
      const blocked = await stages.block({
        tenantId: delivery.tenantId,
        consumerName: delivery.consumerName,
        eventId: delivery.eventId,
        leaseToken: claim.leaseToken,
        jobId: delivery.jobId,
        reason: error.reason,
      });
      if (!blocked?.blocked) throw error;
      return { outcome: "blocked", reason: error.reason, metadata: error.metadata };
    }

    const failed = await stages.fail({
      tenantId: delivery.tenantId,
      consumerName: delivery.consumerName,
      eventId: delivery.eventId,
      leaseToken: claim.leaseToken,
      jobId: delivery.jobId,
      error: errorText(error),
    });
    if (!failed) throw error;
    if (failed.nextState === "dead_letter") {
      countMetric("document_pipeline.dead_letter", 1, telemetryContext(delivery), { stage: delivery.expectedStage });
      return { outcome: "dead_letter" };
    }
    return { outcome: "retryable", nextAttemptAt: failed.nextAttemptAt };
  }
}
