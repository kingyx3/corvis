import type { ProcessingStageHandler } from "./processing-stage-effects.ts";
import { ProcessingStageBlockedError, type ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import { isReplayProcessingRun } from "./processing-run.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

const SHA256 = /^[0-9a-f]{64}$/i;

export type CanonicalizedPredecessorResult = {
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

export type ReconciliationResult = {
  reconciliationRunId: string;
  canonicalizationRunId: string;
  snapshotId: string;
  snapshotVersion: number;
  fundId: string;
  reportPeriod: string;
  schemaVersion: string;
  taxonomyVersion: string;
  observationCount: number;
  blockingExceptionCount: number;
  reconciliationReady: boolean;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`reconciled stage requires ${field}`);
  return value.trim();
}

function requiredHash(value: unknown, field: string): string {
  const valueText = requiredText(value, field).toLowerCase();
  if (!SHA256.test(valueText)) throw new Error(`reconciled stage requires valid ${field}`);
  return valueText;
}

function requiredCount(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`reconciled stage requires valid ${field}`);
  return parsed;
}

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function count(row: PostgresRow, key: string): number {
  const parsed = Number(row[key]);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`reconciled stage received invalid persisted ${key}`);
  return parsed;
}

function boolean(row: PostgresRow, key: string): boolean {
  const value = row[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`reconciled stage received invalid persisted ${key}`);
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("reconciled stage execution aborted");
}

export function canonicalizedPredecessorResult(effect: ProcessingStageEffectInput): CanonicalizedPredecessorResult {
  const predecessor = object(effect.payload.predecessorResult);
  if (!predecessor) throw new Error("reconciled stage requires predecessorResult");

  const candidateCount = requiredCount(predecessor.candidateCount, "predecessorResult.candidateCount");
  const canonicalCandidateCount = requiredCount(
    predecessor.canonicalCandidateCount,
    "predecessorResult.canonicalCandidateCount",
  );
  if (canonicalCandidateCount !== candidateCount) {
    throw new Error("reconciled stage requires complete canonical candidate persistence");
  }

  const observationCount = requiredCount(predecessor.observationCount, "predecessorResult.observationCount");
  if (observationCount <= 0) throw new Error("reconciled stage requires canonical observations");
  const sourceReferenceCount = requiredCount(
    predecessor.sourceReferenceCount,
    "predecessorResult.sourceReferenceCount",
  );
  if (sourceReferenceCount <= 0) throw new Error("reconciled stage requires canonical source references");

  return {
    canonicalizationRunId: requiredText(
      predecessor.canonicalizationRunId,
      "predecessorResult.canonicalizationRunId",
    ),
    extractionRunId: requiredText(predecessor.extractionRunId, "predecessorResult.extractionRunId"),
    reviewPolicyVersion: requiredText(
      predecessor.reviewPolicyVersion,
      "predecessorResult.reviewPolicyVersion",
    ),
    candidateSetSha256: requiredHash(
      predecessor.candidateSetSha256,
      "predecessorResult.candidateSetSha256",
    ),
    decisionSetSha256: requiredHash(
      predecessor.decisionSetSha256,
      "predecessorResult.decisionSetSha256",
    ),
    candidateCount,
    canonicalCandidateCount,
    observationCount,
    sourceReferenceCount,
  };
}

export class PostgresReconciliationRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async findExisting(input: {
    tenantId: string;
    documentId: string;
    predecessor: CanonicalizedPredecessorResult;
  }): Promise<ReconciliationResult | undefined> {
    const rows = await this.db.query(`select
        reconciliation_run_id,canonicalization_run_id,snapshot_id,snapshot_version,
        fund_id,report_period,schema_version,taxonomy_version,observation_count,
        blocking_exception_count,
        (status='ready' and blocking_exception_count=0) as reconciliation_ready
      from corvis_consolidated.reconciliation_run
      where tenant_id=$1::uuid
        and document_id=$2::uuid
        and canonicalization_run_id=$3::uuid
      limit 1`, [
      input.tenantId,
      input.documentId,
      input.predecessor.canonicalizationRunId,
    ]);
    const row = rows[0];
    return row ? this.result(row, input.predecessor) : undefined;
  }

  async reconcile(input: {
    tenantId: string;
    documentId: string;
    predecessor: CanonicalizedPredecessorResult;
    idempotencyKey: string;
  }): Promise<ReconciliationResult> {
    const rows = await this.db.query(`select * from corvis_consolidated.reconcile_canonicalization(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9
    )`, [
      input.tenantId,
      input.documentId,
      input.predecessor.canonicalizationRunId,
      input.predecessor.extractionRunId,
      input.predecessor.candidateSetSha256,
      input.predecessor.decisionSetSha256,
      input.predecessor.observationCount,
      input.predecessor.sourceReferenceCount,
      input.idempotencyKey,
    ]);
    const row = rows[0];
    if (!row) throw new Error("reconciled stage did not return reconciliation state");
    return this.result(row, input.predecessor);
  }

  private result(row: PostgresRow, predecessor: CanonicalizedPredecessorResult): ReconciliationResult {
    const result: ReconciliationResult = {
      reconciliationRunId: text(row, "reconciliation_run_id"),
      canonicalizationRunId: text(row, "canonicalization_run_id"),
      snapshotId: text(row, "snapshot_id"),
      snapshotVersion: count(row, "snapshot_version"),
      fundId: text(row, "fund_id"),
      reportPeriod: text(row, "report_period"),
      schemaVersion: text(row, "schema_version"),
      taxonomyVersion: text(row, "taxonomy_version"),
      observationCount: count(row, "observation_count"),
      blockingExceptionCount: count(row, "blocking_exception_count"),
      reconciliationReady: boolean(row, "reconciliation_ready"),
    };

    if (!result.reconciliationRunId || !result.snapshotId || !result.fundId || !result.reportPeriod) {
      throw new Error("reconciled stage received incomplete reconciliation identity");
    }
    if (result.canonicalizationRunId !== predecessor.canonicalizationRunId) {
      throw new Error("reconciled stage canonicalization lineage changed during persistence");
    }
    if (result.observationCount !== predecessor.observationCount) {
      throw new Error("reconciled stage observation count no longer matches canonical predecessor");
    }
    if (result.reconciliationReady !== (result.blockingExceptionCount === 0)) {
      throw new Error("reconciled stage readiness disagrees with blocking exceptions");
    }
    return result;
  }
}

export function createReconciledStageHandler(repository: PostgresReconciliationRepository): ProcessingStageHandler {
  return async (effect, signal) => {
    if (effect.stage !== "reconciled") throw new Error(`reconciled handler cannot execute stage ${effect.stage}`);
    assertNotAborted(signal);
    const predecessor = canonicalizedPredecessorResult(effect);
    const reused = isReplayProcessingRun(effect.payload)
      ? await repository.findExisting({
        tenantId: effect.tenantId,
        documentId: effect.documentId,
        predecessor,
      })
      : undefined;
    const result = reused ?? await repository.reconcile({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      predecessor,
      idempotencyKey: effect.idempotencyKey,
    });
    assertNotAborted(signal);

    if (!result.reconciliationReady) {
      throw new ProcessingStageBlockedError("reconciliation_required", {
        reconciliationRunId: result.reconciliationRunId,
        snapshotId: result.snapshotId,
        snapshotVersion: result.snapshotVersion,
        blockingExceptionCount: result.blockingExceptionCount,
      });
    }
    return result;
  };
}

export function createConfiguredReconciledStageHandler(db: PostgresSqlApi): ProcessingStageHandler {
  return createReconciledStageHandler(new PostgresReconciliationRepository(db));
}
