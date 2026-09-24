import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PostgresProcessingStageRepository } from "./orchestration-stage.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };

class FakeDb implements PostgresSqlApi {
  calls: Call[] = [];
  rows: PostgresRow[][] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return this.rows.shift() ?? [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.calls.push({ sql, parameters });
  }

  async health(): Promise<boolean> { return true; }
}

const delivery = {
  tenantId: "00000000-0000-0000-0000-000000000010",
  consumerName: "document-representation-worker",
  eventId: "00000000-0000-0000-0000-000000000111",
  eventType: "DocumentRegistered",
  documentId: "00000000-0000-0000-0000-000000000101",
  jobId: "registered:00000000-0000-0000-0000-000000000101",
  expectedStage: "registered" as const,
  payload: { documentId: "00000000-0000-0000-0000-000000000101" },
  payloadSha256: "abc123",
};

test("processing stage repository claims with tenant, document and job binding", async () => {
  const db = new FakeDb();
  db.rows.push([{
    claimed: true,
    duplicate_complete: false,
    claim_lease_token: "00000000-0000-0000-0000-000000000222",
    claim_attempt: 1,
    inbox_state: "processing",
    job_version: 2,
    job_state: "running",
  }]);

  const result = await new PostgresProcessingStageRepository(db).claim(delivery);
  assert.equal(result.claimed, true);
  assert.equal(result.jobState, "running");
  assert.match(db.calls[0]?.sql ?? "", /claim_processing_stage_delivery/);
  assert.deepEqual(db.calls[0]?.parameters.slice(0, 7), [
    delivery.tenantId,
    delivery.consumerName,
    delivery.eventId,
    delivery.eventType,
    delivery.documentId,
    delivery.jobId,
    delivery.expectedStage,
  ]);
});

test("a claim for a fabricated event with no matching outbox record propagates the authenticity exception", async () => {
  const db = new FakeDb();
  db.query = async () => { throw new Error("event id has no matching outbox record"); };
  await assert.rejects(
    () => new PostgresProcessingStageRepository(db).claim(delivery),
    /event id has no matching outbox record/,
  );
});

test("processing stage completion delegates one atomic database transition", async () => {
  const db = new FakeDb();
  db.rows.push([{
    completed: true,
    completed_job_version: 3,
    next_job_id: "represented:00000000-0000-0000-0000-000000000101",
    next_stage: "represented",
  }]);
  const repo = new PostgresProcessingStageRepository(db);
  const result = await repo.complete({
    tenantId: delivery.tenantId,
    consumerName: delivery.consumerName,
    eventId: delivery.eventId,
    leaseToken: "00000000-0000-0000-0000-000000000222",
    jobId: delivery.jobId,
  });
  assert.equal(result?.completed, true);
  assert.equal(result?.nextStage, "represented");
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0]?.sql ?? "", /complete_processing_stage_delivery/);
});

test("processing stage failure returns retry scheduling metadata", async () => {
  const db = new FakeDb();
  db.rows.push([{
    next_state: "retryable",
    job_version: 3,
    inbox_attempt: 1,
    next_attempt_at: "2026-09-19T09:00:01Z",
  }]);
  const repo = new PostgresProcessingStageRepository(db);
  const result = await repo.fail({
    tenantId: delivery.tenantId,
    consumerName: delivery.consumerName,
    eventId: delivery.eventId,
    leaseToken: "00000000-0000-0000-0000-000000000222",
    jobId: delivery.jobId,
    error: "temporary provider failure",
  });
  assert.equal(result?.nextState, "retryable");
  assert.equal(result?.inboxAttempt, 1);
  assert.equal(result?.nextAttemptAt, "2026-09-19T09:00:01Z");
  assert.match(db.calls[0]?.sql ?? "", /fail_processing_stage_delivery/);
});

test("processing stage failure truncates error detail before the database boundary", async () => {
  const db = new FakeDb();
  db.rows.push([]);
  const longError = "x".repeat(2500);
  await new PostgresProcessingStageRepository(db).fail({
    tenantId: delivery.tenantId,
    consumerName: delivery.consumerName,
    eventId: delivery.eventId,
    leaseToken: "00000000-0000-0000-0000-000000000222",
    jobId: delivery.jobId,
    error: longError,
  });
  assert.equal(String(db.calls[0]?.parameters[5] ?? "").length, 2000);
});

test("claim reclaims a job orphaned in running once no other delivery holds a live lease (migration 046)", async () => {
  const sql = (await readFile("db/postgres/migrations/046_processing_stage_recovery_hardening.sql", "utf8")).toLowerCase();
  const start = sql.indexOf("create or replace function corvis_control.claim_processing_stage_delivery(");
  assert.ok(start >= 0, "046 must redefine claim_processing_stage_delivery");
  const claim = sql.slice(start, sql.indexOf("\n$$;", start));
  // A running job only stays transient while another delivery's inbox lease is live.
  assert.match(claim, /if current_job\.state='running' then\s+[\s\S]*?if exists \([\s\S]*?i\.event_id<>p_event_id[\s\S]*?i\.state='processing'[\s\S]*?i\.lease_expires_at > now\(\)[\s\S]*?raise exception 'processing job is not claimable'/);
  assert.doesNotMatch(claim, /if current_job\.state='running' then raise exception/);
  // The orphaned attempt still counts against the budget and dead-letters when spent.
  assert.match(claim, /if terminal_error is null and current_job\.attempt >= current_job\.max_attempts then[\s\S]*dead_letter_exhausted_processing_job/);
  assert.match(claim, /set search_path = pg_catalog, corvis_control/);
});

test("operator retry re-emits the retained stage payload instead of a bare job id (migration 046)", async () => {
  const sql = (await readFile("db/postgres/migrations/046_processing_stage_recovery_hardening.sql", "utf8")).toLowerCase();
  const start = sql.indexOf("create or replace function corvis_control.retry_processing_job(");
  assert.ok(start >= 0, "046 must redefine retry_processing_job");
  const retry = sql.slice(start, sql.indexOf("\n$$;", start));
  assert.match(retry, /state in \('retryable','failed','dead_letter'\) and attempt < max_attempts/);
  assert.match(retry, /from corvis_control\.event_inbox i[\s\S]*i\.payload \? 'predecessorresult'/);
  assert.match(retry, /'processingjobretryrequested'[\s\S]*coalesce\(source_payload,'\{\}'::jsonb\) - 'nextattemptat'/);
});
