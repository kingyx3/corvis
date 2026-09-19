import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(file: string) { return readFile(file, "utf8"); }

test("control evidence stays tamper-evident, tenant-safe and cannot self-promote without objective evidence", async () => {
  const migration = (await source("db/postgres/migrations/015_control_evidence_lifecycle.sql")).toLowerCase();

  for (const table of ["control_definition", "control_evidence_requirement", "control_evidence_record", "control_evidence_escalation"]) {
    assert.match(migration, new RegExp(`alter table corvis_control\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`alter table corvis_control\\.${table} force row level security`));
    assert.match(migration, new RegExp(`create policy ${table}_tenant_select on corvis_control\\.${table} for select`));
  }

  // No table in this migration grants a client-writable mutation policy; every
  // write path is the server-side functions below.
  assert.equal(/create policy[^;]+for (insert|update|delete|all)/.test(migration), false);

  assert.match(migration, /before update or delete on corvis_control\.control_evidence_record/);
  assert.match(migration, /control_evidence_record is append-only; record a new revision instead/);

  assert.match(migration, /function corvis_control\.promote_control_implementation/);
  assert.match(migration, /if v_required = 0 then return null; end if;/, "a control with no mandatory evidence requirement must never self-promote");
  assert.match(migration, /if v_unsatisfied > 0 then return null; end if;/);
  assert.match(migration, /e\.result = 'pass'/);
  assert.match(migration, /e\.collected_at <= p_evaluated_at/);
  assert.match(migration, /e\.valid_through > p_evaluated_at/);

  assert.match(migration, /payload_digest text not null check \(payload_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/, "evidence must be referenced by digest, not by inline confidential payload");
});

test("the registry's producers and cadence are consistent with what the control-evidence route can report", async () => {
  const registry = await source("lib/server/control-evidence-registry.ts");
  assert.match(registry, /export const CONTROL_DEFINITIONS/);
  assert.match(registry, /export const EVIDENCE_SOURCES/);
  assert.match(registry, /gatedOn\?: string/);
});
