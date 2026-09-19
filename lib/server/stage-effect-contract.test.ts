import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("stage effect journal is server-managed, tenant-bound and deterministic per job/effect", async () => {
  const sql = (await readFile("db/postgres/migrations/015_stage_effect_journal.sql", "utf8")).toLowerCase();
  assert.match(sql, /primary key \(tenant_id, job_id, effect_key\)/);
  assert.match(sql, /foreign key \(tenant_id, job_id\) references corvis_control\.processing_job/);
  assert.match(sql, /foreign key \(tenant_id, document_id\) references corvis_source\.document/);
  assert.match(sql, /alter table corvis_control\.processing_stage_effect enable row level security/);
  assert.match(sql, /alter table corvis_control\.processing_stage_effect force row level security/);
  assert.equal(/create policy[^;]+processing_stage_effect/.test(sql), false);
});

test("begin effect validates the running job and reuses completed effects", async () => {
  const sql = (await readFile("db/postgres/migrations/015_stage_effect_journal.sql", "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.begin_processing_stage_effect/);
  assert.match(sql, /and document_id=p_document_id and stage=p_stage/);
  assert.match(sql, /current_job\.state <> 'running'/);
  assert.match(sql, /on conflict \(tenant_id,job_id,effect_key\) do nothing/);
  assert.match(sql, /current_effect\.state='complete'[\s\S]*select false,true/);
  assert.match(sql, /attempt_count=attempt_count\+1/);
  assert.match(sql, /effect key metadata mismatch/);
});

test("effect completion is idempotent and retains result evidence", async () => {
  const sql = (await readFile("db/postgres/migrations/015_stage_effect_journal.sql", "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.complete_processing_stage_effect/);
  assert.match(sql, /state='complete'/);
  assert.match(sql, /completed_at=coalesce\(completed_at,now\(\)\)/);
  assert.match(sql, /result=coalesce\(p_result,'\{\}'::jsonb\)/);
  assert.match(sql, /state in \('started','complete'\)/);
});
