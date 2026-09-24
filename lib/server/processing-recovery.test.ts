import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { recoverDeadLetterProcessingJob } from "./processing-recovery.ts";

const identity: RequestIdentity = {
  subject: "operator@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  roles: ["admin"],
  entitlements: { workspaceIds: ["22222222-2222-4222-8222-222222222222"], documentIds: ["33333333-3333-4333-8333-333333333333"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
};

class FakePostgres implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  queue: PostgresRow[][] = [];
  nextError?: Error;

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      throw error;
    }
    return this.queue.shift() ?? [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("operator recovery delegates atomically to the idempotent database command", async () => {
  const db = new FakePostgres();
  db.queue.push([{ new_version: 10, recovery_count: 2, recovery_event_id: "44444444-4444-4444-8444-444444444444" }]);

  const result = await recoverDeadLetterProcessingJob({
    identity,
    jobId: "canonicalized:33333333-3333-4333-8333-333333333333",
    expectedVersion: 9,
    recoveryEventId: "44444444-4444-4444-8444-444444444444",
    reasonCode: "operator_verified_dependency_recovered",
    note: "Synthetic UAT recovery",
    db,
  });

  assert.deepEqual(result, {
    ok: true,
    version: 10,
    recoveryCount: 2,
    recoveryEventId: "44444444-4444-4444-8444-444444444444",
  });
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0]?.sql ?? "", /corvis_control\.recover_dead_letter_processing_job/);
  assert.deepEqual(db.queries[0]?.parameters, [
    identity.tenantId,
    "canonicalized:33333333-3333-4333-8333-333333333333",
    9,
    "44444444-4444-4444-8444-444444444444",
    identity.subject,
    "operator_verified_dependency_recovered",
    "Synthetic UAT recovery",
  ]);
});

test("operator recovery maps governed database refusal states without a weaker application path", async () => {
  for (const [message, reason] of [
    ["only terminal dead-letter jobs can be operator-recovered", "not_terminal_dead_letter"],
    ["dead-letter recovery requires an exhausted job; use normal retry before exhaustion", "not_exhausted"],
    ["dead-letter recovery requires retained predecessor lineage evidence", "missing_delivery_evidence"],
    ["processing recovery idempotency key was reused with different command content", "idempotency_conflict"],
  ] as const) {
    const db = new FakePostgres();
    db.nextError = new Error(message);
    const result = await recoverDeadLetterProcessingJob({
      identity,
      jobId: "reviewed:33333333-3333-4333-8333-333333333333",
      expectedVersion: 9,
      recoveryEventId: "44444444-4444-4444-8444-444444444444",
      reasonCode: "operator_recovery",
      db,
    });
    assert.deepEqual(result, { ok:false, reason });
    assert.equal(db.queries.length, 1);
  }
});

test("processing recovery migration preserves lineage, evidence and idempotency", async () => {
  const sql = (await readFile("db/postgres/migrations/027_processing_operator_recovery.sql", "utf8")).toLowerCase();

  assert.match(sql, /create table if not exists corvis_control\.processing_recovery_event/);
  assert.match(sql, /alter table corvis_control\.processing_recovery_event force row level security/);
  assert.equal(/create policy[^;]+processing_recovery_event/i.test(sql), false);
  assert.match(sql, /action text not null check \(action in \('recover_dead_letter'\)\)/);

  assert.match(sql, /create or replace function corvis_control\.fail_processing_stage_delivery/);
  assert.match(sql, /signal_payload := \(inbox_row\.payload - 'nextattemptat'\) \|\| jsonb_build_object/);
  assert.match(sql, /'processingstageretryscheduled'/);
  assert.equal(/signal_payload := jsonb_build_object\(/.test(sql), false);

  assert.match(sql, /select \* into existing_recovery[\s\S]*?processing_recovery_event/);
  assert.match(sql, /return query select existing_recovery\.result_job_version/);
  assert.match(sql, /if current_job\.state <> 'dead_letter'/);
  assert.match(sql, /if current_job\.attempt < current_job\.max_attempts/);
  assert.match(sql, /dead-letter recovery requires retained durable stage-delivery evidence/);
  assert.match(sql, /dead-letter recovery requires retained predecessor lineage evidence/);
  assert.match(sql, /i\.payload \? 'predecessorresult'/);
  assert.match(sql, /source_payload := \(source_inbox\.payload - 'nextattemptat'\)/);
  assert.match(sql, /set state='queued',[\s\S]*?attempt=0,[\s\S]*?recovery_count=next_recovery_count/);
  assert.match(sql, /'processingjobretryrequested'/);
  assert.match(sql, /source_event_id uuid not null/);
  assert.match(sql, /before_state jsonb not null/);
  assert.match(sql, /after_state jsonb not null/);
  assert.equal(/delete from corvis_control\.event_inbox/i.test(sql), false);
  assert.equal(/delete from corvis_control\.processing_stage_effect/i.test(sql), false);
  assert.equal(/update\s+corvis_control\.processing_stage_effect/i.test(sql), false);
});
