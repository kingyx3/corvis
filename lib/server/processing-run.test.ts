import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isReplayProcessingRun, processingRunKey } from "./processing-run.ts";

test("processing run identity defaults to the backward-compatible primary journey", () => {
  assert.equal(processingRunKey({}), "primary");
  assert.equal(processingRunKey({ processingRunKey: "primary" }), "primary");
  assert.equal(isReplayProcessingRun({}), false);
  assert.equal(isReplayProcessingRun({ processingRunKey: "data-correction:abc" }), true);
  assert.throws(() => processingRunKey({ processingRunKey: "" }), /invalid processingRunKey/);
  assert.throws(() => processingRunKey({ processingRunKey: 7 }), /invalid processingRunKey/);
});

test("processing replay migration namespaces every downstream job and binds exact retained source evidence", async () => {
  const sql = (await readFile("db/postgres/migrations/031_processing_run_replay.sql", "utf8")).toLowerCase();

  assert.match(sql, /alter table corvis_control\.processing_job[\s\S]+add column if not exists run_key/);
  assert.match(sql, /create or replace function corvis_control\.processing_job_id/);
  assert.match(sql, /when p_run_key='primary' then p_stage \|\| ':' \|\| p_document_id::text/);
  assert.match(sql, /current_job\.run_key,computed_next_stage,current_job\.document_id/);
  assert.match(sql, /'processingrunkey',current_job\.run_key/);
  assert.match(sql, /create or replace function corvis_control\.request_data_correction_replay/);
  assert.match(sql, /correction replay requires exactly one retained clean source artifact/);
  assert.match(sql, /cross join lateral unnest\(s\.fact_ids\)/);
  assert.match(sql, /cross join lateral unnest\(cf\.source_observation_ids\)/);
  assert.match(sql, /'artifactversionid',artifact_id/);
  assert.match(sql, /'ingestionid',artifact_ingestion_id/);
  assert.match(sql, /replay_run_key := 'data-correction:' \|\| p_incident_id::text/);
  assert.match(sql, /replay_job_id=computed_job_id/);
});
