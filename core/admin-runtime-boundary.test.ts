import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("admin edge exposes only audited privileged API route families", async () => {
  const worker = await read("infra/terraform/modules/cloudflare-admin-edge/admin-proxy.mjs");

  assert.match(worker, /\/api\/v1\/admin/);
  assert.match(worker, /\/api\/v1\/source-connections/);
  assert.match(worker, /retry\|recover/);
  assert.match(worker, /api_request && !isprivilegedapi/);
  assert.match(worker, /headers\.delete\("host"\)/);
  assert.match(worker, /headers\.delete\("x-api-key"\)/);
  assert.match(worker, /x-frame-options/);
  assert.match(worker, /no-referrer/);
});

test("admin presentation runtime has a distinct identity and no data-plane grants", async () => {
  for (const environment of ["uat", "prod"]) {
    const root = await read(`infra/terraform/environments/${environment}/main.tf`);
    assert.match(root, /module "admin_runtime"/);
    assert.match(root, /surface\s*=\s*"admin"/);
    assert.match(root, /module "admin_gateway"/);
    assert.match(root, /module "cloudflare_admin_edge"/);
    assert.match(root, /admin_hostname/);
  }

  const runtime = await read("infra/terraform/modules/cloud-run-customer/main.tf");
  assert.doesNotMatch(runtime, /secret_key_ref|corvis_postgres_dsn|allusers|allauthenticatedusers/);
});

test("admin application surface uses only allowlisted admin APIs", async () => {
  const page = await read("app/admin/page.tsx");
  assert.match(page, /\/api\/v1\/admin\/readiness/);
  assert.match(page, /\/api\/v1\/admin\/feature-flags/);
  assert.match(page, /\/api\/v1\/admin\/control-evidence/);
  assert.doesNotMatch(page, /\/api\/v1\/funds|\/api\/v1\/workspace/);
});
