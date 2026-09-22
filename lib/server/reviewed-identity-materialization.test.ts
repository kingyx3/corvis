import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reviewed fund and company candidates materialize before downstream economic facts", async () => {
  const sql = (await readFile("db/postgres/migrations/038_materialize_reviewed_identities.sql", "utf8")).toLowerCase();
  const runtime = (await readFile("lib/server/processing-canonicalized-stage.ts", "utf8")).toLowerCase();

  assert.match(sql, /create or replace function corvis_identity\.materialize_reviewed_entity_candidates/);
  assert.match(sql, /candidate_type in \('fund','company'\)/);
  assert.match(sql, /reviewed fund candidate requires resolved global_fund_id/);
  assert.match(sql, /reviewed company candidate requires resolved global_company_id/);
  assert.match(sql, /reviewed fund candidate requires canonical\/source name/);
  assert.match(sql, /reviewed company candidate requires canonical\/source name/);
  assert.match(sql, /reviewed candidate set contains duplicate global_fund_id/);
  assert.match(sql, /reviewed candidate set contains duplicate global_company_id/);
  assert.match(sql, /insert into corvis_identity\.fund/);
  assert.match(sql, /insert into corvis_identity\.company/);

  // v4 first establishes the immutable reviewed canonical ledger, then creates
  // identities, then delegates into v3 so holdings/lifecycle can resolve them.
  const seed = sql.indexOf("from corvis_facts.canonicalize_reviewed_extraction(");
  const materialize = sql.indexOf("perform corvis_identity.materialize_reviewed_entity_candidates");
  const downstream = sql.indexOf("from corvis_facts.canonicalize_reviewed_extraction_v3(");
  assert.ok(seed >= 0 && materialize > seed && downstream > materialize);
  assert.match(runtime, /canonicalize_reviewed_extraction_v4/);
});

test("tenant source labels never silently rename an existing global identity", async () => {
  const sql = (await readFile("db/postgres/migrations/038_materialize_reviewed_identities.sql", "utf8")).toLowerCase();

  assert.match(sql, /tenant_entity_name/);
  assert.match(sql, /'source_label'/);
  assert.match(sql, /review_status='approved'/);
  assert.match(sql, /tenant_entity_revision/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /candidate_fingerprint_sha256/);
  assert.match(sql, /source_reference_ids uuid\[\] not null/);
  assert.doesNotMatch(sql, /update corvis_identity\.fund\s+set canonical_name/);
  assert.doesNotMatch(sql, /update corvis_identity\.company\s+set canonical_name/);
});

test("identity creation never derives a global id from a name", async () => {
  const sql = (await readFile("db/postgres/migrations/038_materialize_reviewed_identities.sql", "utf8")).toLowerCase();

  assert.match(sql, /global_fund_id/);
  assert.match(sql, /global_company_id/);
  assert.doesNotMatch(sql, /normalize_entity_name\([^)]*\)[\s\S]*global_/);
  assert.doesNotMatch(sql, /gen_random_uuid\(\)[\s\S]*global_/);
  assert.doesNotMatch(sql, /md5\([^)]*name/);
});
