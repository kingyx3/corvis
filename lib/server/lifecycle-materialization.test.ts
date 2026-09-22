import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reviewed lifecycle candidates materialize only through v3 canonicalization", async () => {
  const sql = (await readFile("db/postgres/migrations/037_materialize_lifecycle_events.sql", "utf8")).toLowerCase();
  const runtime = (await readFile("lib/server/processing-canonicalized-stage.ts", "utf8")).toLowerCase();

  assert.match(sql, /canonicalize_reviewed_extraction_v3/);
  assert.match(sql, /from corvis_facts\.canonicalize_reviewed_extraction_v2/);
  assert.match(sql, /candidate_type='lifecycle_event'/);
  assert.match(sql, /reviewed lifecycle candidate requires uuid lifecycle_event_id/);
  assert.match(sql, /reviewed lifecycle candidate requires governed event_type/);
  assert.match(sql, /reviewed lifecycle candidate requires participant array/);
  assert.match(sql, /reviewed lifecycle participant requires governed participant_role/);
  assert.match(sql, /reviewed lifecycle company participant identity is unresolved/);
  assert.match(sql, /reviewed lifecycle fund participant identity is unresolved/);
  assert.match(sql, /reviewed lifecycle candidate conflicts with existing governed event/);
  assert.match(sql, /source_kind[\s\S]*tenant_evidence/);
  assert.match(runtime, /canonicalize_reviewed_extraction_v3/);
});

test("tenant-private lifecycle evidence stays attributable and replay-safe", async () => {
  const sql = (await readFile("db/postgres/migrations/037_materialize_lifecycle_events.sql", "utf8")).toLowerCase();

  assert.match(sql, /create table if not exists corvis_identity\.tenant_lifecycle_revision/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /candidate_fingerprint_sha256/);
  assert.match(sql, /effective_payload jsonb not null/);
  assert.match(sql, /source_reference_ids uuid\[\] not null/);
  assert.match(sql, /tenant_entity_lifecycle_evidence/);
  assert.match(sql, /review_status='approved'/);
  assert.match(sql, /on conflict \(tenant_id,lifecycle_event_id,source_reference_id\)/);
});

test("customer lifecycle serving requires own approved evidence for tenant-derived events", async () => {
  const serving = (await readFile("lib/server/public-serving-resources.ts", "utf8")).toLowerCase();
  assert.match(serving, /e\.source_kind in \('governed','public_registry'\)/);
  assert.match(serving, /tenant_entity_lifecycle_evidence te/);
  assert.match(serving, /te\.tenant_id=\$1::uuid/);
  assert.match(serving, /te\.review_status='approved'/);
  assert.match(serving, /not exists \([\s\S]*entity_lifecycle_participant hidden/);
});
