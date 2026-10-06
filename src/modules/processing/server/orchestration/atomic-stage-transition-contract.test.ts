import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("stage claim atomically couples inbox ownership to authoritative job start", async () => {
  const sql = (await readFile("db/postgres/migrations/014_atomic_stage_transitions.sql", "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.claim_processing_stage_delivery/);
  assert.match(sql, /from corvis_control\.claim_event_delivery/);
  assert.match(sql, /and document_id=p_document_id[\s\S]*and stage=p_expected_stage/);
  assert.match(sql, /current_job\.state not in \('queued','retryable'\)/);
  assert.match(sql, /set state='running',[\s\S]*attempt=attempt\+1,[\s\S]*version=version\+1/);
  assert.match(sql, /raise exception 'processing job not found for claimed event'/);
});

test("stage completion closes the inbox and schedules the next stage in one transaction", async () => {
  const sql = (await readFile("db/postgres/migrations/014_atomic_stage_transitions.sql", "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.complete_processing_stage_delivery/);
  assert.match(sql, /complete_event_delivery\([\s\S]*p_lease_token/);
  assert.match(sql, /if completion_ok is not true then raise exception 'event lease no longer owns completion'/);
  assert.match(sql, /set state='succeeded',version=version\+1/);
  assert.match(sql, /computed_next_stage := case current_job\.stage/);
  assert.match(sql, /insert into corvis_control\.processing_job[\s\S]*on conflict \(tenant_id,job_id\) do nothing/);
  assert.match(sql, /'processingstageready'/);
  assert.match(sql, /get diagnostics inserted_count = row_count/);
  assert.match(sql, /if inserted_count = 1 then[\s\S]*insert into corvis_control\.outbox_event/);
});

test("stage failure atomically coordinates retry/dead-letter state and handoff signal", async () => {
  const sql = (await readFile("db/postgres/migrations/014_atomic_stage_transitions.sql", "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.fail_processing_stage_delivery/);
  assert.match(sql, /computed_inbox_state := corvis_control\.fail_event_delivery/);
  assert.match(sql, /computed_job_state := case computed_inbox_state when 'retryable' then 'retryable' else 'dead_letter' end/);
  assert.match(sql, /set state=computed_job_state,[\s\S]*last_error=left\(coalesce\(p_error,'unknown error'\),2000\)/);
  assert.match(sql, /'processingstageretryscheduled'/);
  assert.match(sql, /'processingstagedeadlettered'/);
  assert.match(sql, /'nextattemptat',inbox_row\.next_attempt_at/);
});

test("stage transition outbox IDs are deterministic across redelivery", async () => {
  const sql = (await readFile("db/postgres/migrations/014_atomic_stage_transitions.sql", "utf8")).toLowerCase();
  assert.match(sql, /md5\(p_tenant_id::text \|\| ':' \|\| computed_next_job_id \|\| ':ready'\)::uuid/);
  assert.match(sql, /signal_id := md5\(/);
  assert.match(sql, /on conflict \(tenant_id,event_id\) do nothing/);
});
