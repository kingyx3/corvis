import type { ProcessingStageHandler } from "./processing-stage-effects.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { CANDIDATE_REVIEW_POLICY_VERSION } from "./processing-reviewed-stage.ts";

const SHA256 = /^[0-9a-f]{64}$/i;

export type ReviewedPredecessorResult = {
  extractionRunId: string;
  candidateSetSha256: string;
  reviewPolicyVersion: string;
  decisionSetSha256: string;
  candidateCount: number;
  criticalCandidateCount: number;
  exceptionCandidateCount: number;
  canonicalizationReady: true;
};

export type CanonicalizationResult = {
  canonicalizationRunId: string;
  extractionRunId: string;
  reviewPolicyVersion: string;
  candidateSetSha256: string;
  decisionSetSha256: string;
  candidateCount: number;
  canonicalCandidateCount: number;
  observationCount: number;
  sourceReferenceCount: number;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`canonicalized stage requires ${field}`);
  return value.trim();
}

function requiredHash(value: unknown, field: string): string {
  const text = requiredText(value, field).toLowerCase();
  if (!SHA256.test(text)) throw new Error(`canonicalized stage requires valid ${field}`);
  return text;
}

function requiredCount(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`canonicalized stage requires valid ${field}`);
  return parsed;
}

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function count(row: PostgresRow, key: string): number {
  const parsed = Number(row[key]);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`canonicalized stage received invalid persisted ${key}`);
  }
  return parsed;
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("canonicalized stage execution aborted");
}

export function reviewedPredecessorResult(effect: ProcessingStageEffectInput): ReviewedPredecessorResult {
  const predecessor = object(effect.payload.predecessorResult);
  if (!predecessor) throw new Error("canonicalized stage requires predecessorResult");

  const reviewPolicyVersion = requiredText(predecessor.reviewPolicyVersion, "predecessorResult.reviewPolicyVersion");
  if (reviewPolicyVersion !== CANDIDATE_REVIEW_POLICY_VERSION) {
    throw new Error("canonicalized stage requires the governed candidate review policy");
  }
  if (predecessor.canonicalizationReady !== true) {
    throw new Error("canonicalized stage requires canonicalization-ready reviewed result");
  }

  return {
    extractionRunId: requiredText(predecessor.extractionRunId, "predecessorResult.extractionRunId"),
    candidateSetSha256: requiredHash(predecessor.candidateSetSha256, "predecessorResult.candidateSetSha256"),
    reviewPolicyVersion,
    decisionSetSha256: requiredHash(predecessor.decisionSetSha256, "predecessorResult.decisionSetSha256"),
    candidateCount: requiredCount(predecessor.candidateCount, "predecessorResult.candidateCount"),
    criticalCandidateCount: requiredCount(predecessor.criticalCandidateCount, "predecessorResult.criticalCandidateCount"),
    exceptionCandidateCount: requiredCount(predecessor.exceptionCandidateCount, "predecessorResult.exceptionCandidateCount"),
    canonicalizationReady: true,
  };
}

export class PostgresCanonicalizationRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async canonicalize(input: {
    tenantId: string;
    documentId: string;
    predecessor: ReviewedPredecessorResult;
    idempotencyKey: string;
  }): Promise<CanonicalizationResult> {
    const rows = await this.db.query(`select * from corvis_facts.canonicalize_reviewed_extraction(
      $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7
    )`, [
      input.tenantId,
      input.documentId,
      input.predecessor.extractionRunId,
      input.predecessor.reviewPolicyVersion,
      input.predecessor.candidateSetSha256,
      input.predecessor.decisionSetSha256,
      input.idempotencyKey,
    ]);
    const row = rows[0];
    if (!row) throw new Error("canonicalized stage did not return a finalized canonicalization run");

    const result: CanonicalizationResult = {
      canonicalizationRunId: text(row, "canonicalization_run_id"),
      extractionRunId: input.predecessor.extractionRunId,
      reviewPolicyVersion: input.predecessor.reviewPolicyVersion,
      candidateSetSha256: input.predecessor.candidateSetSha256,
      decisionSetSha256: input.predecessor.decisionSetSha256,
      candidateCount: count(row, "candidate_count"),
      canonicalCandidateCount: count(row, "canonical_candidate_count"),
      observationCount: count(row, "observation_count"),
      sourceReferenceCount: count(row, "source_reference_count"),
    };
    if (!result.canonicalizationRunId) throw new Error("canonicalized stage received missing canonicalization run id");
    if (result.candidateCount !== input.predecessor.candidateCount) {
      throw new Error("canonicalized stage candidate count no longer matches reviewed predecessor");
    }
    if (result.canonicalCandidateCount !== result.candidateCount) {
      throw new Error("canonicalized stage did not persist every reviewed candidate");
    }
    return result;
  }
}

export function createCanonicalizedStageHandler(repository: PostgresCanonicalizationRepository): ProcessingStageHandler {
  return async (effect, signal) => {
    if (effect.stage !== "canonicalized") throw new Error(`canonicalized handler cannot execute stage ${effect.stage}`);
    assertNotAborted(signal);
    const predecessor = reviewedPredecessorResult(effect);
    const result = await repository.canonicalize({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      predecessor,
      idempotencyKey: effect.idempotencyKey,
    });
    assertNotAborted(signal);
    return result;
  };
}

export function createConfiguredCanonicalizedStageHandler(db: PostgresSqlApi): ProcessingStageHandler {
  return createCanonicalizedStageHandler(new PostgresCanonicalizationRepository(db));
}
