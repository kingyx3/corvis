import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("runtime secret lifecycle is keyless and keeps payloads out of terraform", async () => {
  const workflow = await read(".github/workflows/runtime-secrets.yml");

  assert.match(workflow, /google-github-actions\/auth@v3/);
  assert.match(workflow, /workload_identity_provider/);
  assert.match(workflow, /rotate-gateway-identity/);
  assert.match(workflow, /openssl rand -base64 48/);
  assert.match(workflow, /gcloud secrets versions add/);
  assert.match(workflow, /--data-file="\$\{secret_file\}"/);
  assert.match(workflow, /github\.ref != 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /service-account.*json|google_application_credentials|tf_var_.*secret/);
});

test("runtime audit checks metadata without reading secret payloads", async () => {
  const workflow = await read(".github/workflows/runtime-secrets.yml");

  assert.match(workflow, /gcloud secrets describe/);
  assert.match(workflow, /gcloud secrets versions list/);
  assert.match(workflow, /state=enabled/);
  assert.doesNotMatch(workflow, /secrets versions access/);
});

test("security acceptance uses the Terraform-owned Postgres secret contract", async () => {
  const acceptance = await read(".github/workflows/security-acceptance.yml");
  const runtime = await read("infra/terraform/modules/cloud-run-runtime/main.tf");

  assert.match(acceptance, /corvis-postgres-dsn-\{0\}/);
  assert.match(runtime, /\$\{var\.postgres_dsn_secret_id\}-\$\{var\.environment\}/);
  assert.doesNotMatch(acceptance, /corvis-\{0\}-postgres-dsn/);
});

test("runtime secret docs preserve provider ownership of Postgres credentials", async () => {
  const docs = await read("docs/RUNTIME_SECRETS.md");

  assert.match(docs, /controlled supabase\/postgres activation path/);
  assert.match(docs, /must not be committed, persisted in terraform state/);
  assert.ok(docs.includes("audit verifies that both terraform-managed containers exist and each has an enabled version. it reads version metadata only"));
});
