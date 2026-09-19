import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(file: string) { return readFile(file, "utf8"); }

test("source connections carry no client-writable policy and their secret reference is tenant-bound", async () => {
  const migration = (await source("db/postgres/migrations/018_source_connectors.sql")).toLowerCase();

  assert.match(migration, /alter table corvis_source\.source_connection enable row level security/);
  assert.match(migration, /alter table corvis_source\.source_connection force row level security/);
  // source_connection is intentionally server-only: no client SELECT policy at all.
  assert.equal(/create policy\s+source_connection_(select|tenant_select)\s+on\s+corvis_source\.source_connection\b/.test(migration), false);
  assert.equal(/create policy[^;]+for (insert|update|delete|all)/.test(migration), false, "no table in this migration may grant a client mutation policy");

  assert.match(migration, /constraint source_connection_secret_reference_tenant_scoped check/);
  assert.match(migration, /secret_reference ~ \('\^projects\/\[a-z0-9\]\[a-z0-9-\]\{4,28\}\[a-z0-9\]\/secrets\/corvis-src-' \|\| tenant_id::text \|\| /, "the secret reference format must bind the tenant id into the resource name itself");

  assert.match(migration, /constraint source_connection_revoked_is_terminal check \(\(status = 'revoked'\) = \(revoked_at is not null\)\)/);

  for (const table of ["source_connection_run", "acquired_document"]) {
    assert.match(migration, new RegExp(`alter table corvis_source\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`create policy ${table}_tenant_select on corvis_source\\.${table}\\s+for select using`));
  }

  assert.match(migration, /unique \(tenant_id, source_connection_id, acquisition_key\)/, "idempotent re-discovery depends on this uniqueness constraint");
});

test("connections are created and rotated through the SecretStore port, never with an inline secret payload", async () => {
  const module_ = await source("lib/server/source-connectors.ts");
  assert.match(module_, /export interface SecretStore/);
  assert.match(module_, /secrets\.write\(identity\.tenantId, input\.providerKey, input\.secret\)/, "createSourceConnection must write through the secret store before Postgres ever sees a reference");
  assert.match(module_, /await dependencies\.secrets\.revoke\(previousReference\)/, "reauthorization must revoke the prior secret rather than leaving it live");
  assert.match(module_, /'redacted' as secret_reference/, "the customer-facing listing must never select the real secret reference");
});
