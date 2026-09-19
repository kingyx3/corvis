import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { PostgresPrimitive, PostgresRow } from "./postgres.ts";

/**
 * Deterministic Postgres migration replay.
 *
 * Deployment workflows apply reviewed SQL from Git in a single forward-only
 * order and record every applied version in a runner-owned ledger. Replay is
 * re-runnable, refuses history gaps and refuses checksum drift on migrations
 * that a database already applied, so a UAT/prod database can always be proven
 * reproducible from the repository alone.
 */

export const MIGRATION_DIRECTORY = "db/postgres/migrations";
export const LEDGER_SCHEMA = "corvis_migration";
export const LEDGER_TABLE = `${LEDGER_SCHEMA}.schema_migration`;

/** The ledger is runner-owned infrastructure, not tenant data: deny-by-default, no policies. */
export const LEDGER_DDL = `create schema if not exists ${LEDGER_SCHEMA};
create table if not exists ${LEDGER_TABLE} (
  version integer primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),
  applied_by text not null
);
alter table ${LEDGER_TABLE} enable row level security;
revoke all on ${LEDGER_TABLE} from public;
revoke all on schema ${LEDGER_SCHEMA} from public;`;

const migrationFileNamePattern = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const appliedByPattern = /^[A-Za-z0-9._@:+\-/]{1,128}$/;
const trailingCommitPattern = /commit\s*;$/i;
const leadingBeginPattern = /^(?:\s|--[^\n]*\n)*begin\s*;/i;

export type MigrationContractCode =
  | "invalid_migration_name"
  | "duplicate_version"
  | "version_gap"
  | "applied_history_gap"
  | "unknown_applied_migration"
  | "checksum_drift"
  | "not_single_transaction"
  | "invalid_applied_by";

export class MigrationContractError extends Error {
  readonly code: MigrationContractCode;
  constructor(code: MigrationContractCode, message: string) {
    super(message);
    this.name = "MigrationContractError";
    this.code = code;
  }
}

export interface MigrationSqlClient {
  query(sql: string, parameters?: PostgresPrimitive[]): Promise<PostgresRow[]>;
  execute(sql: string, parameters?: PostgresPrimitive[]): Promise<void>;
}

export type MigrationFile = {
  version: number;
  name: string;
  slug: string;
  checksum: string;
  bytes: number;
  sql: string;
};

export type AppliedMigration = { version: number; name: string; checksum: string };

export type MigrationSummary = { version: number; name: string; checksum: string; bytes: number };

export type MigrationPlan = {
  schemaVersion: "corvis.postgres-migration-plan.v1";
  manifestChecksum: string;
  migrations: MigrationSummary[];
  applied: MigrationSummary[];
  pending: MigrationSummary[];
};

export type AppliedMigrationResult = MigrationSummary & { durationMs: number };

export type ApplyReport = {
  schemaVersion: "corvis.postgres-migration-apply.v1";
  directory: string;
  appliedBy: string;
  manifestChecksum: string;
  alreadyApplied: number[];
  applied: AppliedMigrationResult[];
};

export type ApplyOptions = {
  appliedBy: string;
  directory?: string;
  migrations?: MigrationFile[];
  now?: () => number;
};

/** Checksums ignore line-ending and trailing-whitespace noise only. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(normalizeSql(sql)).digest("hex");
}

export function migrationFromSource(name: string, sql: string): MigrationFile {
  const match = migrationFileNamePattern.exec(name);
  if (!match) {
    throw new MigrationContractError(
      "invalid_migration_name",
      `migration ${name} must be named <NNN>_<lower_snake_slug>.sql so replay order is deterministic`,
    );
  }
  const normalized = normalizeSql(sql);
  return {
    version: Number(match[1]),
    name,
    slug: String(match[2]),
    checksum: migrationChecksum(sql),
    bytes: Buffer.byteLength(normalized, "utf8"),
    sql,
  };
}

export async function loadMigrations(directory: string = MIGRATION_DIRECTORY): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const files = await Promise.all(
    names.map(async (name) => migrationFromSource(name, await readFile(`${directory}/${name}`, "utf8"))),
  );
  return files.sort((left, right) => left.version - right.version);
}

export function manifestChecksum(migrations: MigrationFile[]): string {
  const hash = createHash("sha256");
  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    hash.update(`${migration.version}\t${migration.name}\t${migration.checksum}\n`);
  }
  return hash.digest("hex");
}

/**
 * Refuses every history shape a replay cannot prove: directory gaps, duplicate
 * versions, applied history gaps, applied migrations that no longer exist in
 * Git, and edits to already-applied SQL.
 */
