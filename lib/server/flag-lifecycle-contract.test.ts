import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(file: string) { return readFile(file, "utf8"); }

test("flag governance and deletion-evidence tables enable RLS and carry no broad mutation policy", async () => {
  const migration = (await source("db/postgres/migrations/017_flag_governance_and_deletion_evidence.sql")).toLowerCase();

  for (const table of ["feature_flag_emergency_stop", "legal_hold", "deletion_execution_evidence"]) {
    assert.match(migration, new RegExp(`alter table corvis_control\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`create policy ${table}_select on corvis_control\\.${table}\\s+for select using`));
  }
  assert.equal(/create policy[^;]+for (insert|update|delete|all)/.test(migration), false);

  assert.match(migration, /add column if not exists kill_switch_reason text/);
  assert.match(migration, /add column if not exists retire_by timestamptz/);
  assert.match(migration, /add column if not exists evidence_hash text/);
  assert.match(migration, /primary key \(tenant_id, deletion_request_id, attempt\)/, "deletion execution evidence must key on attempt so a replay never overwrites a prior attempt's record");
});

test("feature-flag evaluation is authoritative and denies before rollout state is consulted", async () => {
  const source_ = await source("lib/server/feature-flags.ts");
  assert.match(source_, /if \(snapshot\.emergencyStop\.engaged\) return deny/);
  assert.match(source_, /if \(record\.killSwitch\) return deny/);
  assert.match(source_, /if \(definition\.permission && !hasPermission\(identity, definition\.permission\)\) return deny/);
});

test("deletion execution checks retention coverage and legal holds before ever calling the adapter", async () => {
  const source_ = await source("lib/server/data-lifecycle.ts");
  const retentionIndex = source_.indexOf("retentionCoverage(db");
  const holdsIndex = source_.indexOf("activeLegalHolds(db");
  const fetchIndex = source_.indexOf("fetchImpl(");
  assert.ok(retentionIndex > 0 && holdsIndex > retentionIndex && fetchIndex > holdsIndex, "default-deny checks must precede the destructive adapter call");
});
