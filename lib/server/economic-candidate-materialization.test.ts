import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reviewed holding and instrument candidates materialize transactionally before observations", async () => {
  const sql = (await readFile("db/postgres/migrations/036_materialize_economic_candidates.sql", "utf8")).toLowerCase();
  const runtime = (await readFile("lib/server/processing-canonicalized-stage.ts", "utf8")).toLowerCase();

  assert.match(sql, /create or replace function corvis_facts\.canonicalize_reviewed_extraction_v2/);
  assert.match(sql, /from corvis_review\.extraction_review_gate/);
  assert.match(sql, /g\.status='ready'/);
  assert.match(sql, /g\.blocking_candidate_count=0/);
  assert.match(sql, /g\.candidate_set_sha256=p_candidate_set_sha256/);
  assert.match(sql, /g\.decision_set_sha256=p_decision_set_sha256/);
  assert.match(sql, /candidate_type='holding'/);
  assert.match(sql, /candidate_type='instrument'/);
  assert.match(sql, /reviewed holding candidate requires uuid holding_id/);
  assert.match(sql, /reviewed company holding requires exactly target_company_id/);
  assert.match(sql, /reviewed fund holding requires exactly target_fund_id/);
  assert.match(sql, /reviewed instrument parent holding is unresolved or not company-targeted/);
  assert.match(sql, /from corvis_facts\.canonicalize_reviewed_extraction\(/);
  assert.match(runtime, /canonicalize_reviewed_extraction_v2/);
});

test("materialization is replay-safe and preserves immutable revision lineage", async () => {
  const sql = (await readFile("db/postgres/migrations/036_materialize_economic_candidates.sql", "utf8")).toLowerCase();

  assert.match(sql, /create table if not exists corvis_facts\.holding_revision/);
  assert.match(sql, /create table if not exists corvis_facts\.instrument_revision/);
  assert.match(sql, /alter table corvis_facts\.holding_revision force row level security/);
  assert.match(sql, /alter table corvis_facts\.instrument_revision force row level security/);
  assert.match(sql, /effective_payload jsonb not null/);
  assert.match(sql, /source_reference_ids uuid\[\] not null/);
  assert.match(sql, /candidate_fingerprint_sha256/);
  assert.match(sql, /on conflict do nothing/);
  assert.match(sql, /is distinct from/);
  assert.match(sql, /source_reference_id=c\.source_reference_ids\[1\]/);
  assert.match(sql, /reviewed candidate set contains duplicate holding_id/);
  assert.match(sql, /reviewed candidate set contains duplicate instrument_id/);

  // Internal revision ledgers intentionally have no direct customer RLS policy.
  assert.equal(/create policy[^;]+holding_revision/.test(sql), false);
  assert.equal(/create policy[^;]+instrument_revision/.test(sql), false);
});
