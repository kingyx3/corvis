import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresRow } from "./postgres.ts";
import { PostgresDriverError } from "./postgres-native.ts";
import {
  MIGRATION_CONNECTION_LIMITS,
  MigrationApplyError,
  MigrationContractError,
  applyMigrations,
  ledgerInsertSql,
  manifestChecksum,
  migrationChecksum,
  migrationFromSource,
  planMigrations,
  transactionalMigrationSql,
  type AppliedMigration,
  type MigrationFile,
  type MigrationSqlClient,
} from "./postgres-migration-runner.ts";

function migration(version: number, sql = "create table if not exists t (id int);"): MigrationFile {
  const name = `${String(version).padStart(3, "0")}_migration.sql`;
  return migrationFromSource(name, `begin;\n\n${sql}\n\ncommit;\n`);
}

class FakeSqlClient implements MigrationSqlClient {
  readonly executed: string[] = [];
  ledger: AppliedMigration[] = [];

  async query(sql: string): Promise<PostgresRow[]> {
    if (sql.includes("select version, name, checksum")) {
      return this.ledger.map((entry) => ({ version: entry.version, name: entry.name, checksum: entry.checksum }));
    }
    return [];
  }

  async execute(sql: string): Promise<void> {
    this.executed.push(sql);
    const match = /values \((\d+), '([^']+)', '([^']+)', '[^']*'\)/.exec(sql);
    if (match) this.ledger.push({ version: Number(match[1]), name: match[2], checksum: match[3] });
  }
}

test("migrationFromSource rejects a name that does not carry a contiguous three-digit version", () => {
  assert.throws(
    () => migrationFromSource("not_versioned.sql", "begin;\ncommit;\n"),
    (error: unknown) => error instanceof MigrationContractError && error.code === "invalid_migration_name",
  );
});

