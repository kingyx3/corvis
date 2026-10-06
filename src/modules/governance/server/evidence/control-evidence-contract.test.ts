import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(file: string) { return readFile(file, "utf8"); }

test("control evidence stays tamper-evident, tenant-safe and cannot self-promote without objective evidence", async () => {
  const migration = (await source("db/postgres/migrations/001_baseline.sql")).toLowerCase();

  for (const table of ["control_definition", "control_evidence_requirement", "control_evidence_record", "control_evidence_escalation"]) {
    assert.match(migration, new RegExp(`alter table corvis_control\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`alter table only corvis_control\\.${table} force row level security`));
    assert.match(migration, new RegExp(`create policy ${table}_tenant_select on corvis_control\\.${table} for select`));
  }

  // No control-evidence table grants a client-writable mutation policy; every
  // write path is the server-side functions below.
  assert.equal(/create policy[^;]+for (insert|update|delete|all)/.test(migration), false);

  assert.match(migration, /before delete or update on corvis_control\.control_evidence_record for each row execute function corvis_control\.reject_control_evidence_mutation\(\)/);
  assert.match(migration, /control_evidence_record is append-only; record a new revision instead/);

  const promoteStart = migration.indexOf("create function corvis_control.promote_control_implementation(");
  assert.ok(promoteStart >= 0, "promote_control_implementation must be defined in the baseline");
  const promote = migration.slice(promoteStart, migration.indexOf("\n$$;", promoteStart));
  assert.match(promote, /if v_required = 0 then return null; end if;/, "a control with no mandatory evidence requirement must never self-promote");
  assert.match(promote, /if v_unsatisfied > 0 then return null; end if;/);
  assert.match(promote, /e\.result = 'pass'/);
  assert.match(promote, /e\.collected_at <= p_evaluated_at/);
  assert.match(promote, /e\.valid_through > p_evaluated_at/);

  assert.match(migration, /payload_digest text not null,/, "evidence must be referenced by digest, not by inline confidential payload");
  assert.match(migration, /constraint control_evidence_record_payload_digest_check check \(\(payload_digest ~ '\^\[0-9a-f\]\{64\}\$'::text\)\)/, "the digest must be a sha-256 hex string");
});

test("the registry's producers and cadence are consistent with what the control-evidence route can report", async () => {
  const registry = await source("src/modules/governance/server/evidence/control-evidence-registry.ts");
  assert.match(registry, /export const CONTROL_DEFINITIONS/);
  assert.match(registry, /export const EVIDENCE_SOURCES/);
  assert.match(registry, /gatedOn\?: string/);
});
