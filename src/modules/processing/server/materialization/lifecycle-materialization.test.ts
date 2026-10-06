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

test("reviewed lifecycle candidates materialize through the governed canonicalization chain", async () => {
  const baseline = (await readFile(BASELINE, "utf8")).toLowerCase();
  const v3 = functionDefinition(baseline, "corvis_facts.canonicalize_reviewed_extraction_v3");
  const v4 = functionDefinition(baseline, "corvis_facts.canonicalize_reviewed_extraction_v4");
  const runtime = (await readFile("src/modules/processing/server/stages/processing-canonicalized-stage.ts", "utf8")).toLowerCase();

  assert.match(v3, /canonicalize_reviewed_extraction_v3/);
  assert.match(v3, /from corvis_facts\.canonicalize_reviewed_extraction_v2/);
  assert.match(v3, /candidate_type='lifecycle_event'/);
  assert.match(v3, /reviewed lifecycle candidate requires uuid lifecycle_event_id/);
  assert.match(v3, /reviewed lifecycle candidate requires governed event_type/);
  assert.match(v3, /reviewed lifecycle candidate requires participant array/);
  assert.match(v3, /reviewed lifecycle participant requires governed participant_role/);
  assert.match(v3, /reviewed lifecycle company participant identity is unresolved/);
  assert.match(v3, /reviewed lifecycle fund participant identity is unresolved/);
  assert.match(v3, /reviewed lifecycle candidate conflicts with existing governed event/);
  assert.match(v3, /source_kind[\s\S]*tenant_evidence/);

  // The runtime enters v4; v4 must explicitly delegate to v3 after materializing
  // reviewed identities so lifecycle validation cannot be bypassed.
  assert.match(runtime, /canonicalize_reviewed_extraction_v4/);
  assert.match(v4, /from corvis_facts\.canonicalize_reviewed_extraction_v3\(/);
});

test("tenant-private lifecycle evidence stays attributable and replay-safe", async () => {
  const sql = (await readFile(BASELINE, "utf8")).toLowerCase();
  const v3 = functionDefinition(sql, "corvis_facts.canonicalize_reviewed_extraction_v3");

  assert.match(sql, /create table corvis_identity\.tenant_lifecycle_revision \(/);
  assert.match(sql, /alter table only corvis_identity\.tenant_lifecycle_revision force row level security/);
  assert.match(sql, /candidate_fingerprint_sha256/);
  assert.match(sql, /effective_payload jsonb not null/);
  assert.match(sql, /source_reference_ids uuid\[\] not null/);
  assert.match(v3, /tenant_entity_lifecycle_evidence/);
  assert.match(v3, /review_status='approved'/);
  assert.match(v3, /on conflict \(tenant_id,lifecycle_event_id,source_reference_id\)/);
});

test("customer lifecycle serving requires own approved evidence for tenant-derived events", async () => {
  const serving = (await readFile("src/platform/data/public-serving-resources.ts", "utf8")).toLowerCase();
  assert.match(serving, /e\.source_kind in \('governed','public_registry'\)/);
  assert.match(serving, /tenant_entity_lifecycle_evidence te/);
  assert.match(serving, /te\.tenant_id=\$1::uuid/);
  assert.match(serving, /te\.review_status='approved'/);
  assert.match(serving, /not exists \([\s\S]*entity_lifecycle_participant hidden/);
});