test("migrationChecksum ignores line-ending and trailing-whitespace noise only", () => {
  const a = migrationChecksum("begin;\ncreate table t (id int);  \ncommit;\n");
  const b = migrationChecksum("begin;\r\ncreate table t (id int);\r\ncommit;\r\n");
  const c = migrationChecksum("begin;\ncreate table t (id integer);\ncommit;\n");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("manifestChecksum is stable under reordering but changes with any migration's content", () => {
  const a = migration(1);
  const b = migration(2);
  assert.equal(manifestChecksum([a, b]), manifestChecksum([b, a]));
  assert.notEqual(manifestChecksum([a, b]), manifestChecksum([a, migration(2, "create table if not exists other (id int);")]));
});

test("planMigrations refuses a duplicate version claimed by two files", () => {
  const dup = migrationFromSource("001_other.sql", "begin;\ncommit;\n");
  assert.throws(
    () => planMigrations([migration(1), dup], []),
    (error: unknown) => error instanceof MigrationContractError && error.code === "duplicate_version",
  );
});

test("planMigrations refuses a gap in the repository's own version sequence", () => {
  assert.throws(
    () => planMigrations([migration(1), migration(3)], []),
    (error: unknown) => error instanceof MigrationContractError && error.code === "version_gap",
  );
});

test("planMigrations refuses a gap in the database's applied history", () => {
  assert.throws(
    () => planMigrations([migration(1), migration(2)], [{ version: 2, name: "002_migration.sql", checksum: migration(2).checksum }]),
    (error: unknown) => error instanceof MigrationContractError && error.code === "applied_history_gap",
  );
});

test("planMigrations refuses an applied migration that no longer exists in the repository", () => {
  const one = migration(1);
  assert.throws(
    () => planMigrations([one], [{ version: 1, name: one.name, checksum: one.checksum }, { version: 2, name: "gone.sql", checksum: "y" }]),
    (error: unknown) => error instanceof MigrationContractError && error.code === "unknown_applied_migration",
  );
});

test("planMigrations refuses checksum drift on an already-applied migration", () => {
  const one = migration(1);
  assert.throws(
    () => planMigrations([one], [{ version: 1, name: one.name, checksum: "0".repeat(64) }]),
    (error: unknown) => error instanceof MigrationContractError && error.code === "checksum_drift",
  );
});

test("planMigrations reports pending migrations beyond the applied high-water mark", () => {
  const one = migration(1);
  const two = migration(2);
  const plan = planMigrations([one, two], [{ version: 1, name: one.name, checksum: one.checksum }]);
  assert.deepEqual(plan.pending.map((entry) => entry.version), [2]);
  assert.deepEqual(plan.applied.map((entry) => entry.version), [1]);
});

test("transactionalMigrationSql requires the migration to open with begin; and close with commit;", () => {
  const notTransactional = migrationFromSource("001_migration.sql", "create table t (id int);");
  assert.throws(
    () => transactionalMigrationSql(notTransactional, "ci"),
    (error: unknown) => error instanceof MigrationContractError && error.code === "not_single_transaction",
  );
});

test("transactionalMigrationSql splices the ledger insert inside the same transaction", () => {
  const spliced = transactionalMigrationSql(migration(1), "github-actions");
  const beginIndex = spliced.toLowerCase().indexOf("begin;");
  const ledgerIndex = spliced.indexOf("insert into corvis_migration.schema_migration");
  const commitIndex = spliced.toLowerCase().lastIndexOf("commit;");
  assert.ok(beginIndex >= 0 && beginIndex < ledgerIndex && ledgerIndex < commitIndex);
});

test("transactionalMigrationSql claims the ledger row before the migration body so concurrent runners cannot both apply it", () => {
  const spliced = transactionalMigrationSql(migration(7, "create table if not exists body_marker (id int);"), "ci");
  const beginIndex = spliced.toLowerCase().indexOf("begin;");
  const ledgerIndex = spliced.indexOf("insert into corvis_migration.schema_migration");
  const bodyIndex = spliced.indexOf("body_marker");
  const commitIndex = spliced.toLowerCase().lastIndexOf("commit;");
  assert.ok(beginIndex === 0 && beginIndex < ledgerIndex && ledgerIndex < bodyIndex && bodyIndex < commitIndex);
  // A conflict clause would let a second runner that planned the same version
  // skip the ledger insert and re-run the body; the primary-key violation is
  // what serializes and rejects it.
  assert.equal(/on conflict/i.test(spliced), false);
  assert.equal(spliced.match(/\bbegin;/gi)?.length, 1);
  assert.equal(spliced.match(/\bcommit;/gi)?.length, 1);
});

test("transactionalMigrationSql keeps a leading header comment ahead of begin;", () => {
  const withHeader = migrationFromSource("001_migration.sql", "-- header\n-- Depends on nothing.\n\nbegin;\n\ncreate table t (id int);\n\ncommit;\n");
  const spliced = transactionalMigrationSql(withHeader, "ci");
  assert.ok(spliced.startsWith("-- header\n-- Depends on nothing.\n\nbegin;"));
  assert.ok(spliced.indexOf("insert into corvis_migration.schema_migration") < spliced.indexOf("create table t"));
});

test("migration connections lift the API pool's 30s statement and 35s client read caps but keep lock waits bounded", () => {
  assert.equal(MIGRATION_CONNECTION_LIMITS.query_timeout, 0);
  assert.ok(MIGRATION_CONNECTION_LIMITS.statement_timeout >= 10 * 60_000);
  assert.ok(MIGRATION_CONNECTION_LIMITS.lock_timeout > 0 && MIGRATION_CONNECTION_LIMITS.lock_timeout <= 60_000);
  assert.equal(MIGRATION_CONNECTION_LIMITS.max, 1);
});

test("ledgerInsertSql rejects an applied-by identifier outside the allowed character set", () => {
  assert.throws(
    () => ledgerInsertSql(migration(1), "not a valid identifier!"),
    (error: unknown) => error instanceof MigrationContractError && error.code === "invalid_applied_by",
  );
});

test("applyMigrations replays only pending migrations and records each in the ledger", async () => {
  const client = new FakeSqlClient();
  const report = await applyMigrations(client, { appliedBy: "ci", migrations: [migration(1), migration(2)] });
  assert.deepEqual(report.applied.map((entry) => entry.version), [1, 2]);
  assert.deepEqual(report.alreadyApplied, []);
  assert.equal(client.ledger.length, 2);
});

test("applyMigrations is idempotent: a second run against an up-to-date database executes no migration SQL", async () => {
  const client = new FakeSqlClient();
  const migrations = [migration(1), migration(2)];
  const countTransactions = () => client.executed.filter((sql) => sql.includes("insert into corvis_migration.schema_migration")).length;

  await applyMigrations(client, { appliedBy: "ci", migrations });
  assert.equal(countTransactions(), 2);

  const second = await applyMigrations(client, { appliedBy: "ci", migrations });
  assert.equal(second.applied.length, 0);
  assert.deepEqual(second.alreadyApplied, [1, 2]);
  assert.equal(countTransactions(), 2, "no additional migration transaction should execute");
});

test("applyMigrations refuses to replay when an already-applied migration's checksum has drifted", async () => {
  const client = new FakeSqlClient();
  await applyMigrations(client, { appliedBy: "ci", migrations: [migration(1)] });
  const edited = [migration(1, "create table if not exists t (id int, extra text);")];
  await assert.rejects(
    () => applyMigrations(client, { appliedBy: "ci", migrations: edited }),
    (error: unknown) => error instanceof MigrationContractError && error.code === "checksum_drift",
  );
});

test("applyMigrations reports the failing version and applied history without SQL values", async () => {
  const client = new FakeSqlClient();
  await applyMigrations(client, { appliedBy: "ci", migrations: [migration(1)] });
  const execute = client.execute.bind(client);
  client.execute = async (sql: string) => {
    if (sql.includes("secret_marker")) throw new PostgresDriverError("query", "42601");
    await execute(sql);
  };
  const migrations = [migration(1), migration(2), migration(3, "create table secret_marker (id int);"), migration(4)];
  await assert.rejects(
    () => applyMigrations(client, { appliedBy: "ci", migrations }),
    (error: unknown) => {
      assert.ok(error instanceof MigrationApplyError);
      assert.equal(error.code, "migration_apply_failed");
      assert.equal(error.failedVersion, 3);
      assert.equal(error.failedMigration, "003_migration.sql");
      assert.deepEqual(error.alreadyApplied, [1]);
      assert.deepEqual(error.appliedThisRun, [2]);
      assert.equal(error.driverCode, "42601");
      assert.equal(error.message, "migration 003_migration.sql failed: Postgres query failed (SQLSTATE 42601)");
      return true;
    },
  );
});

test("the repository's own migration directory produces a valid, gapless replay plan", async () => {
  const { planFromDirectory } = await import("./postgres-migration-runner.ts");
  const plan = await planFromDirectory();
  assert.ok(plan.migrations.length >= 17);
  assert.deepEqual(plan.applied, []);
  assert.equal(plan.pending.length, plan.migrations.length);
});
