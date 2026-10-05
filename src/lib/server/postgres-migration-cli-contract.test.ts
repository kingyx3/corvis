import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(file: string) { return readFile(file, "utf8"); }

test("the migration CLI never applies without an explicit --apply flag and never reads a DSN in dry-run mode", async () => {
  const cli = await source("db/postgres/migrate.ts");
  assert.match(cli, /if \(values\.apply && values\["dry-run"\]\)/);
  assert.match(cli, /if \(!values\.apply\) \{/, "the default path must be the dry-run plan, not an apply");
  assert.match(cli, /const dsn = process\.env\.CORVIS_POSTGRES_DSN;/);
  assert.match(cli, /if \(!dsn\) throw new Error/);
});

test("the CLI always emits a result envelope, even on failure, instead of throwing past its own boundary", async () => {
  const cli = await source("db/postgres/migrate.ts");
  assert.match(cli, /result: "pass"/);
  assert.match(cli, /result: "fail"/);
  assert.match(cli, /process\.exitCode = 1/);
});
