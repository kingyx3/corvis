import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const baseline = "db/postgres/migrations/001_baseline.sql";

// The baseline is one file, so assertions about what a single command does are scoped to that function's body
// rather than to the whole schema. Expects lower-cased SQL.
function functionBody(sql: string, qualifiedName: string): string {
  const start = sql.indexOf(`create function ${qualifiedName}(`);
  assert.ok(start >= 0, `${qualifiedName} must be defined in the baseline`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${qualifiedName} body must be terminated`);
  return sql.slice(start, end);
}

test("correction replay preserves prior processing history and scopes new journey ids", async () => {
  const sql = (await readFile(baseline, "utf8")).toLowerCase();
  assert.match(sql, /create function corvis_control\.scoped_processing_job_id/);
  assert.match(sql, /like 'data-correction:%'/);
  assert.match(sql, /'correction:' \|\| substring\(p_correlation_id/);
  assert.match(sql, /computed_next_job_id := corvis_control\.scoped_processing_job_id/);
  assert.equal(/delete\s+from\s+corvis_control\.processing_job/.test(sql), false);
  assert.equal(/delete\s+from\s+corvis_control\.processing_stage_effect/.test(sql), false);
});

test("correction replay starts from exact retained snapshot artifact lineage", async () => {
  const sql = (await readFile(baseline, "utf8")).toLowerCase();
  const replay = functionBody(sql, "corvis_control.request_data_correction_replay");
  assert.match(replay, /unnest\(s\.fact_ids\)/);
  assert.match(replay, /unnest\(cf\.source_observation_ids\)/);
  assert.match(replay, /corvis_facts\.observation_source_reference/);
  assert.match(replay, /corvis_source\.source_reference/);
  assert.match(replay, /artifact lineage is ambiguous/);
  assert.match(replay, /'artifactversionid',artifact_id/);
  assert.match(replay, /'ingestionid',artifact_ingestion_id/);
});

test("later stages bind to the predecessor from the same processing correlation", async () => {
  const sql = (await readFile(baseline, "utf8")).toLowerCase();
  assert.match(sql, /create function corvis_control\.processing_predecessor_job_for_effect/);
  assert.match(sql, /predecessor\.correlation_id=current_job\.correlation_id/);

  const stages: Array<{ fn: string; stage: string; predecessor: string }> = [
    { fn: "corvis_facts.canonicalize_reviewed_extraction", stage: "canonicalized", predecessor: "reviewed" },
    { fn: "corvis_consolidated.reconcile_canonicalization", stage: "reconciled", predecessor: "canonicalized" },
    { fn: "corvis_consolidated.consolidate_reconciliation", stage: "consolidated", predecessor: "reconciled" },
    { fn: "corvis_consolidated.publish_consolidation", stage: "published", predecessor: "consolidated" },
  ];
  for (const item of stages) {
    assert.match(
      functionBody(sql, item.fn),
      new RegExp(`j\\.job_id=corvis_control\\.processing_predecessor_job_for_effect\\(p_tenant_id,p_document_id,'${item.stage}',p_idempotency_key,'${item.predecessor}'\\)`),
      `${item.fn} must bind the ${item.predecessor} predecessor of its own correlation`,
    );
  }
  assert.match(
    functionBody(sql, "corvis_control.resume_blocked_reconciled_stage"),
    /processing_predecessor_job_for_job\(p_tenant_id,current_job\.job_id,'canonicalized'\)/,
  );
});

test("correction replay forks replacement reconciliation and only bypasses its own publication block", async () => {
  const sql = (await readFile(baseline, "utf8")).toLowerCase();
  assert.doesNotMatch(sql, /alter table only corvis_consolidated\.reconciliation_run\s+add constraint \w+ unique \(tenant_id, canonicalization_run_id\)/);
  assert.doesNotMatch(sql, /create unique index \w+ on corvis_consolidated\.reconciliation_run using btree \(tenant_id, canonicalization_run_id\)/);
  assert.match(sql, /processing_replay_scope_for_effect/);
  const reconcile = functionBody(sql, "corvis_consolidated.reconcile_canonicalization");
  assert.match(reconcile, /run_id := md5\([^;]*processing_replay_scope_for_effect\(p_tenant_id,p_document_id,'reconciled',p_idempotency_key\)\)::uuid;/);
  assert.match(reconcile, /target_snapshot_id := md5\([^;]*processing_replay_scope_for_effect\(p_tenant_id,p_document_id,'reconciled',p_idempotency_key\)\)::uuid;/);
  assert.match(sql, /replacement_snapshot_id=replacement_id/);
  assert.match(sql, /not \(c\.state='reprocessing' and c\.replacement_snapshot_id=p_snapshot_id\)/);
});

test("review block and resume follow the scoped extraction/review journey", async () => {
  const sql = (await readFile(baseline, "utf8")).toLowerCase();
  assert.match(sql, /create function corvis_review\.guard_review_event_lifecycle/);
  assert.match(sql, /e\.result ->> 'extractionrunid'=new\.extraction_run_id::text/);
  assert.match(sql, /j\.correlation_id=extraction_correlation/);
  assert.match(sql, /create function corvis_control\.resume_blocked_reviewed_stage/);
  assert.match(sql, /processing_predecessor_job_for_job\([\s\s]*p_tenant_id,p_job_id,'extracted'/);
});
