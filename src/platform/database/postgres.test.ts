import assert from "node:assert/strict";
import test from "node:test";
import { PostgresHttpSqlApi } from "../../test-support/http-sql-driver.ts";
import { postgres, postgresRuntime, registerDatabaseDriver, withTransaction } from "./postgres.ts";

test("database factory fails closed for missing and unsupported bindings", () => {
  assert.throws(
    () => postgres(),
    (error: unknown) => error instanceof Error
      && error.message.includes("CORVIS_DATABASE_DSN"),
  );
  assert.throws(() => postgres("http://postgres.example.test/sql"), /Unsupported PostgreSQL transport/);
});

test("database transport selection treats URI schemes case-insensitively", () => {
  const native = postgresRuntime("PostgreSQL://corvis:secret@localhost:5432/postgres?sslmode=disable");
  assert.equal(native.capabilities.nativeTransactions, true);
  assert.equal(native.capabilities.logicalReplication, true);

  // The test double registered by importing test-support answers https:// bindings, in any letter case.
  assert.ok(postgres("HTTPS://postgres.example.test/sql") instanceof PostgresHttpSqlApi);
});

test("a non-native runtime advertises only capabilities it can safely provide", () => {
  const runtime = postgresRuntime("https://postgres.example.test/sql", "supabase");
  assert.equal(runtime.provider, "supabase");
  assert.ok(runtime.api instanceof PostgresHttpSqlApi);
  assert.equal(runtime.capabilities.nativeTransactions, false);
  assert.equal(runtime.capabilities.advisoryLocks, false);
  assert.equal(runtime.capabilities.logicalReplication, false);
});

test("no non-native driver can be registered in production", () => {
  const driver = { accepts: () => true, connect: () => { throw new Error("must not connect"); } };
  for (const nodeEnv of ["production", "Production", "staging"]) {
    assert.throws(() => registerDatabaseDriver(driver, nodeEnv), /cannot be registered in production/, nodeEnv);
  }
  assert.doesNotThrow(() => registerDatabaseDriver({ accepts: () => false, connect: () => { throw new Error("unused"); } }, "test"));
});

test("native PostgreSQL runtime advertises transaction and PostgreSQL session capabilities", () => {
  const dsn = "postgresql://corvis:secret@localhost:5432/postgres?sslmode=disable";
  const runtime = postgresRuntime(dsn);
  const cachedRuntime = postgresRuntime(dsn, "gcp-cloud-sql");
  assert.equal(runtime.provider, "unknown");
  assert.equal(runtime.capabilities.nativeTransactions, true);
  assert.equal(runtime.capabilities.advisoryLocks, true);
  assert.equal(runtime.capabilities.logicalReplication, true);
  assert.equal(cachedRuntime.provider, "gcp-cloud-sql");
  assert.equal(cachedRuntime.api, runtime.api);
});

test("legacy transaction alias rejects non-transactional transports before mutation", async () => {
  const db = postgres("https://postgres.example.test/sql");
  let called = false;
  await assert.rejects(
    async () => withTransaction(db, async () => { called = true; }),
    /Database transport does not provide native transactions/,
  );
  assert.equal(called, false);
});
