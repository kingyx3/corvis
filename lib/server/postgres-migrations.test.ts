import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationFiles = [
  "db/postgres/migrations/001_control_plane.sql",
  "db/postgres/migrations/002_source_canonical_serving.sql",
  "db/postgres/migrations/003_operations_delivery_governance.sql",
  "db/postgres/migrations/004_actor_subject_and_research.sql",
  "db/postgres/migrations/005_identity_review_publication.sql",
  "db/postgres/migrations/006_upload_delivery_operations.sql",
];

async function migrations(): Promise<string> {
  return (await Promise.all(migrationFiles.map((path) => readFile(path, "utf8")))).join("\n");
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tenantBearingTables(sql: string): string[] {
  const tables = new Set<string>();
  const pattern = /create table if not exists\s+([a-z0-9_.]+)\s*\(([\s\S]*?)\n\);/gi;
  for (const match of sql.matchAll(pattern)) {
    const [, table, body] = match;
    if (table && /\btenant_id\b/i.test(body ?? "")) tables.add(table.toLowerCase());
  }
  return [...tables].sort();
}

test("Postgres migrations do not reintroduce Snowflake-only DDL", async () => {
  const sql = (await migrations()).toUpperCase();
  for (const token of ["ROW ACCESS POLICY", "PARSE_JSON(", "CURRENT_ROLE()", "COUNT_IF(", "SECURE VIEW"]) {
    assert.equal(sql.includes(token), false, `unexpected Snowflake-only token: ${token}`);
  }
});

test("every tenant-bearing Postgres table enables RLS and has an explicit read policy", async () => {
  const sql = (await migrations()).toLowerCase();
  const tables = tenantBearingTables(sql);
  assert.ok(tables.length >= 20, `expected broad tenant table coverage, found only ${tables.length}`);

  for (const table of tables) {
    const escaped = regexEscape(table);
    assert.match(sql, new RegExp(`alter\\s+table\\s+${escaped}\\s+enable\\s+row\\s+level\\s+security\\s*;`), `${table} must enable RLS`);
    assert.match(sql, new RegExp(`create\\s+policy\\s+[a-z0-9_]+\\s+on\\s+${escaped}\\s+for\\s+select\\s+using\\s*\\(`), `${table} must define a SELECT policy`);
  }

  assert.equal(/create policy[^;]+for (insert|update|delete|all)/.test(sql), false, "client-facing migrations must not add broad mutation policies");
});

test("RLS helpers bind access to active, effective auth.uid membership", async () => {
  const sql = (await migrations()).toLowerCase();
  assert.match(sql, /create or replace function corvis_control\.has_tenant_access\(row_tenant_id uuid\)/);
  assert.match(sql, /where m\.tenant_id = row_tenant_id[\s\S]*m\.user_id = auth\.uid\(\)/);
  assert.match(sql, /create or replace function corvis_control\.has_workspace_access\(row_tenant_id uuid, row_workspace_id uuid\)/);
  assert.match(sql, /m\.workspace_id = row_workspace_id[\s\S]*m\.user_id = auth\.uid\(\)/);
  assert.match(sql, /m\.status = 'active'/);
  assert.match(sql, /m\.valid_from <= now\(\)/);
  assert.match(sql, /m\.valid_until is null or m\.valid_until > now\(\)/);
});

test("Postgres serving views remain tenant-keyed", async () => {
  const sql = (await migrations()).toLowerCase();
  assert.match(sql, /create or replace view corvis_serving\.documents as/);
  assert.match(sql, /create or replace view corvis_serving\.observations as/);
  assert.match(sql, /select o\.tenant_id,/);
  assert.match(sql, /create or replace view corvis_serving\.fund_period_snapshots as/);
  assert.match(sql, /select s\.tenant_id,/);
  assert.match(sql, /create or replace view corvis_serving\.source_references as\s+select r\.tenant_id,/);
});

test("review corrections and publication transitions preserve immutable history", async () => {
  const sql = (await migrations()).toLowerCase();
  assert.match(sql, /create table if not exists corvis_facts\.observation_correction/);
  assert.match(sql, /create or replace function corvis_facts\.apply_review_decision/);
  assert.match(sql, /create table if not exists corvis_consolidated\.snapshot_publication_event/);
  assert.match(sql, /create or replace function corvis_consolidated\.append_snapshot_transition/);
  assert.equal(/update corvis_facts\.observation\s+set\s+value_/i.test(sql), false);
});

test("artifact release and job retry atomically emit durable work", async () => {
  const sql = (await migrations()).toLowerCase();
  assert.match(sql, /create or replace function corvis_source\.release_clean_artifact/);
  assert.match(sql, /'documentregistered'/);
  assert.match(sql, /create or replace function corvis_control\.retry_processing_job/);
  assert.match(sql, /'processingjobretryrequested'/);
});

test("webhook deliveries have durable claims and bounded attempts", async () => {
  const sql = (await migrations()).toLowerCase();
  assert.match(sql, /state text not null check \(state in \('delivering','complete','retryable','failed'\)\)/);
  assert.match(sql, /unique \(tenant_id, webhook_id, event_id, attempt\)/);
});
