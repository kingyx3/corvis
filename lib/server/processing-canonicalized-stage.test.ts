import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  createCanonicalizedStageHandler,
  PostgresCanonicalizationRepository,
  reviewedPredecessorResult,
} from "./processing-canonicalized-stage.ts";
import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const extractionRunId = "33333333-3333-4333-8333-333333333333";
const candidateSetSha256 = "a".repeat(64);
const decisionSetSha256 = "b".repeat(64);

const base: ProcessingStageEffectInput = {
  tenantId,
  documentId,
  jobId: `canonicalized:${documentId}`,
  stage: "canonicalized",
  payload: {
    predecessorJobId: `reviewed:${documentId}`,
    predecessorResult: {
      extractionRunId,
      candidateSetSha256,
      reviewPolicyVersion: "candidate_review_v1",
      decisionSetSha256,
      candidateCount: 3,
      criticalCandidateCount: 1,
      exceptionCandidateCount: 0,
      canonicalizationReady: true,
    },
  },
  idempotencyKey: "effect-key-canonicalized",
  attempt: 1,
};

class FakePostgres implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [{
    canonicalization_run_id: "44444444-4444-4444-8444-444444444444",
    candidate_count: 3,
    canonical_candidate_count: 3,
    observation_count: 1,
    source_reference_count: 3,
  }];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.rows;
  }

  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("canonicalized stage accepts only the exact governed reviewed predecessor", () => {
  const predecessor = reviewedPredecessorResult(base);
  assert.deepEqual(predecessor, {
    extractionRunId,
    candidateSetSha256,
    reviewPolicyVersion: "candidate_review_v1",
    decisionSetSha256,
    candidateCount: 3,
    criticalCandidateCount: 1,
    exceptionCandidateCount: 0,
    canonicalizationReady: true,
  });
});

test("canonicalized stage rejects incomplete or ungoverned predecessor results", () => {
  const predecessor = base.payload.predecessorResult as Record<string, unknown>;
  const cases: Array<{ patch: Record<string, unknown>; error: RegExp }> = [
    { patch: { canonicalizationReady: false }, error: /canonicalization-ready/ },
    { patch: { reviewPolicyVersion: "unapproved_review_policy" }, error: /governed candidate review policy/ },
    { patch: { candidateSetSha256: "not-a-hash" }, error: /valid predecessorResult\.candidateSetSha256/ },
    { patch: { decisionSetSha256: "not-a-hash" }, error: /valid predecessorResult\.decisionSetSha256/ },
    { patch: { candidateCount: -1 }, error: /valid predecessorResult\.candidateCount/ },
  ];

  for (const item of cases) {
    assert.throws(
      () => reviewedPredecessorResult({
        ...base,
        payload: { predecessorResult: { ...predecessor, ...item.patch } },
      }),
      item.error,
    );
  }
});

test("Postgres canonicalization repository passes exact reviewed lineage and idempotency key", async () => {
  const db = new FakePostgres();
  const repository = new PostgresCanonicalizationRepository(db);
  const predecessor = reviewedPredecessorResult(base);
  const result = await repository.canonicalize({
    tenantId,
    documentId,
    predecessor,
    idempotencyKey: base.idempotencyKey,
  });

  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0]?.sql ?? "", /corvis_facts\.canonicalize_reviewed_extraction/);
  assert.deepEqual(db.queries[0]?.parameters, [
    tenantId,
    documentId,
    extractionRunId,
    "candidate_review_v1",
    candidateSetSha256,
    decisionSetSha256,
    base.idempotencyKey,
  ]);
  assert.deepEqual(result, {
    canonicalizationRunId: "44444444-4444-4444-8444-444444444444",
    extractionRunId,
    reviewPolicyVersion: "candidate_review_v1",
    candidateSetSha256,
    decisionSetSha256,
    candidateCount: 3,
    canonicalCandidateCount: 3,
    observationCount: 1,
    sourceReferenceCount: 3,
  });
});

test("canonicalized handler is stage-bounded and honors cancellation", async () => {
  const db = new FakePostgres();
  const handler = createCanonicalizedStageHandler(new PostgresCanonicalizationRepository(db));

  await assert.rejects(
    handler({ ...base, stage: "reviewed" }, new AbortController().signal),
    /cannot execute stage reviewed/,
  );
  assert.equal(db.queries.length, 0);

  const controller = new AbortController();
  controller.abort(new Error("worker timeout"));
  await assert.rejects(handler(base, controller.signal), /worker timeout/);
  assert.equal(db.queries.length, 0);
});

test("canonicalization migration preserves immutable reviewed lineage and fails closed", async () => {
  const sql = (await readFile("db/postgres/migrations/026_canonicalized_stage.sql", "utf8")).toLowerCase();

  assert.match(sql, /create table if not exists corvis_facts\.canonicalization_run/);
  assert.match(sql, /create table if not exists corvis_facts\.canonical_candidate/);
  assert.match(sql, /alter table corvis_facts\.canonicalization_run force row level security/);
  assert.match(sql, /alter table corvis_facts\.canonical_candidate force row level security/);
  assert.match(sql, /alter table corvis_facts\.observation_source_reference force row level security/);

  assert.match(sql, /create or replace function corvis_facts\.canonicalize_reviewed_extraction/);
  assert.match(sql, /from corvis_review\.extraction_review_gate[\s\s\S]*?and status='ready'/);
  assert.match(sql, /and candidate_set_sha256=p_candidate_set_sha256/);
  assert.match(sql, /and decision_set_sha256=p_decision_set_sha256/);
  assert.match(sql, /e\.result ->> 'canonicalizationready'='true'/);
  assert.match(sql, /effective_payload := candidate_row\.payload \|\| coalesce\(correction_payload,'\{\}'::jsonb\)/);
  assert.match(sql, /canonicalization observation fund identity is unresolved/);
  assert.match(sql, /canonicalization observation metric taxonomy is unresolved/);
  assert.match(sql, /canonicalization source-reference lineage is incomplete/);
  assert.match(sql, /create table if not exists corvis_facts\.observation_source_reference/);
  assert.match(sql, /create or replace function corvis_facts\.enforce_ready_canonicalization_before_success/);
  assert.match(sql, /canonicalization persistence blocks reconciliation/);

  assert.equal(/update\s+corvis_source\.extraction_candidate\s+set/i.test(sql), false);
  assert.equal(/create policy[^;]+corvis_facts\.canonicalization_run/i.test(sql), false);
  assert.equal(/create policy[^;]+corvis_facts\.canonical_candidate/i.test(sql), false);
});
