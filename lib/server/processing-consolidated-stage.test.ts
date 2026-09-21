import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  createConsolidatedStageHandler,
  PostgresConsolidationRepository,
  reconciledPredecessorResult,
} from "./processing-consolidated-stage.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const reconciliationRunId = "33333333-3333-4333-8333-333333333333";
const canonicalizationRunId = "44444444-4444-4444-8444-444444444444";
const snapshotId = "55555555-5555-4555-8555-555555555555";
const consolidationRunId = "66666666-6666-4666-8666-666666666666";

const base: ProcessingStageEffectInput = {
  tenantId,
  documentId,
  jobId: `consolidated:${documentId}`,
  stage: "consolidated",
  payload: {
    predecessorJobId: `reconciled:${documentId}`,
    predecessorResult: {
      reconciliationRunId,
      canonicalizationRunId,
      snapshotId,
      snapshotVersion: 1,
      fundId: "fund-1",
      reportPeriod: "2026-06-30",
      schemaVersion: "schema-v1",
      taxonomyVersion: "metric-definitions-md5:abc",
      observationCount: 3,
      blockingExceptionCount: 0,
      reconciliationReady: true,
    },
  },
  idempotencyKey: "effect-key-consolidated",
  attempt: 1,
};

class FakePostgres implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [{
    consolidation_run_id: consolidationRunId,
    reconciliation_run_id: reconciliationRunId,
    snapshot_id: snapshotId,
    snapshot_version: 1,
    fund_id: "fund-1",
    report_period: "2026-06-30",
    fact_count: 2,
    source_observation_count: 3,
    consolidation_ready: true,
  }];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.rows;
  }

  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("consolidated stage accepts only a ready zero-blocker reconciliation result", () => {
  assert.deepEqual(reconciledPredecessorResult(base), {
    reconciliationRunId,
    canonicalizationRunId,
    snapshotId,
    snapshotVersion: 1,
    fundId: "fund-1",
    reportPeriod: "2026-06-30",
    schemaVersion: "schema-v1",
    taxonomyVersion: "metric-definitions-md5:abc",
    observationCount: 3,
    blockingExceptionCount: 0,
    reconciliationReady: true,
  });

  const predecessor = base.payload.predecessorResult as Record<string, unknown>;
  const cases: Array<{ patch: Record<string, unknown>; error: RegExp }> = [
    { patch: { reconciliationReady: false }, error: /reconciliation-ready predecessor/ },
    { patch: { blockingExceptionCount: 1 }, error: /zero blocking reconciliation exceptions/ },
    { patch: { observationCount: 0 }, error: /requires reconciled observations/ },
    { patch: { snapshotVersion: 0 }, error: /positive snapshot version/ },
  ];
  for (const item of cases) {
    assert.throws(
      () => reconciledPredecessorResult({
        ...base,
        payload: { predecessorResult: { ...predecessor, ...item.patch } },
      }),
      item.error,
    );
  }
});

test("Postgres consolidation repository passes exact reconciliation lineage and idempotency", async () => {
  const db = new FakePostgres();
  const repository = new PostgresConsolidationRepository(db);
  const predecessor = reconciledPredecessorResult(base);
  const result = await repository.consolidate({
    tenantId,
    documentId,
    predecessor,
    idempotencyKey: base.idempotencyKey,
  });

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0]?.sql ?? "", /corvis_consolidated\.consolidate_reconciliation/);
  assert.deepEqual(db.queries[0]?.parameters, [
    tenantId,
    documentId,
    reconciliationRunId,
    snapshotId,
    1,
    3,
    base.idempotencyKey,
  ]);
  assert.deepEqual(result, {
    consolidationRunId,
    reconciliationRunId,
    snapshotId,
    snapshotVersion: 1,
    fundId: "fund-1",
    reportPeriod: "2026-06-30",
    factCount: 2,
    sourceObservationCount: 3,
    consolidationReady: true,
  });
});

test("consolidated handler is stage-bounded and honors cancellation", async () => {
  const db = new FakePostgres();
  const handler = createConsolidatedStageHandler(new PostgresConsolidationRepository(db));

  await assert.rejects(
    handler({ ...base, stage: "reconciled" }, new AbortController().signal),
    /cannot execute stage reconciled/,
  );
  assert.equal(db.queries.length, 0);

  const controller = new AbortController();
  controller.abort(new Error("worker timeout"));
  await assert.rejects(handler(base, controller.signal), /worker timeout/);
  assert.equal(db.queries.length, 0);
});

test("consolidation migration is deterministic, lineage-complete and publication-neutral", async () => {
  const sql = (await readFile("db/postgres/migrations/029_consolidated_stage.sql", "utf8")).toLowerCase();

  assert.match(sql, /create table if not exists corvis_consolidated\.consolidation_run/);
  assert.match(sql, /alter table corvis_consolidated\.consolidation_run force row level security/);
  assert.match(sql, /alter table corvis_consolidated\.consolidated_fact force row level security/);
  assert.match(sql, /create or replace function corvis_consolidated\.consolidate_reconciliation/);
  assert.match(sql, /consolidation requires committed reconciled-stage predecessor effect/);
  assert.match(sql, /'conflicting_alternative'/);
  assert.match(sql, /'equivalent_grain'/);
  assert.match(sql, /source_observation_ids/);
  assert.match(sql, /set fact_ids=existing_fact_ids/);
  assert.match(sql, /create or replace function corvis_consolidated\.enforce_ready_consolidation_before_success/);
  assert.match(sql, /consolidation persistence blocks publication/);
  assert.equal(/delete\s+from\s+corvis_facts\.observation/i.test(sql), false);
  assert.equal(/update\s+corvis_facts\.observation\s+set/i.test(sql), false);
  assert.equal(/append_snapshot_transition\s*\(/i.test(sql), false);
  assert.equal(/status\s*=\s*'published'/i.test(sql), false);
});
