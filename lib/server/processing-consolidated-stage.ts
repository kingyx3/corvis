import type { ProcessingStageHandler } from "./processing-stage-effects.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import { isReplayProcessingRun } from "./processing-run.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

export type ReconciledPredecessorResult = {
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
  reconciliationReady: true;
};

export type ConsolidationResult = {
  consolidationRunId: string;
  reconciliationRunId: string;
  snapshotId: string;
  snapshotVersion: number;
  fundId: string;
  reportPeriod: string;
  factCount: number;
  sourceObservationCount: number;
  consolidationReady: true;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`consolidated stage requires ${field}`);
  return value.trim();
}

function requiredCount(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`consolidated stage requires valid ${field}`);
  return parsed;
}

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function count(row: PostgresRow, key: string): number {
  const parsed = Number(row[key]);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`consolidated stage received invalid persisted ${key}`);
  }
  return parsed;
}

function boolean(row: PostgresRow, key: string): boolean {
  const value = row[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`consolidated stage received invalid persisted ${key}`);
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("consolidated stage execution aborted");
}

export function reconciledPredecessorResult(effect: ProcessingStageEffectInput): ReconciledPredecessorResult {
  const predecessor = object(effect.payload.predecessorResult);
  if (!predecessor) throw new Error("consolidated stage requires predecessorResult");
  if (predecessor.reconciliationReady !== true) {
    throw new Error("consolidated stage requires reconciliation-ready predecessor result");
  }

  const blockingExceptionCount = requiredCount(
    predecessor.blockingExceptionCount,
    "predecessorResult.blockingExceptionCount",
  );
  if (blockingExceptionCount !== 0) {
    throw new Error("consolidated stage requires zero blocking reconciliation exceptions");
  }
  const observationCount = requiredCount(predecessor.observationCount, "predecessorResult.observationCount");
  if (observationCount <= 0) throw new Error("consolidated stage requires reconciled observations");
  const snapshotVersion = requiredCount(predecessor.snapshotVersion, "predecessorResult.snapshotVersion");
  if (snapshotVersion <= 0) throw new Error("consolidated stage requires positive snapshot version");

  return {
    reconciliationRunId: requiredText(predecessor.reconciliationRunId, "predecessorResult.reconciliationRunId"),
    canonicalizationRunId: requiredText(
      predecessor.canonicalizationRunId,
      "predecessorResult.canonicalizationRunId",
    ),
    snapshotId: requiredText(predecessor.snapshotId, "predecessorResult.snapshotId"),
    snapshotVersion,
    fundId: requiredText(predecessor.fundId, "predecessorResult.fundId"),
    reportPeriod: requiredText(predecessor.reportPeriod, "predecessorResult.reportPeriod"),
    schemaVersion: requiredText(predecessor.schemaVersion, "predecessorResult.schemaVersion"),
    taxonomyVersion: requiredText(predecessor.taxonomyVersion, "predecessorResult.taxonomyVersion"),
    observationCount,
    blockingExceptionCount,
    reconciliationReady: true,
  };
}

export class PostgresConsolidationRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async findExisting(input: {
    tenantId: string;
    documentId: string;
    predecessor: ReconciledPredecessorResult;
  }): Promise<ConsolidationResult | undefined> {
    const rows = await this.db.query(`select
        c.consolidation_run_id,c.reconciliation_run_id,c.snapshot_id,c.snapshot_version,
        r.fund_id,r.report_period,c.fact_count,c.source_observation_count,true as consolidation_ready
      from corvis_consolidated.consolidation_run c
      join corvis_consolidated.reconciliation_run r
        on r.tenant_id=c.tenant_id and r.reconciliation_run_id=c.reconciliation_run_id
      where c.tenant_id=$1::uuid
        and c.document_id=$2::uuid
        and c.reconciliation_run_id=$3::uuid
        and c.snapshot_id=$4::uuid
        and c.snapshot_version=$5
        and c.status='ready'
      limit 1`, [
      input.tenantId,
      input.documentId,
      input.predecessor.reconciliationRunId,
      input.predecessor.snapshotId,
      input.predecessor.snapshotVersion,
    ]);
    const row = rows[0];
    return row ? this.result(row, input.predecessor) : undefined;
  }

  async consolidate(input: {
    tenantId: string;
    documentId: string;
    predecessor: ReconciledPredecessorResult;
    idempotencyKey: string;
  }): Promise<ConsolidationResult> {
    const rows = await this.db.query(`select * from corvis_consolidated.consolidate_reconciliation(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7
    )`, [
      input.tenantId,
      input.documentId,
      input.predecessor.reconciliationRunId,
      input.predecessor.snapshotId,
      input.predecessor.snapshotVersion,
      input.predecessor.observationCount,
      input.idempotencyKey,
    ]);
    const row = rows[0];
    if (!row) throw new Error("consolidated stage did not return consolidation state");
    return this.result(row, input.predecessor);
  }

  private result(row: PostgresRow, predecessor: ReconciledPredecessorResult): ConsolidationResult {
    const ready = boolean(row, "consolidation_ready");
    const result: ConsolidationResult = {
      consolidationRunId: text(row, "consolidation_run_id"),
      reconciliationRunId: text(row, "reconciliation_run_id"),
      snapshotId: text(row, "snapshot_id"),
      snapshotVersion: count(row, "snapshot_version"),
      fundId: text(row, "fund_id"),
      reportPeriod: text(row, "report_period"),
      factCount: count(row, "fact_count"),
      sourceObservationCount: count(row, "source_observation_count"),
      consolidationReady: ready as true,
    };

    if (!ready) throw new Error("consolidated stage persistence did not become ready");
    if (!result.consolidationRunId || !result.reconciliationRunId || !result.snapshotId) {
      throw new Error("consolidated stage received incomplete consolidation identity");
    }
    if (result.reconciliationRunId !== predecessor.reconciliationRunId) {
      throw new Error("consolidated stage reconciliation lineage changed during persistence");
    }
    if (result.snapshotId !== predecessor.snapshotId || result.snapshotVersion !== predecessor.snapshotVersion) {
      throw new Error("consolidated stage snapshot lineage changed during persistence");
    }
    if (result.fundId !== predecessor.fundId || result.reportPeriod !== predecessor.reportPeriod) {
      throw new Error("consolidated stage fund-period lineage changed during persistence");
    }
    if (result.sourceObservationCount !== predecessor.observationCount) {
      throw new Error("consolidated stage source observation count changed during persistence");
    }
    if (result.factCount <= 0) throw new Error("consolidated stage persisted no facts");
    return result;
  }
}

export function createConsolidatedStageHandler(repository: PostgresConsolidationRepository): ProcessingStageHandler {
  return async (effect, signal) => {
    if (effect.stage !== "consolidated") {
      throw new Error(`consolidated handler cannot execute stage ${effect.stage}`);
    }
    assertNotAborted(signal);
    const predecessor = reconciledPredecessorResult(effect);
    const reused = isReplayProcessingRun(effect.payload)
      ? await repository.findExisting({
        tenantId: effect.tenantId,
        documentId: effect.documentId,
        predecessor,
      })
      : undefined;
    const result = reused ?? await repository.consolidate({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      predecessor,
      idempotencyKey: effect.idempotencyKey,
    });
    assertNotAborted(signal);
    return result;
  };
}

export function createConfiguredConsolidatedStageHandler(db: PostgresSqlApi): ProcessingStageHandler {
  return createConsolidatedStageHandler(new PostgresConsolidationRepository(db));
}
