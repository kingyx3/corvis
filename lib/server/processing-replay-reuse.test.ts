import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { createCanonicalizedStageHandler, PostgresCanonicalizationRepository } from "./processing-canonicalized-stage.ts";
import { createReconciledStageHandler, PostgresReconciliationRepository } from "./processing-reconciled-stage.ts";
import { createConsolidatedStageHandler, PostgresConsolidationRepository } from "./processing-consolidated-stage.ts";
import { createPublishedStageHandler, PostgresPublicationRepository } from "./processing-published-stage.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const extractionRunId = "33333333-3333-4333-8333-333333333333";
const canonicalizationRunId = "44444444-4444-4444-8444-444444444444";
const reconciliationRunId = "55555555-5555-4555-8555-555555555555";
const consolidationRunId = "66666666-6666-4666-8666-666666666666";
const publicationRunId = "77777777-7777-4777-8777-777777777777";
const publicationEventId = "88888888-8888-4888-8888-888888888888";
const snapshotId = "99999999-9999-4999-8999-999999999999";
const candidateSetSha256 = "a".repeat(64);
const decisionSetSha256 = "b".repeat(64);
const replayRunKey = "data-correction:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class StaticPostgres implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  readonly rows: PostgresRow[];

  constructor(rows: PostgresRow[]) {
    this.rows = rows;
  }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.rows;
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

function effect(stage: ProcessingStageEffectInput["stage"], predecessorResult: Record<string, unknown>): ProcessingStageEffectInput {
  return {
    tenantId,
    documentId,
    jobId: `${replayRunKey}:${stage}:${documentId}`,
    stage,
    payload: { processingRunKey: replayRunKey, predecessorResult },
    idempotencyKey: `replay-effect-${stage}`,
    attempt: 1,
  };
}

test("canonicalized replay reuses exact ready canonical state instead of writing it again", async () => {
  const db = new StaticPostgres([{
    canonicalization_run_id: canonicalizationRunId,
    extraction_run_id: extractionRunId,
    review_policy_version: "candidate_review_v1",
    candidate_set_sha256: candidateSetSha256,
    decision_set_sha256: decisionSetSha256,
    candidate_count: 2,
    canonical_candidate_count: 2,
    observation_count: 2,
    source_reference_count: 3,
  }]);
  const handler = createCanonicalizedStageHandler(new PostgresCanonicalizationRepository(db));

  const result = await handler(effect("canonicalized", {
    extractionRunId,
    candidateSetSha256,
    reviewPolicyVersion: "candidate_review_v1",
    decisionSetSha256,
    candidateCount: 2,
    criticalCandidateCount: 1,
    exceptionCandidateCount: 0,
    canonicalizationReady: true,
  }), new AbortController().signal);

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0]?.sql ?? "", /from corvis_facts\.canonicalization_run/);
  assert.doesNotMatch(db.queries[0]?.sql ?? "", /canonicalize_reviewed_extraction/);
  assert.equal(result?.canonicalizationRunId, canonicalizationRunId);
});

test("reconciled replay reuses the exact deterministic reconciliation run", async () => {
  const db = new StaticPostgres([{
    reconciliation_run_id: reconciliationRunId,
    canonicalization_run_id: canonicalizationRunId,
    snapshot_id: snapshotId,
    snapshot_version: 1,
    fund_id: "fund-1",
    report_period: "2026-06-30",
    schema_version: "schema-v1",
    taxonomy_version: "taxonomy-v1",
    observation_count: 2,
    blocking_exception_count: 0,
    reconciliation_ready: true,
  }]);
  const handler = createReconciledStageHandler(new PostgresReconciliationRepository(db));

  const result = await handler(effect("reconciled", {
    canonicalizationRunId,
    extractionRunId,
    reviewPolicyVersion: "candidate_review_v1",
    candidateSetSha256,
    decisionSetSha256,
    candidateCount: 2,
    canonicalCandidateCount: 2,
    observationCount: 2,
    sourceReferenceCount: 3,
  }), new AbortController().signal);

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0]?.sql ?? "", /from corvis_consolidated\.reconciliation_run/);
  assert.doesNotMatch(db.queries[0]?.sql ?? "", /reconcile_canonicalization/);
  assert.equal(result?.reconciliationRunId, reconciliationRunId);
});

test("consolidated replay reuses exact facts instead of materializing duplicates", async () => {
  const db = new StaticPostgres([{
    consolidation_run_id: consolidationRunId,
    reconciliation_run_id: reconciliationRunId,
    snapshot_id: snapshotId,
    snapshot_version: 1,
    fund_id: "fund-1",
    report_period: "2026-06-30",
    fact_count: 2,
    source_observation_count: 2,
    consolidation_ready: true,
  }]);
  const handler = createConsolidatedStageHandler(new PostgresConsolidationRepository(db));

  const result = await handler(effect("consolidated", {
    reconciliationRunId,
    canonicalizationRunId,
    snapshotId,
    snapshotVersion: 1,
    fundId: "fund-1",
    reportPeriod: "2026-06-30",
    schemaVersion: "schema-v1",
    taxonomyVersion: "taxonomy-v1",
    observationCount: 2,
    blockingExceptionCount: 0,
    reconciliationReady: true,
  }), new AbortController().signal);

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0]?.sql ?? "", /from corvis_consolidated\.consolidation_run/);
  assert.doesNotMatch(db.queries[0]?.sql ?? "", /consolidate_reconciliation/);
  assert.equal(result?.consolidationRunId, consolidationRunId);
});

test("published replay reuses exact publication history and cannot publish a duplicate version", async () => {
  const db = new StaticPostgres([{
    publication_run_id: publicationRunId,
    consolidation_run_id: consolidationRunId,
    snapshot_id: snapshotId,
    source_snapshot_version: 1,
    snapshot_version: 2,
    publication_event_id: publicationEventId,
    fact_count: 2,
    publication_ready: true,
  }]);
  const handler = createPublishedStageHandler(new PostgresPublicationRepository(db));

  const result = await handler(effect("published", {
    consolidationRunId,
    reconciliationRunId,
    snapshotId,
    snapshotVersion: 1,
    fundId: "fund-1",
    reportPeriod: "2026-06-30",
    factCount: 2,
    sourceObservationCount: 2,
    consolidationReady: true,
  }), new AbortController().signal);

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0]?.sql ?? "", /from corvis_consolidated\.publication_run/);
  assert.doesNotMatch(db.queries[0]?.sql ?? "", /publish_consolidation/);
  assert.equal(result?.publicationRunId, publicationRunId);
  assert.equal(result?.snapshotVersion, 2);
});
