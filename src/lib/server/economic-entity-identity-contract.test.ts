import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = "db/postgres/migrations/032_economic_entity_identity_lifecycle.sql";

async function sql(): Promise<string> {
  return (await readFile(migration, "utf8")).toLowerCase();
}

test("economic identities keep durable IDs while names remain historical", async () => {
  const text = await sql();

  assert.match(text, /create table if not exists corvis_identity\.entity_name/);
  assert.match(text, /name_kind text not null check \(name_kind in \(/);
  assert.match(text, /'canonical','legal','trading','marketed','abbreviation','program_code','codename','other'/);
  assert.match(text, /entity_name_current_fund_canonical_uniq/);
  assert.match(text, /entity_name_current_company_canonical_uniq/);
  assert.match(text, /capture_fund_canonical_name_history/);
  assert.match(text, /capture_company_canonical_name_history/);
  assert.match(text, /after update of canonical_name on corvis_identity\.fund/);
  assert.match(text, /after update of canonical_name on corvis_identity\.company/);
});

test("tenant-private aliases cannot silently become cross-tenant identity data", async () => {
  const text = await sql();

  assert.match(text, /create table if not exists corvis_identity\.tenant_entity_name/);
  assert.match(text, /tenant_id uuid not null references corvis_control\.tenant/);
  assert.match(text, /foreign key \(tenant_id, source_reference_id\)/);
  assert.match(text, /alter table corvis_identity\.tenant_entity_name enable row level security/);
  assert.match(text, /alter table corvis_identity\.tenant_entity_name force row level security/);
  assert.match(text, /using \(corvis_control\.has_tenant_access\(tenant_id\)\)/);
});

test("identity matching survives name changes through independent external identifiers", async () => {
  const text = await sql();

  assert.match(text, /create table if not exists corvis_identity\.entity_external_identifier/);
  for (const identifier of ["lei", "cik", "company_registry", "ticker", "isin", "sedol", "cusip", "vendor_id", "gp_or_admin_id"]) {
    assert.ok(text.includes(`'${identifier}'`), `missing identifier type ${identifier}`);
  }
  assert.match(text, /valid_from date/);
  assert.match(text, /valid_to date/);
  assert.match(text, /is_current boolean not null default true/);
});

test("lifecycle model supports rename, M&A, branching and successor scenarios without collapsing identities", async () => {
  const text = await sql();

  assert.match(text, /create table if not exists corvis_identity\.entity_lifecycle_event/);
  for (const event of [
    "rename",
    "acquisition",
    "merger",
    "demerger",
    "split",
    "spin_off",
    "carve_out",
    "partial_divestiture",
    "reorganization",
    "legal_form_change",
    "domicile_change",
    "formation",
    "dissolution",
    "liquidation",
    "fund_restructure",
    "manager_change",
    "listing",
    "delisting",
    "take_private",
    "successor_transition",
  ]) {
    assert.ok(text.includes(`'${event}'`), `missing lifecycle event ${event}`);
  }

  assert.match(text, /create table if not exists corvis_identity\.entity_lifecycle_participant/);
  for (const role of ["predecessor", "successor", "acquirer", "acquired", "surviving_entity", "merged_constituent", "source_entity", "resulting_entity", "parent", "child", "seller", "buyer", "transferred_entity"]) {
    assert.ok(text.includes(`'${role}'`), `missing lifecycle participant role ${role}`);
  }
  assert.match(text, /economic_identity_continues boolean/);
});

test("directory consumers can traverse current/history names and entity relationships", async () => {
  const text = await sql();

  assert.match(text, /create table if not exists corvis_identity\.entity_relationship/);
  for (const relationship of ["successor_of", "merged_into", "acquired_by", "parent_of", "subsidiary_of", "spun_off_from", "carved_out_from", "reorganized_from", "related_vehicle"]) {
    assert.ok(text.includes(`'${relationship}'`), `missing relationship ${relationship}`);
  }
  assert.match(text, /create or replace view corvis_serving\.entity_directory/);
  assert.match(text, /create or replace view corvis_serving\.entity_relationships/);
  assert.match(text, /tenant-private aliases stay behind tenant_entity_name rls/);
});
