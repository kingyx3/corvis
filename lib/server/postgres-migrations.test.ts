import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationFiles = [
  "db/postgres/migrations/001_control_plane.sql",
  "db/postgres/migrations/002_source_canonical_serving.sql",
  "db/postgres/migrations/003_operations_delivery_governance.sql",
];

async function migrations(): Promise<string> {
  return (await Promise.all(migrationFiles.map((path) => readFile(path, "utf8")))).join("\n");
}

test("Postgres migrations do not reintroduce Snowflake-only DDL", async () => {
  const sql = (await migrations()).toUpperCase();
  for (const token of ["ROW ACCESS POLICY", "PARSE_JSON(", "CURRENT_ROLE()", "COUNT_IF(", "SECURE VIEW"]) {
    assert.equal(sql.includes(token), false, `unexpected Snowflake-only token: ${token}`);
  }
});

test("Postgres tenant data enables RLS and has no broad client mutation policies", async () => {
  const sql = (await migrations()).toLowerCase();
  for (const table of [
    "corvis_control.tenant",
    "corvis_control.workspace",
    "corvis_control.membership",
    "corvis_control.processing_job",
    "corvis_control.outbox_event",
    "corvis_control.data_rights",
    "corvis_source.document",
    "corvis_facts.observation",
    "corvis_facts.holding",
    "corvis_consolidated.fund_period_snapshot",
    "corvis_serving.export_job",
  ]) {
    assert.match(sql, new RegExp(`alter table ${table.replace(".", "\\.")} enable row level security`));
  }
  assert.equal(/create policy[^;]+for (insert|update|delete|all)/.test(sql), false);
});

test("Postgres serving views remain tenant-keyed", async () => {
  const sql = (await migrations()).toLowerCase();
  assert.match(sql, /create or replace view corvis_serving\.documents as/);
  assert.match(sql, /create or replace view corvis_serving\.observations as\s+select tenant_id,/);
  assert.match(sql, /create or replace view corvis_serving\.fund_period_snapshots as\s+select tenant_id,/);
  assert.match(sql, /create or replace view corvis_serving\.source_references as\s+select r\.tenant_id,/);
});
