import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reviewed holding and instrument candidates materialize transactionally before observations", async () => {
  const v2 = (await readFile("db/postgres/migrations/036_materialize_economic_candidates.sql", "utf8")).toLowerCase();
  const v3 = (await readFile("db/postgres/migrations/037_materialize_lifecycle_events.sql", "utf8")).toLowerCase();
  const v4 = (await readFile("db/postgres/migrations/038_materialize_reviewed_identities.sql", "utf8")).toLowerCase();
  const runtime = (await readFile("lib/server/processing-canonicalized-stage.ts", "utf8")).toLowerCase();

  assert.match(v2, /create or replace function corvis_facts\.canonicalize_reviewed_extraction_v2/);
  assert.match(v2, /from corvis_review\.extraction_review_gate/);
  assert.match(v2, /g\.status='ready'/);
  assert.match(v2, /g\.blocking_candidate_count=0/);
  assert.match(v2, /g\.candidate_set_sha256=p_candidate_set_sha256/);
  assert.match(v2, /g\.decision_set_sha256=p_decision_set_sha256/);
  assert.match(v2, /candidate_type='holding'/);
  assert.match(v2, /candidate_type='instrument'/);
  assert.match(v2, /reviewed holding candidate requires uuid holding_id/);
  assert.match(v2, /reviewed company holding requires exactly target_company_id/);
  assert.match(v2, /reviewed fund holding requires exactly target_fund_id/);
  assert.match(v2, /reviewed instrument parent holding is unresolved or not company-targeted/);
  assert.match(v2, /from corvis_facts\.canonicalize_reviewed_extraction\(/);

  // Runtime always enters the newest transactional wrapper. Each layer delegates
  // explicitly so identity materialization cannot bypass v2/v3 economic guarantees.
  assert.match(runtime, /canonicalize_reviewed_extraction_v4/);
  assert.match(v4, /from corvis_facts\.canonicalize_reviewed_extraction_v3\(/);
  assert.match(v3, /from corvis_facts\.canonicalize_reviewed_extraction_v2\(/);
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
