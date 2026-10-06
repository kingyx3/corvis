import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = "db/postgres/migrations/001_baseline.sql";

async function sql(): Promise<string> {
  return (await readFile(migration, "utf8")).toLowerCase();
}

// Slice one table (or view) definition out of the baseline so enum/column assertions stay scoped to it.
function definition(text: string, kind: "table" | "view", name: string, terminator: string): string {
  const start = text.indexOf(`create ${kind} ${name}`);
  assert.ok(start >= 0, `missing ${kind} ${name}`);
  const end = text.indexOf(terminator, start);
  assert.ok(end > start, `unterminated ${kind} ${name}`);
  return text.slice(start, end);
}

function table(text: string, name: string): string {
  return definition(text, "table", name, "\n);");
}

test("economic identities keep durable IDs while names remain historical", async () => {
  const text = await sql();

  const entityName = table(text, "corvis_identity.entity_name");
  assert.match(entityName, /name_kind text not null/);
  assert.match(
    entityName,
    /check \(\(name_kind = any \(array\['canonical'::text, 'legal'::text, 'trading'::text, 'marketed'::text, 'abbreviation'::text, 'program_code'::text, 'codename'::text, 'other'::text\]\)\)\)/,
  );
  assert.match(text, /entity_name_current_fund_canonical_uniq/);
  assert.match(text, /entity_name_current_company_canonical_uniq/);
  assert.match(text, /capture_fund_canonical_name_history/);
  assert.match(text, /capture_company_canonical_name_history/);
  assert.match(text, /after update of canonical_name on corvis_identity\.fund/);
  assert.match(text, /after update of canonical_name on corvis_identity\.company/);
});

test("tenant-private aliases cannot silently become cross-tenant identity data", async () => {
  const text = await sql();

  assert.match(table(text, "corvis_identity.tenant_entity_name"), /tenant_id uuid not null,/);
  assert.match(
    text,
    /alter table only corvis_identity\.tenant_entity_name\s+add constraint \w+ foreign key \(tenant_id\) references corvis_control\.tenant\(tenant_id\)/,
  );
  assert.match(
    text,
    /alter table only corvis_identity\.tenant_entity_name\s+add constraint \w+ foreign key \(tenant_id, source_reference_id\) references corvis_source\.source_reference\(tenant_id, source_reference_id\)/,
  );
  assert.match(text, /alter table corvis_identity\.tenant_entity_name enable row level security/);
  assert.match(text, /alter table only corvis_identity\.tenant_entity_name force row level security/);
  assert.match(
    text,
    /create policy \w+ on corvis_identity\.tenant_entity_name for select using \(corvis_control\.has_tenant_access\(tenant_id\)\)/,
  );
});

test("identity matching survives name changes through independent external identifiers", async () => {
  const text = await sql();

  const identifiers = table(text, "corvis_identity.entity_external_identifier");
  for (const identifier of ["lei", "cik", "company_registry", "ticker", "isin", "sedol", "cusip", "vendor_id", "gp_or_admin_id"]) {
    assert.ok(identifiers.includes(`'${identifier}'`), `missing identifier type ${identifier}`);
  }
  assert.match(identifiers, /valid_from date/);
  assert.match(identifiers, /valid_to date/);
  assert.match(identifiers, /is_current boolean default true not null/);
});

test("lifecycle model supports rename, M&A, branching and successor scenarios without collapsing identities", async () => {
  const text = await sql();

  const lifecycleEvent = table(text, "corvis_identity.entity_lifecycle_event");
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
    assert.ok(lifecycleEvent.includes(`'${event}'`), `missing lifecycle event ${event}`);
  }

  const participant = table(text, "corvis_identity.entity_lifecycle_participant");
  for (const role of ["predecessor", "successor", "acquirer", "acquired", "surviving_entity", "merged_constituent", "source_entity", "resulting_entity", "parent", "child", "seller", "buyer", "transferred_entity"]) {
    assert.ok(participant.includes(`'${role}'`), `missing lifecycle participant role ${role}`);
  }
  assert.match(participant, /economic_identity_continues boolean/);
});

test("directory consumers can traverse current/history names and entity relationships", async () => {
  const text = await sql();

  const relationshipTable = table(text, "corvis_identity.entity_relationship");
  for (const relationship of ["successor_of", "merged_into", "acquired_by", "parent_of", "subsidiary_of", "spun_off_from", "carved_out_from", "reorganized_from", "related_vehicle"]) {
    assert.ok(relationshipTable.includes(`'${relationship}'`), `missing relationship ${relationship}`);
  }
  const directory = definition(text, "view", "corvis_serving.entity_directory", ";\n");
  assert.match(directory, /from corvis_identity\.entity_name n/);
  assert.match(directory, /from corvis_identity\.entity_external_identifier i/);
  assert.match(directory, /from corvis_identity\.company c$/);
  assert.match(text, /create view corvis_serving\.entity_relationships as/);
  // Tenant-private aliases stay behind tenant_entity_name RLS: the shared directory never reads them.
  assert.doesNotMatch(directory, /tenant_entity_name/);
});
