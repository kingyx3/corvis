import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  consolidatedPredecessorResult,
  createPublishedStageHandler,
  PostgresPublicationRepository,
} from "./processing-published-stage.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const consolidationRunId = "33333333-3333-4333-8333-333333333333";
const reconciliationRunId = "44444444-4444-4444-8444-444444444444";
const snapshotId = "55555555-5555-4555-8555-555555555555";
const publicationRunId = "66666666-6666-4666-8666-666666666666";
const publicationEventId = "77777777-7777-4777-8777-777777777777";

const base: ProcessingStageEffectInput = {
  tenantId,
  documentId,
  jobId: `published:${documentId}`,
  stage: "published",
  payload: {
    predecessorJobId: `consolidated:${documentId}`,
    predecessorResult: {
      consolidationRunId,
      reconciliationRunId,
      snapshotId,
      snapshotVersion: 1,
      fundId: "fund-1",
      reportPeriod: "2026-06-30",
      factCount: 2,
      sourceObservationCount: 3,
      consolidationReady: true,
    },
  },
  idempotencyKey: "effect-key-published",
  attempt: 1,
};

class FakePostgres implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [{
    publication_run_id: publicationRunId,
    consolidation_run_id: consolidationRunId,
    snapshot_id: snapshotId,
    source_snapshot_version: 1,
    snapshot_version: 2,
    publication_event_id: publicationEventId,
    fact_count: 2,
    publication_ready: true,
  }];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    if (sql.includes("publication_run p")) {
      return [{
        document_created_at: "2026-09-22T00:00:00.000Z",
        publication_completed_at: "2026-09-22T00:30:00.000Z",
      }];
    }
    return this.rows;
  }

  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("published stage accepts only a ready consolidation result", () => {
  assert.deepEqual(consolidatedPredecessorResult(base), {
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

  const predecessor = base.payload.predecessorResult as Record<string, unknown>;
  const cases: Array<{ patch: Record<string, unknown>; error: RegExp }> = [
    { patch: { consolidationReady: false }, error: /consolidation-ready predecessor/ },
    { patch: { factCount: 0 }, error: /requires consolidated facts/ },
    { patch: { sourceObservationCount: 0 }, error: /requires source observations/ },
    { patch: { snapshotVersion: 0 }, error: /positive snapshot version/ },
  ];
  for (const item of cases) {
    assert.throws(
      () => consolidatedPredecessorResult({
        ...base,
        payload: { predecessorResult: { ...predecessor, ...item.patch } },
      }),
      item.error,
    );
  }
});

test("Postgres publication repository passes exact consolidation lineage and records persisted freshness boundaries", async () => {
  const db = new FakePostgres();
  const repository = new PostgresPublicationRepository(db);
  const predecessor = consolidatedPredecessorResult(base);
  const result = await repository.publish({
    tenantId,
    documentId,
    predecessor,
    idempotencyKey: base.idempotencyKey,
  });

  assert.equal(db.queries.length, 2);
  assert.match(db.queries[0]?.sql ?? "", /corvis_consolidated\.publish_consolidation/);
  assert.deepEqual(db.queries[0]?.parameters, [
    tenantId,
    documentId,
    consolidationRunId,
    snapshotId,
    1,
    base.idempotencyKey,
  ]);
  assert.match(db.queries[1]?.sql ?? "", /document_created_at/);
  assert.match(db.queries[1]?.sql ?? "", /publication_completed_at/);
  assert.deepEqual(db.queries[1]?.parameters, [tenantId, documentId, publicationRunId]);
  assert.deepEqual(result, {
    publicationRunId,
    consolidationRunId,
    snapshotId,
    sourceSnapshotVersion: 1,
    snapshotVersion: 2,
    publicationEventId,
    factCount: 2,
    publicationReady: true,
  });
});

test("published handler is stage-bounded and honors cancellation", async () => {
  const db = new FakePostgres();
  const handler = createPublishedStageHandler(new PostgresPublicationRepository(db));

  await assert.rejects(
    handler({ ...base, stage: "consolidated" }, new AbortController().signal),
    /cannot execute stage consolidated/,
  );
  assert.equal(db.queries.length, 0);

  const controller = new AbortController();
  controller.abort(new Error("worker timeout"));
  await assert.rejects(handler(base, controller.signal), /worker timeout/);
  assert.equal(db.queries.length, 0);
});

test("publication migration restores all persistence gates and is redelivery-safe", async () => {
  const sql = (await readFile("db/postgres/migrations/030_published_stage.sql", "utf8")).toLowerCase();

  assert.match(sql, /create table if not exists corvis_consolidated\.publication_run/);
  assert.match(sql, /alter table corvis_consolidated\.publication_run force row level security/);
  assert.match(sql, /create or replace function corvis_consolidated\.assert_snapshot_publishable/);
  assert.match(sql, /blocking reconciliation exceptions remain/);
  assert.match(sql, /active data correction incident blocks publication/);
  assert.match(sql, /publication lineage or review coverage is incomplete/);
  assert.match(sql, /critical observations require finalized independent review/);
  assert.match(sql, /conflicting alternatives require attributable reconciliation resolution/);
  assert.match(sql, /create or replace function corvis_consolidated\.append_snapshot_transition/);
  assert.match(sql, /perform corvis_consolidated\.assert_snapshot_publishable/);
  assert.match(sql, /create or replace function corvis_consolidated\.publish_consolidation/);
  assert.match(sql, /publication requires committed consolidated-stage predecessor effect/);
  assert.match(sql, /if found then[\s\S]+existing published snapshot is missing publication event/);
  assert.match(sql, /create or replace function corvis_consolidated\.enforce_ready_publication_before_success/);
  assert.match(sql, /publication persistence blocks published-stage success/);
  assert.equal(/update\s+corvis_facts\.observation\s+set/i.test(sql), false);
  assert.equal(/delete\s+from\s+corvis_facts\.observation/i.test(sql), false);
});
