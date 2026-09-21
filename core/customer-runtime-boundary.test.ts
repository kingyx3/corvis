import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("presentation Cloud Run runtimes are least-privilege and fail-closed", async () => {
  const runtime = await read("infra/terraform/modules/cloud-run-customer/main.tf");

  assert.match(runtime, /corvis_runtime_surface/);
  assert.match(runtime, /value\s*=\s*var\.surface/);
  assert.match(runtime, /roles\/logging\.logwriter/);
  assert.doesNotMatch(
    runtime,
    /google_secret_manager_secret_iam_member|secret_key_ref|corvis_postgres_dsn|google_storage_bucket_iam_member|google_pubsub_|google_cloud_tasks_/,
  );
  assert.doesNotMatch(runtime, /allusers|allauthenticatedusers/);
  assert.match(runtime, /@sha256:/);
});

test("customer edge sends UI and only public API traffic to different gateways", async () => {
  const worker = await read("infra/terraform/modules/cloudflare-customer-edge/customer-proxy.mjs");
  const edge = await read("infra/terraform/modules/cloudflare-customer-edge/main.tf");

  assert.match(worker, /pathname\.startswith\("\/api\/v1\/"\)/);
  assert.match(worker, /!url\.pathname\.startswith\("\/api\/v1"\)/);
  assert.match(worker, /api_gateway_host/);
  assert.match(worker, /customer_gateway_host/);
  assert.match(worker, /headers\.delete\("host"\)/);
  assert.match(worker, /headers\.delete\("x-api-key"\)/);
  assert.match(worker, /x-corvis-edge-proxy/);
  assert.match(edge, /customer_gateway_api_key/);
  assert.match(edge, /api_gateway_api_key/);
});

test("production-like roots provision isolated customer services", async () => {
  for (const environment of ["uat", "prod"]) {
    const root = await read(`infra/terraform/environments/${environment}/main.tf`);
    assert.match(root, /module "customer_runtime"/);
    assert.match(root, /surface\s*=\s*"customer"/);
    assert.match(root, /module "customer_gateway"/);
    assert.match(root, /module "cloudflare_customer_edge"/);
    assert.match(root, /upload_allowed_origins\s*=\s*local\.edge_enabled/);
  }
});
