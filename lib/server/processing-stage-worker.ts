import { createHash } from "crypto";
import { assertDocumentAccess, type ProcessingStage, type RequestIdentity } from "../../core/enterprise.ts";
import type {
  ProcessingStageDelivery,
  PostgresProcessingStageRepository,
} from "./orchestration-stage.ts";
import type { PostgresProcessingStageEffectRepository } from "./orchestration-stage-effect.ts";

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
  | { outcome: "dead_letter" };

function effectKey(delivery: ProcessingStageDelivery): string {
  return createHash("sha256")
    .update(`${delivery.tenantId}:${delivery.jobId}:${delivery.expectedStage}:${delivery.documentId}`)
    .digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (!claim.claimed || !claim.leaseToken) return { outcome: "busy", state: claim.jobState };

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
    return failed.nextState === "retryable"
      ? { outcome: "retryable", nextAttemptAt: failed.nextAttemptAt }
      : { outcome: "dead_letter" };
  }
}
