import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = "db/postgres/migrations/034_entity_identity_provenance_guards.sql";

async function sql(): Promise<string> {
  return (await readFile(migration, "utf8")).toLowerCase();
}

test("new fund and company identities automatically receive canonical name history", async () => {
  const text = await sql();

  assert.match(text, /create or replace function corvis_identity\.seed_fund_canonical_name_history/);
  assert.match(text, /after insert on corvis_identity\.fund/);
  assert.match(text, /create or replace function corvis_identity\.seed_company_canonical_name_history/);
  assert.match(text, /after insert on corvis_identity\.company/);
  assert.match(text, /'canonical-name-insert-trigger'/);
});

test("private lifecycle evidence remains tenant scoped and source traceable", async () => {
  const text = await sql();

  assert.match(text, /create table if not exists corvis_identity\.tenant_entity_lifecycle_evidence/);
  assert.match(text, /foreign key \(tenant_id, source_reference_id\)/);
  assert.match(text, /references corvis_source\.source_reference\(tenant_id, source_reference_id\)/);
  assert.match(text, /alter table corvis_identity\.tenant_entity_lifecycle_evidence enable row level security/);
  assert.match(text, /alter table corvis_identity\.tenant_entity_lifecycle_evidence force row level security/);
  assert.match(text, /using \(corvis_control\.has_tenant_access\(tenant_id\)\)/);
});

test("polymorphic lifecycle relationships are unique per event edge", async () => {
  const text = await sql();

  for (const index of [
    "entity_relationship_fund_to_fund_event_uniq",
    "entity_relationship_fund_to_company_event_uniq",
    "entity_relationship_company_to_fund_event_uniq",
    "entity_relationship_company_to_company_event_uniq",
  ]) {
    assert.ok(text.includes(index), `missing relationship uniqueness index ${index}`);
  }
});
