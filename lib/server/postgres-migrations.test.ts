import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = "db/postgres/migrations";
const versionedMigrationPattern = /^\d{3}_[a-z0-9_]+\.sql$/i;

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && versionedMigrationPattern.test(entry.name))
    .map((entry) => `${migrationDirectory}/${entry.name}`)
    .sort();
}

async function migrations(): Promise<string> {
  const files = await migrationFiles();
  return (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
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

test("migration contract suite discovers every versioned SQL migration in deterministic sequence", async () => {
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const allSqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => `${migrationDirectory}/${entry.name}`)
    .sort();
  const files = await migrationFiles();

  assert.deepEqual(files, allSqlFiles, "every SQL file in the Postgres migration directory must use the versioned migration naming contract");
  assert.ok(files.length >= 7, `expected all current Postgres migrations to be covered, found only ${files.length}`);

  const numbers = files.map((file) => {
    const name = file.slice(file.lastIndexOf("/") + 1);
    return Number(name.slice(0, 3));
  });
  assert.deepEqual(
    numbers,
    Array.from({ length: numbers.length }, (_, index) => index + 1),
    "Postgres migration numbers must remain contiguous so deploy workflows cannot silently skip a version",
  );
});

test("Postgres migrations do not reintroduce Snowflake-only DDL", async () => {
  const sql = (await migrations()).toUpperCase();
  for (const token of ["ROW ACCESS POLICY", "PARSE_JSON(", "CURRENT_ROLE()", "COUNT_IF(", "SECURE VIEW"]) {
    assert.equal(sql.includes(token), false, `unexpected Snowflake-only token: ${token}`);
  }
});

test("every tenant-bearing Postgres table enables RLS, including server-only deny-by-default tables", async () => {
  const sql = (await migrations()).toLowerCase();
  const tables = tenantBearingTables(sql);
  assert.ok(tables.length >= 20, `expected broad tenant table coverage, found only ${tables.length}`);

  for (const table of tables) {
    const escaped = regexEscape(table);
    assert.match(sql, new RegExp(`alter\\s+table\\s+${escaped}\\s+enable\\s+row\\s+level\\s+security\\s*;`), `${table} must enable RLS`);
  }

  // Some control tables (for example idempotency state) are intentionally
  // server-only. RLS with no client SELECT policy is stronger than making them
  // tenant-readable, so the exhaustive contract requires RLS rather than a
  // policy on every table.
  const selectPolicies = [...sql.matchAll(/create\s+policy\s+([a-z0-9_]+)\s+on\s+([a-z0-9_.]+)\s+for\s+select\s+using\s*\(([\s\S]*?)\);/g)];
  assert.ok(selectPolicies.length >= 15, `expected broad explicit SELECT-policy coverage, found only ${selectPolicies.length}`);
  for (const [, policy, table, expression] of selectPolicies) {
    assert.match(expression ?? "", /corvis_control\.has_tenant_access|corvis_control\.has_workspace_access|auth\.uid\(\)/, `${policy} on ${table} must derive access from tenant/workspace membership or auth.uid()`);
    assert.equal(/\btrue\b/.test(expression ?? ""), false, `${policy} on ${table} must not be allow-all`);
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

test("reconciliation exceptions are versioned, attributable and enforced at publication persistence", async () => {
  const sql = (await migrations()).toLowerCase();
  assert.match(sql, /create table if not exists corvis_consolidated\.reconciliation_exception/);
  assert.match(sql, /unique \(tenant_id, snapshot_id, snapshot_version, exception_key\)/);
  assert.match(sql, /create table if not exists corvis_consolidated\.reconciliation_resolution_event/);
  assert.match(sql, /before_state jsonb not null/);
  assert.match(sql, /after_state jsonb not null/);
  assert.match(sql, /create or replace function corvis_consolidated\.resolve_reconciliation_exception/);
  assert.match(sql, /p_action <> 'select_source'/);
  assert.match(sql, /p_selected_source_reference_id = any\(current_row\.competing_source_reference_ids\)/);
  assert.match(sql, /insert into corvis_consolidated\.reconciliation_resolution_event[\s\S]*update corvis_consolidated\.reconciliation_exception/);
  assert.match(sql, /create or replace view corvis_serving\.reconciliation_exceptions as/);
  assert.match(sql, /e\.status='open'/);
  assert.match(sql, /if effective_blockers > 0 then raise exception 'blocking reconciliation exceptions remain'/);
  assert.match(sql, /count\(distinct r\.actor_subject\)[\s\S]*< 2/);
  assert.equal(/update corvis_facts\.observation\s+set\s+value_/i.test(sql), false, "resolution must not rewrite immutable source observation values");
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

test("webhook signing keys are tenant/subscription-scoped, never shared, and rotation cannot leave zero or two active keys", async () => {
  const sql = (await migrations()).toLowerCase();
  assert.match(sql, /create table if not exists corvis_control\.webhook_signing_key/);
  assert.match(sql, /secret text not null check \(length\(secret\) >= 32\)/);
  assert.match(sql, /create unique index if not exists webhook_signing_key_one_active_idx\s*\n\s*on corvis_control\.webhook_signing_key \(tenant_id, webhook_id\)\s*\n\s*where status = 'active'/);
  assert.match(sql, /create or replace function corvis_control\.rotate_webhook_signing_key/);
  assert.match(sql, /status = 'retiring', retire_by = now\(\) \+ make_interval\(secs => p_grace_seconds\)/);
  assert.match(sql, /create or replace function corvis_control\.create_webhook_subscription/);
  // A subscription can never be created without its first signing key.
  assert.match(sql, /insert into corvis_control\.webhook_subscription[\s\S]*insert into corvis_control\.webhook_signing_key/);
});
