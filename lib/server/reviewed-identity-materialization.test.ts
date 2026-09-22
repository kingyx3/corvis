import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reviewed fund and company candidates materialize before downstream economic facts", async () => {
  const v4 = (await readFile("db/postgres/migrations/038_materialize_reviewed_identities.sql", "utf8")).toLowerCase();
  const v3 = (await readFile("db/postgres/migrations/037_materialize_lifecycle_events.sql", "utf8")).toLowerCase();
  const v2 = (await readFile("db/postgres/migrations/036_materialize_economic_candidates.sql", "utf8")).toLowerCase();
  const runtime = (await readFile("lib/server/processing-canonicalized-stage.ts", "utf8")).toLowerCase();

  assert.match(v4, /create or replace function corvis_identity\.pre_materialize_reviewed_entity_candidates/);
  assert.match(v4, /candidate_type in \('fund','company'\)/);
  assert.match(v4, /reviewed fund candidate requires resolved global_fund_id/);
  assert.match(v4, /reviewed company candidate requires resolved global_company_id/);
  assert.match(v4, /reviewed fund candidate requires source or canonical name/);
  assert.match(v4, /reviewed company candidate requires source or canonical name/);
  assert.match(v4, /new reviewed fund identity requires explicit canonical_name/);
  assert.match(v4, /new reviewed company identity requires explicit canonical_name/);
  assert.match(v4, /reviewed candidate set contains duplicate global_fund_id/);
  assert.match(v4, /reviewed candidate set contains duplicate global_company_id/);
  assert.match(v4, /insert into corvis_identity\.fund/);
  assert.match(v4, /insert into corvis_identity\.company/);

  // A new report may introduce the complete entity -> holding -> instrument -> metric
  // graph. Lock the dependency order so v1 never validates observations before the
  // identities and economic positions they reference have been projected.
  const preIdentity = v4.indexOf("perform corvis_identity.pre_materialize_reviewed_entity_candidates");
  const enterV3 = v4.indexOf("from corvis_facts.canonicalize_reviewed_extraction_v3(");
  const enterV2 = v3.indexOf("from corvis_facts.canonicalize_reviewed_extraction_v2(");
  const enterV1 = v2.indexOf("from corvis_facts.canonicalize_reviewed_extraction(");
  assert.ok(preIdentity >= 0 && enterV3 > preIdentity);
  assert.ok(enterV2 >= 0 && enterV1 >= 0);
  assert.match(v2, /holdings must exist before instruments and before holding\/instrument metric/);
  assert.match(v2, /candidate_type='holding'/);
  assert.match(v2, /candidate_type='instrument'/);
  assert.match(runtime, /canonicalize_reviewed_extraction_v4/);
});

test("tenant source labels are attached only after canonical source references exist", async () => {
  const sql = (await readFile("db/postgres/migrations/038_materialize_reviewed_identities.sql", "utf8")).toLowerCase();
  const enterV3 = sql.indexOf("from corvis_facts.canonicalize_reviewed_extraction_v3(");
  const recordLineage = sql.indexOf("perform corvis_identity.record_reviewed_entity_candidate_lineage");
  assert.ok(enterV3 >= 0 && recordLineage > enterV3);
  assert.match(sql, /canonical source references exist only after v1 has finalized/);
  assert.match(sql, /tenant_entity_name/);
  assert.match(sql, /source_reference_id/);
  assert.match(sql, /tenant_entity_revision/);
});

test("tenant source labels never silently rename or seed an existing global identity", async () => {
  const sql = (await readFile("db/postgres/migrations/038_materialize_reviewed_identities.sql", "utf8")).toLowerCase();

  assert.match(sql, /'source_label'/);
  assert.match(sql, /review_status='approved'/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /candidate_fingerprint_sha256/);
  assert.match(sql, /source_reference_ids uuid\[\] not null/);
  assert.doesNotMatch(sql, /update corvis_identity\.fund\s+set canonical_name/);
  assert.doesNotMatch(sql, /update corvis_identity\.company\s+set canonical_name/);

  // Raw/source aliases are accepted only for tenant evidence. The global canonical
  // seed is read exclusively from the explicitly reviewed canonical-name keys.
  assert.match(sql, /canonical_name_value := nullif\(btrim\(coalesce\([\s\S]*canonical_name[\s\S]*canonicalname/);
  assert.match(sql, /source_name_value := nullif\(btrim\(coalesce\([\s\S]*source_name[\s\S]*fund_name/);
  assert.match(sql, /source_name_value := nullif\(btrim\(coalesce\([\s\S]*source_name[\s\S]*company_name/);
});

test("identity creation never derives a global id from a name", async () => {
  const sql = (await readFile("db/postgres/migrations/038_materialize_reviewed_identities.sql", "utf8")).toLowerCase();

  assert.match(sql, /global_fund_id/);
  assert.match(sql, /global_company_id/);
  assert.doesNotMatch(sql, /normalize_entity_name\([^)]*\)[\s\S]*global_/);
  assert.doesNotMatch(sql, /gen_random_uuid\(\)[\s\S]*global_/);
  assert.doesNotMatch(sql, /md5\([^)]*name/);
});
