#!/usr/bin/env node
// Postgres migration replay CLI.
//
//   node db/postgres/migrate.ts --dry-run
//   node db/postgres/migrate.ts --apply --applied-by github-actions --evidence migration-evidence.json
//
// --dry-run validates the repository contract and prints the full replay plan
// without contacting a database. --apply replays pending migrations against
// CORVIS_POSTGRES_DSN and records every applied version in the ledger.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  MIGRATION_DIRECTORY,
  MigrationContractError,
  applyMigrations,
  planFromDirectory,
} from "../../lib/server/postgres-migration-runner.ts";
import { postgres } from "../../lib/server/postgres.ts";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    directory: { type: "string", default: MIGRATION_DIRECTORY },
    "applied-by": { type: "string" },
    evidence: { type: "string" },
  },
});

const directory = values.directory ?? MIGRATION_DIRECTORY;
const appliedBy = values["applied-by"] ?? process.env.CORVIS_MIGRATION_APPLIED_BY ?? "local";

async function run(): Promise<Record<string, unknown>> {
  if (values.apply && values["dry-run"]) throw new Error("choose either --apply or --dry-run");
  if (!values.apply) {
    const plan = await planFromDirectory(directory);
    return { ...plan, mode: "dry-run", directory, appliedBy };
  }
  const dsn = process.env.CORVIS_POSTGRES_DSN;
  if (!dsn) throw new Error("CORVIS_POSTGRES_DSN is required to apply Postgres migrations");
  const report = await applyMigrations(postgres(dsn), { directory, appliedBy });
  return { ...report, mode: "apply" };
}

const startedAt = new Date().toISOString();
let evidence: Record<string, unknown>;
let failed = false;
try {
  evidence = { startedAt, result: "pass", ...(await run()) };
} catch (error) {
  failed = true;
  evidence = {
    startedAt,
    result: "fail",
    mode: values.apply ? "apply" : "dry-run",
    directory,
    code: error instanceof MigrationContractError ? error.code : "migration_failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

const serialized = JSON.stringify(evidence, null, 2);
if (values.evidence) await writeFile(values.evidence, `${serialized}\n`, "utf8");
process.stdout.write(`${serialized}\n`);
if (failed) process.exitCode = 1;
