import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("tools/ci/require-secret-latest.sh");

async function probe(states: Record<string, string>, secrets = Object.keys(states), project = "test-project") {
  const root = await mkdtemp(path.join(tmpdir(), "corvis-secret-readiness-"));
  try {
    const log = path.join(root, "calls.jsonl");
    await writeFile(path.join(root, "gcloud"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require('node:fs');
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args.slice(0, 4).join(' ') !== 'secrets versions describe latest') process.exit(90);
if (!args.includes('--format=value(state)')) process.exit(91);
const secret = args.find(arg => arg.startsWith('--secret=')).slice(9);
const state = JSON.parse(process.env.SECRET_STATES)[secret];
if (state === undefined || state === 'ERROR') process.exit(1);
process.stdout.write(state);
`, { mode: 0o755 });
    const result = spawnSync("bash", [script, ...secrets], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GCP_PROJECT_ID: project, CALL_LOG: log, SECRET_STATES: JSON.stringify(states) },
    });
    const calls = await readFile(log, "utf8").catch(() => "");
    return { ...result, calls: calls.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("readiness checks latest metadata for both credentials without reading payloads", async () => {
  const result = await probe({ runtime: "ENABLED", migration: "ENABLED" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(args => args.includes("--project=test-project")));
  assert.match(result.stdout, /migration: latest version is ENABLED/);
});

for (const state of ["DISABLED", "DESTROYED", "", "ERROR"]) {
  test(`readiness refuses latest ${state || "empty state"} even with an older enabled version`, async () => {
    // The old workflow listed enabled versions and would accept the older one.
    // This fake refuses that API, so a regression to filtering cannot pass.
    const result = await probe({ runtime: "ENABLED", migration: state, later: "ENABLED" });
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 2, "stop at the first unavailable credential");
    assert.doesNotMatch(result.stdout, /later: latest version is ENABLED/);
  });
}

test("readiness fails closed for missing version, project and arguments", async () => {
  assert.equal((await probe({}, ["missing"])).status, 1);
  assert.equal((await probe({ runtime: "ENABLED" }, ["runtime"], "")).status, 1);
  assert.equal((await probe({}, [])).status, 1);
});

test("deployment separates migration authority and preserves rollback without migration credentials", async () => {
  const workflow = await readFile(".github/workflows/terraform-deploy.yml", "utf8");
  const migration = workflow.split("- name: Apply versioned Postgres migrations")[1].split("- name:")[0];
  const readiness = workflow.split("- name: Require enabled Postgres migration secret")[1].split("- uses:")[0];
  for (const block of [migration, readiness]) {
    assert.match(block, /inputs\.rollback_known_good != true/);
    assert.match(block, /POSTGRES_MIGRATION_DSN_SECRET/);
    assert.doesNotMatch(block, /\$\{POSTGRES_DSN_SECRET\}/);
  }
  assert.match(migration, /::add-mask::/);
  assert.match(workflow, /require-secret-latest\.sh "\$\{POSTGRES_DSN_SECRET\}"/);
  assert.doesNotMatch(workflow.split("- name: Require enabled Postgres runtime secret")[1].split("- uses:")[0], /gcloud secrets versions list/);
  const runtime = await readFile("infra/terraform/modules/cloud-run-runtime/main.tf", "utf8");
  const grants = [...runtime.matchAll(/resource "google_secret_manager_secret_iam_member" "[^"]+" \{([^}]+(?:\}[^\n]*\n)?)/g)]
    .map(match => match[1]).filter(block => block.includes("postgres_migration_dsn"));
  assert.equal(grants.length, 1);
  assert.match(grants[0], /local\.deployer_service_account_email/);
  assert.doesNotMatch(grants[0], /api_service_account_email|worker_service_account_email/);
  assert.doesNotMatch(runtime, /secret = google_secret_manager_secret\.postgres_migration_dsn/);
});

test("append-only control evidence acceptance runs in required Postgres CI", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /PGDATABASE=corvis_migration_smoke psql -X -v ON_ERROR_STOP=1 -f db\/postgres\/tests\/control-evidence-append-only\.sql/);
});
