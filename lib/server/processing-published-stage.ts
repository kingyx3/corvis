import type { ProcessingStageHandler } from "./processing-stage-effects.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

export type ConsolidatedPredecessorResult = {
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

export type PublicationResult = {
  publicationRunId: string;
  consolidationRunId: string;
  snapshotId: string;
  sourceSnapshotVersion: number;
  snapshotVersion: number;
  publicationEventId: string;
  factCount: number;
  publicationReady: true;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`published stage requires ${field}`);
  return value.trim();
}

function requiredCount(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`published stage requires valid ${field}`);
  return parsed;
}

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function count(row: PostgresRow, key: string): number {
  const parsed = Number(row[key]);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`published stage received invalid persisted ${key}`);
  }
  return parsed;
}

function boolean(row: PostgresRow, key: string): boolean {
  const value = row[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`published stage received invalid persisted ${key}`);
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("published stage execution aborted");
}

export function consolidatedPredecessorResult(effect: ProcessingStageEffectInput): ConsolidatedPredecessorResult {
  const predecessor = object(effect.payload.predecessorResult);
  if (!predecessor) throw new Error("published stage requires predecessorResult");
  if (predecessor.consolidationReady !== true) {
    throw new Error("published stage requires consolidation-ready predecessor result");
  }

  const snapshotVersion = requiredCount(predecessor.snapshotVersion, "predecessorResult.snapshotVersion");
  if (snapshotVersion <= 0) throw new Error("published stage requires positive snapshot version");
  const factCount = requiredCount(predecessor.factCount, "predecessorResult.factCount");
  if (factCount <= 0) throw new Error("published stage requires consolidated facts");
  const sourceObservationCount = requiredCount(
    predecessor.sourceObservationCount,
    "predecessorResult.sourceObservationCount",
  );
  if (sourceObservationCount <= 0) throw new Error("published stage requires source observations");

  return {
    consolidationRunId: requiredText(predecessor.consolidationRunId, "predecessorResult.consolidationRunId"),
    reconciliationRunId: requiredText(predecessor.reconciliationRunId, "predecessorResult.reconciliationRunId"),
    snapshotId: requiredText(predecessor.snapshotId, "predecessorResult.snapshotId"),
    snapshotVersion,
    fundId: requiredText(predecessor.fundId, "predecessorResult.fundId"),
    reportPeriod: requiredText(predecessor.reportPeriod, "predecessorResult.reportPeriod"),
    factCount,
    sourceObservationCount,
    consolidationReady: true,
  };
}

export class PostgresPublicationRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async publish(input: {
    tenantId: string;
    documentId: string;
    predecessor: ConsolidatedPredecessorResult;
    idempotencyKey: string;
  }): Promise<PublicationResult> {
    const rows = await this.db.query(`select * from corvis_consolidated.publish_consolidation(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6
    )`, [
      input.tenantId,
      input.documentId,
      input.predecessor.consolidationRunId,
      input.predecessor.snapshotId,
      input.predecessor.snapshotVersion,
      input.idempotencyKey,
    ]);
    const row = rows[0];
    if (!row) throw new Error("published stage did not return publication state");
    if (!boolean(row, "publication_ready")) {
      throw new Error("published stage persistence did not become ready");
    }

    const result: PublicationResult = {
      publicationRunId: text(row, "publication_run_id"),
      consolidationRunId: text(row, "consolidation_run_id"),
      snapshotId: text(row, "snapshot_id"),
      sourceSnapshotVersion: count(row, "source_snapshot_version"),
      snapshotVersion: count(row, "snapshot_version"),
      publicationEventId: text(row, "publication_event_id"),
      factCount: count(row, "fact_count"),
      publicationReady: true,
    };

    if (!result.publicationRunId || !result.publicationEventId || !result.snapshotId) {
      throw new Error("published stage received incomplete publication identity");
    }
    if (result.consolidationRunId !== input.predecessor.consolidationRunId) {
      throw new Error("published stage consolidation lineage changed during persistence");
    }
    if (result.snapshotId !== input.predecessor.snapshotId) {
      throw new Error("published stage snapshot identity changed during persistence");
    }
    if (result.sourceSnapshotVersion !== input.predecessor.snapshotVersion) {
      throw new Error("published stage source snapshot version changed during persistence");
    }
    if (result.snapshotVersion !== result.sourceSnapshotVersion + 1) {
      throw new Error("published stage did not create the next immutable snapshot version");
    }
    if (result.factCount < input.predecessor.factCount) {
      throw new Error("published stage snapshot lost consolidated facts");
    }
    return result;
  }
}

export function createPublishedStageHandler(repository: PostgresPublicationRepository): ProcessingStageHandler {
  return async (effect, signal) => {
    if (effect.stage !== "published") throw new Error(`published handler cannot execute stage ${effect.stage}`);
    assertNotAborted(signal);
    const predecessor = consolidatedPredecessorResult(effect);
    const result = await repository.publish({
      tenantId: effect.tenantId,
      documentId: effect.documentId,
      predecessor,
      idempotencyKey: effect.idempotencyKey,
    });
    assertNotAborted(signal);
    return result;
  };
}

export function createConfiguredPublishedStageHandler(db: PostgresSqlApi): ProcessingStageHandler {
  return createPublishedStageHandler(new PostgresPublicationRepository(db));
}
