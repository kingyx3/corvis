import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASELINE = "db/postgres/migrations/001_baseline.sql";

// Slice one function definition out of the baseline so assertions stay scoped to that function.
function functionDefinition(sql: string, name: string): string {
  const start = sql.indexOf(`create function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `unterminated function ${name}`);
  return sql.slice(start, end);
}

test("reviewed holding and instrument candidates materialize transactionally before observations", async () => {
  const baseline = (await readFile(BASELINE, "utf8")).toLowerCase();
  const v2 = functionDefinition(baseline, "corvis_facts.canonicalize_reviewed_extraction_v2");
  const v3 = functionDefinition(baseline, "corvis_facts.canonicalize_reviewed_extraction_v3");
  const v4 = functionDefinition(baseline, "corvis_facts.canonicalize_reviewed_extraction_v4");
  const runtime = (await readFile("src/modules/processing/server/stages/processing-canonicalized-stage.ts", "utf8")).toLowerCase();

  assert.match(v2, /^create function corvis_facts\.canonicalize_reviewed_extraction_v2\(/);
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
  const sql = (await readFile(BASELINE, "utf8")).toLowerCase();
  const v2 = functionDefinition(sql, "corvis_facts.canonicalize_reviewed_extraction_v2");

  assert.match(sql, /create table corvis_facts\.holding_revision \(/);
  assert.match(sql, /create table corvis_facts\.instrument_revision \(/);
  assert.match(sql, /alter table only corvis_facts\.holding_revision force row level security/);
  assert.match(sql, /alter table only corvis_facts\.instrument_revision force row level security/);
  assert.match(sql, /effective_payload jsonb not null/);
  assert.match(sql, /source_reference_ids uuid\[\] not null/);
  assert.match(sql, /candidate_fingerprint_sha256/);
  assert.match(v2, /on conflict do nothing/);
  assert.match(v2, /is distinct from/);
  assert.match(v2, /source_reference_id=c\.source_reference_ids\[1\]/);
  assert.match(v2, /reviewed candidate set contains duplicate holding_id/);
  assert.match(v2, /reviewed candidate set contains duplicate instrument_id/);

  // Internal revision ledgers intentionally have no direct customer RLS policy.
  assert.equal(/create policy[^;]+holding_revision/.test(sql), false);
  assert.equal(/create policy[^;]+instrument_revision/.test(sql), false);
});
