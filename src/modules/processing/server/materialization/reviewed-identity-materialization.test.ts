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

test("reviewed fund and company candidates materialize before downstream economic facts", async () => {
  const baseline = (await readFile(BASELINE, "utf8")).toLowerCase();
  const v4 = functionDefinition(baseline, "corvis_facts.canonicalize_reviewed_extraction_v4");
  const v3 = functionDefinition(baseline, "corvis_facts.canonicalize_reviewed_extraction_v3");
  const v2 = functionDefinition(baseline, "corvis_facts.canonicalize_reviewed_extraction_v2");
  const preMaterialize = functionDefinition(baseline, "corvis_identity.pre_materialize_reviewed_entity_candidates");
  const runtime = (await readFile("src/modules/processing/server/stages/processing-canonicalized-stage.ts", "utf8")).toLowerCase();

  assert.match(preMaterialize, /candidate_type in \('fund','company'\)/);
  assert.match(preMaterialize, /reviewed fund candidate requires resolved global_fund_id/);
  assert.match(preMaterialize, /reviewed company candidate requires resolved global_company_id/);
  assert.match(preMaterialize, /reviewed fund candidate requires source or canonical name/);
  assert.match(preMaterialize, /reviewed company candidate requires source or canonical name/);
  assert.match(preMaterialize, /new reviewed fund identity requires explicit canonical_name/);
  assert.match(preMaterialize, /new reviewed company identity requires explicit canonical_name/);
  assert.match(preMaterialize, /reviewed candidate set contains duplicate global_fund_id/);
  assert.match(preMaterialize, /reviewed candidate set contains duplicate global_company_id/);
  assert.match(preMaterialize, /insert into corvis_identity\.fund/);
  assert.match(preMaterialize, /insert into corvis_identity\.company/);

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
  const sql = (await readFile(BASELINE, "utf8")).toLowerCase();
  const v4 = functionDefinition(sql, "corvis_facts.canonicalize_reviewed_extraction_v4");
  const lineage = functionDefinition(sql, "corvis_identity.record_reviewed_entity_candidate_lineage");
  const enterV3 = v4.indexOf("from corvis_facts.canonicalize_reviewed_extraction_v3(");
  const recordLineage = v4.indexOf("perform corvis_identity.record_reviewed_entity_candidate_lineage");
  assert.ok(enterV3 >= 0 && recordLineage > enterV3);
  assert.match(lineage, /canonical source references exist only after v1 has finalized/);
  assert.match(lineage, /tenant_entity_name/);
  assert.match(lineage, /source_reference_id/);
  assert.match(lineage, /tenant_entity_revision/);
});

test("tenant source labels never silently rename or seed an existing global identity", async () => {
  const sql = (await readFile(BASELINE, "utf8")).toLowerCase();
  const preMaterialize = functionDefinition(sql, "corvis_identity.pre_materialize_reviewed_entity_candidates");
  const lineage = functionDefinition(sql, "corvis_identity.record_reviewed_entity_candidate_lineage");

  assert.match(lineage, /'source_label'/);
  assert.match(lineage, /review_status='approved'/);
  assert.match(sql, /alter table only corvis_identity\.tenant_entity_revision force row level security/);
  assert.match(sql, /create table corvis_identity\.tenant_entity_revision \([\s\S]*?candidate_fingerprint_sha256 text not null/);
  assert.match(sql, /create table corvis_identity\.tenant_entity_revision \([\s\S]*?source_reference_ids uuid\[\] not null/);
  assert.doesNotMatch(sql, /update corvis_identity\.fund\s+set canonical_name/);
  assert.doesNotMatch(sql, /update corvis_identity\.company\s+set canonical_name/);

  // Raw/source aliases are accepted only for tenant evidence. The global canonical
  // seed is read exclusively from the explicitly reviewed canonical-name keys.
  assert.match(preMaterialize, /canonical_name_value := nullif\(btrim\(coalesce\([\s\S]*canonical_name[\s\S]*canonicalname/);
  assert.match(preMaterialize, /source_name_value := nullif\(btrim\(coalesce\([\s\S]*source_name[\s\S]*fund_name/);
  assert.match(preMaterialize, /source_name_value := nullif\(btrim\(coalesce\([\s\S]*source_name[\s\S]*company_name/);
});

test("identity creation never derives a global id from a name", async () => {
  const sql = (await readFile(BASELINE, "utf8")).toLowerCase();
  const materialization =
    functionDefinition(sql, "corvis_identity.pre_materialize_reviewed_entity_candidates") +
    functionDefinition(sql, "corvis_identity.record_reviewed_entity_candidate_lineage");

  assert.match(materialization, /global_fund_id/);
  assert.match(materialization, /global_company_id/);
  assert.doesNotMatch(materialization, /normalize_entity_name\([^)]*\)[\s\S]*global_/);
  assert.doesNotMatch(materialization, /gen_random_uuid\(\)[\s\S]*global_/);
  assert.doesNotMatch(materialization, /md5\([^)]*name/);
});
