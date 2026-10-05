import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = "db/postgres/migrations/031_governed_processing_replay.sql";

test("correction replay preserves prior processing history and scopes new journey ids", async () => {
  const sql = (await readFile(migration, "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.scoped_processing_job_id/);
  assert.match(sql, /like 'data-correction:%'/);
  assert.match(sql, /'correction:' \|\| substring\(p_correlation_id/);
  assert.match(sql, /computed_next_job_id := corvis_control\.scoped_processing_job_id/);
  assert.equal(/delete\s+from\s+corvis_control\.processing_job/.test(sql), false);
  assert.equal(/delete\s+from\s+corvis_control\.processing_stage_effect/.test(sql), false);
});

test("correction replay starts from exact retained snapshot artifact lineage", async () => {
  const sql = (await readFile(migration, "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.request_data_correction_replay/);
  assert.match(sql, /unnest\(s\.fact_ids\)/);
  assert.match(sql, /unnest\(cf\.source_observation_ids\)/);
  assert.match(sql, /corvis_facts\.observation_source_reference/);
  assert.match(sql, /corvis_source\.source_reference/);
  assert.match(sql, /artifact lineage is ambiguous/);
  assert.match(sql, /'artifactversionid',artifact_id/);
  assert.match(sql, /'ingestionid',artifact_ingestion_id/);
});

test("later stages bind to the predecessor from the same processing correlation", async () => {
  const sql = (await readFile(migration, "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.processing_predecessor_job_for_effect/);
  assert.match(sql, /predecessor\.correlation_id=current_job\.correlation_id/);
  assert.match(sql, /could not scope canonicalization predecessor/);
  assert.match(sql, /could not scope reconciliation predecessor/);
  assert.match(sql, /could not scope consolidation predecessor/);
  assert.match(sql, /could not scope publication predecessor/);
  assert.match(sql, /could not scope reconciliation resume predecessor/);
});

test("correction replay forks replacement reconciliation and only bypasses its own publication block", async () => {
  const sql = (await readFile(migration, "utf8")).toLowerCase();
  assert.match(sql, /drop constraint if exists reconciliation_run_tenant_id_canonicalization_run_id_key/);
  assert.match(sql, /processing_replay_scope_for_effect/);
  assert.match(sql, /could not scope reconciliation run identity/);
  assert.match(sql, /could not scope replacement snapshot identity/);
  assert.match(sql, /replacement_snapshot_id=replacement_id/);
  assert.match(sql, /not \(c\.state='reprocessing' and c\.replacement_snapshot_id=p_snapshot_id\)/);
});

test("review block and resume follow the scoped extraction/review journey", async () => {
  const sql = (await readFile(migration, "utf8")).toLowerCase();
  assert.match(sql, /create or replace function corvis_review\.guard_review_event_lifecycle/);
  assert.match(sql, /e\.result ->> 'extractionrunid'=new\.extraction_run_id::text/);
  assert.match(sql, /j\.correlation_id=extraction_correlation/);
  assert.match(sql, /create or replace function corvis_control\.resume_blocked_reviewed_stage/);
  assert.match(sql, /processing_predecessor_job_for_job\([\s\s]*p_tenant_id,p_job_id,'extracted'/);
});