export function planMigrations(migrations: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const seen = new Map<number, MigrationFile>();
  for (const migration of ordered) {
    const duplicate = seen.get(migration.version);
    if (duplicate) {
      throw new MigrationContractError(
        "duplicate_version",
        `migration version ${migration.version} is claimed by both ${duplicate.name} and ${migration.name}`,
      );
    }
    seen.set(migration.version, migration);
  }
  ordered.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationContractError(
        "version_gap",
        `migration versions must be contiguous from 001; expected ${index + 1} but found ${migration.version} (${migration.name})`,
      );
    }
  });

  const appliedOrdered = [...applied].sort((left, right) => left.version - right.version);
  appliedOrdered.forEach((record, index) => {
    if (record.version !== index + 1) {
      throw new MigrationContractError(
        "applied_history_gap",
        `applied migration history must be contiguous from 001; expected ${index + 1} but the database recorded ${record.version}`,
      );
    }
  });

  const appliedSummaries: MigrationSummary[] = appliedOrdered.map((record) => {
    const migration = seen.get(record.version);
    if (!migration) {
      throw new MigrationContractError(
        "unknown_applied_migration",
        `the database applied migration ${record.version} (${record.name}) which no longer exists in this repository`,
      );
    }
    if (migration.checksum !== record.checksum) {
      throw new MigrationContractError(
        "checksum_drift",
        `migration ${migration.name} changed after it was applied (recorded ${record.checksum}, repository ${migration.checksum}); add a new forward migration instead`,
      );
    }
    return summarize(migration);
  });

  const highestApplied = appliedOrdered.length;
  return {
    schemaVersion: "corvis.postgres-migration-plan.v1",
    manifestChecksum: manifestChecksum(ordered),
    migrations: ordered.map(summarize),
    applied: appliedSummaries,
    pending: ordered.filter((migration) => migration.version > highestApplied).map(summarize),
  };
}

export async function planFromDirectory(
  directory: string = MIGRATION_DIRECTORY,
  applied: AppliedMigration[] = [],
): Promise<MigrationPlan> {
  return planMigrations(await loadMigrations(directory), applied);
}

export async function ensureMigrationLedger(client: MigrationSqlClient): Promise<void> {
  await client.execute(LEDGER_DDL);
}

export async function readAppliedMigrations(client: MigrationSqlClient): Promise<AppliedMigration[]> {
  const rows = await client.query(`select version, name, checksum from ${LEDGER_TABLE} order by version asc`);
  return rows.map((row) => ({
    version: Number(row.version ?? 0),
    name: String(row.name ?? ""),
    checksum: String(row.checksum ?? ""),
  }));
}

/**
 * Splices the ledger insert into the migration's own transaction so a version
 * can never be recorded without its DDL, or applied without being recorded.
 */
export function transactionalMigrationSql(migration: MigrationFile, appliedBy: string): string {
  const normalized = normalizeSql(migration.sql).trimEnd();
  if (!leadingBeginPattern.test(normalized) || !trailingCommitPattern.test(normalized)) {
    throw new MigrationContractError(
      "not_single_transaction",
      `migration ${migration.name} must open with begin; and close with commit; so replay is atomic`,
    );
  }
  const body = normalized.replace(trailingCommitPattern, "").trimEnd();
  return `${body}\n\n${ledgerInsertSql(migration, appliedBy)}\n\ncommit;\n`;
}

export function ledgerInsertSql(migration: MigrationFile, appliedBy: string): string {
  if (!appliedByPattern.test(appliedBy)) {
    throw new MigrationContractError(
      "invalid_applied_by",
      "applied-by must be a short identifier of letters, digits and ._@:+-/ characters",
    );
  }
  return `insert into ${LEDGER_TABLE} (version, name, checksum, applied_by)
values (${migration.version}, '${migration.name}', '${migration.checksum}', '${appliedBy}')
on conflict (version) do nothing;`;
}

/** Idempotent: a second run against an up-to-date database executes no migration SQL. */
export async function applyMigrations(client: MigrationSqlClient, options: ApplyOptions): Promise<ApplyReport> {
  const directory = options.directory ?? MIGRATION_DIRECTORY;
  const migrations = options.migrations ?? (await loadMigrations(directory));
  const clock = options.now ?? (() => Date.now());

  for (const migration of migrations) transactionalMigrationSql(migration, options.appliedBy);

  await ensureMigrationLedger(client);
  const plan = planMigrations(migrations, await readAppliedMigrations(client));

  const applied: AppliedMigrationResult[] = [];
  for (const pending of plan.pending) {
    const migration = migrations.find((candidate) => candidate.version === pending.version);
    if (!migration) continue;
    const startedAt = clock();
    await client.execute(transactionalMigrationSql(migration, options.appliedBy));
    applied.push({ ...pending, durationMs: Math.max(0, clock() - startedAt) });
  }

  return {
    schemaVersion: "corvis.postgres-migration-apply.v1",
    directory,
    appliedBy: options.appliedBy,
    manifestChecksum: plan.manifestChecksum,
    alreadyApplied: plan.applied.map((record) => record.version),
    applied,
  };
}

function summarize(migration: MigrationFile): MigrationSummary {
  return { version: migration.version, name: migration.name, checksum: migration.checksum, bytes: migration.bytes };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}
