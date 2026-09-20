import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  canonicalizedPredecessorResult,
  createReconciledStageHandler,
  PostgresReconciliationRepository,
} from "./processing-reconciled-stage.ts";
import { ProcessingStageBlockedError, type ProcessingStageEffectInput } from "./processing-stage-worker.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const canonicalizationRunId = "33333333-3333-4333-8333-333333333333";
const extractionRunId = "44444444-4444-4444-8444-444444444444";
const reconciliationRunId = "55555555-5555-4555-8555-555555555555";
const snapshotId = "66666666-6666-4666-8666-666666666666";
const candidateSetSha256 = "a".repeat(64);
const decisionSetSha256 = "b".repeat(64);

const base: ProcessingStageEffectInput = {
  tenantId,
  documentId,
  jobId: `reconciled:${documentId}`,
  stage: "reconciled",
  payload: {
    predecessorJobId: `canonicalized:${documentId}`,
    predecessorResult: {
      canonicalizationRunId,
      extractionRunId,
      reviewPolicyVersion: "candidate_review_v1",
      candidateSetSha256,
      decisionSetSha256,
      candidateCount: 4,
      canonicalCandidateCount: 4,
      observationCount: 2,
      sourceReferenceCount: 5,
    },
  },
  idempotencyKey: "effect-key-reconciled",
  attempt: 1,
};

class FakePostgres implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [{
    reconciliation_run_id: reconciliationRunId,
    canonicalization_run_id: canonicalizationRunId,
    snapshot_id: snapshotId,
    snapshot_version: 1,
    fund_id: "fund-1",
    report_period: "2026-06-30",
    schema_version: "schema-v1",
    taxonomy_version: "metric-definitions-md5:abc",
    observation_count: 2,
    blocking_exception_count: 0,
    reconciliation_ready: true,
  }];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.rows;
  }

  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("reconciled stage accepts exact canonicalized predecessor lineage", () => {
  assert.deepEqual(canonicalizedPredecessorResult(base), {
    canonicalizationRunId,
    extractionRunId,
    reviewPolicyVersion: "candidate_review_v1",
    candidateSetSha256,
    decisionSetSha256,
    candidateCount: 4,
    canonicalCandidateCount: 4,
    observationCount: 2,
    sourceReferenceCount: 5,
  });
});

test("reconciled stage rejects incomplete canonical persistence", () => {
  const predecessor = base.payload.predecessorResult as Record<string, unknown>;
  const cases: Array<{ patch: Record<string, unknown>; error: RegExp }> = [
    { patch: { candidateSetSha256: "invalid" }, error: /valid predecessorResult\.candidateSetSha256/ },
    { patch: { decisionSetSha256: "invalid" }, error: /valid predecessorResult\.decisionSetSha256/ },
    { patch: { canonicalCandidateCount: 3 }, error: /complete canonical candidate persistence/ },
    { patch: { observationCount: 0 }, error: /requires canonical observations/ },
    { patch: { sourceReferenceCount: 0 }, error: /requires canonical source references/ },
  ];

  for (const item of cases) {
    assert.throws(
      () => canonicalizedPredecessorResult({
        ...base,
        payload: { predecessorResult: { ...predecessor, ...item.patch } },
      }),
      item.error,
    );
  }
});

test("Postgres reconciliation repository passes exact lineage and idempotency key", async () => {
  const db = new FakePostgres();
  const repository = new PostgresReconciliationRepository(db);
  const predecessor = canonicalizedPredecessorResult(base);
  const result = await repository.reconcile({
    tenantId,
    documentId,
    predecessor,
    idempotencyKey: base.idempotencyKey,
  });

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0]?.sql ?? "", /corvis_consolidated\.reconcile_canonicalization/);
  assert.deepEqual(db.queries[0]?.parameters, [
    tenantId,
    documentId,
    canonicalizationRunId,
    extractionRunId,
    candidateSetSha256,
    decisionSetSha256,
    2,
    5,
    base.idempotencyKey,
  ]);
  assert.deepEqual(result, {
    reconciliationRunId,
    canonicalizationRunId,
    snapshotId,
    snapshotVersion: 1,
    fundId: "fund-1",
    reportPeriod: "2026-06-30",
    schemaVersion: "schema-v1",
    taxonomyVersion: "metric-definitions-md5:abc",
    observationCount: 2,
    blockingExceptionCount: 0,
    reconciliationReady: true,
  });
});

test("reconciled handler parks business conflicts without consuming technical retries", async () => {
  const db = new FakePostgres();
  db.rows = [{
    ...db.rows[0],
    blocking_exception_count: 2,
    reconciliation_ready: false,
  }];
  const handler = createReconciledStageHandler(new PostgresReconciliationRepository(db));

  await assert.rejects(handler(base, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof ProcessingStageBlockedError);
    assert.equal(error.reason, "reconciliation_required");
    assert.deepEqual(error.metadata, {
      reconciliationRunId,
      snapshotId,
      snapshotVersion: 1,
      blockingExceptionCount: 2,
    });
    return true;
  });
});

test("reconciled handler is stage-bounded and honors cancellation", async () => {
  const db = new FakePostgres();
  const handler = createReconciledStageHandler(new PostgresReconciliationRepository(db));

  await assert.rejects(
    handler({ ...base, stage: "canonicalized" }, new AbortController().signal),
    /cannot execute stage canonicalized/,
  );
  assert.equal(db.queries.length, 0);

  const controller = new AbortController();
  controller.abort(new Error("worker timeout"));
  await assert.rejects(handler(base, controller.signal), /worker timeout/);
  assert.equal(db.queries.length, 0);
});

test("reconciliation migration preserves alternatives and fails closed before consolidation", async () => {
  const sql = (await readFile("db/postgres/migrations/028_reconciled_stage.sql", "utf8")).toLowerCase();

  assert.match(sql, /create table if not exists corvis_consolidated\.reconciliation_run/);
  assert.match(sql, /alter table corvis_consolidated\.reconciliation_run force row level security/);
  assert.match(sql, /create or replace function corvis_consolidated\.reconcile_canonicalization/);
  assert.match(sql, /reconciliation requires committed canonicalized-stage predecessor effect/);
  assert.match(sql, /count\(distinct normalized_value::text\) > 1/);
  assert.match(sql, /exact semantic-grain observations disagree/);
  assert.match(sql, /sourceauthorityselection','explicit_resolution_required'/);
  assert.match(sql, /case when grain\.has_critical then 'material' else 'unknown' end/);
  assert.match(sql, /create or replace function corvis_control\.resume_blocked_reconciled_stage/);
  assert.match(sql, /set state='queued',blocked_reason=null,last_error=null/);
  assert.match(sql, /create or replace function corvis_consolidated\.enforce_ready_reconciliation_before_success/);
  assert.match(sql, /reconciliation persistence blocks consolidation/);
  assert.equal(/delete\s+from\s+corvis_facts\.observation/i.test(sql), false);
  assert.equal(/update\s+corvis_facts\.observation\s+set/i.test(sql), false);
  assert.equal(/create policy[^;]+corvis_consolidated\.reconciliation_run/i.test(sql), false);
});
