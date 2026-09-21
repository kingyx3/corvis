import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("customer Cloud Run runtime is presentation-only and fail-closed", async () => {
  const runtime = await read("infra/terraform/modules/cloud-run-customer/main.tf");

  assert.match(runtime, /corvis_runtime_surface/);
  assert.match(runtime, /value\s*=\s*"customer"/);
  assert.match(runtime, /roles\/logging\.logwriter/);
  assert.doesNotMatch(runtime, /secretmanager|postgres|storage\.object|pubsub|cloudtasks/);
  assert.doesNotMatch(runtime, /allusers|allauthenticatedusers/);
  assert.match(runtime, /@sha256:/);
});

test("customer edge sends UI and API traffic to different gateways", async () => {
  const worker = await read("infra/terraform/modules/cloudflare-customer-edge/customer-proxy.mjs");
  const edge = await read("infra/terraform/modules/cloudflare-customer-edge/main.tf");

  assert.match(worker, /pathname\.startswith\("\/api\/"\)/);
  assert.match(worker, /api_gateway_host/);
  assert.match(worker, /customer_gateway_host/);
  assert.match(worker, /x-api-key/);
  assert.match(edge, /customer_gateway_api_key/);
  assert.match(edge, /api_gateway_api_key/);
});

test("production-like roots provision isolated customer services", async () => {
  for (const environment of ["uat", "prod"]) {
    const root = await read(`infra/terraform/environments/${environment}/main.tf`);
    assert.match(root, /module "customer_runtime"/);
    assert.match(root, /module "customer_gateway"/);
    assert.match(root, /module "cloudflare_customer_edge"/);
    assert.match(root, /upload_allowed_origins\s*=\s*local\.edge_enabled/);
  }
});
