import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function read(filePath: string): Promise<string> {
  return (await readFile(filePath, "utf8")).toLowerCase();
}

async function routeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root)) {
    const child = path.join(root, entry);
    const info = await stat(child);
    if (info.isDirectory()) files.push(...await routeFiles(child));
    else if (entry === "route.ts") files.push(child.replaceAll("\\", "/"));
  }
  return files;
}

function isEdgeAllowlistedAdminRoute(filePath: string): boolean {
  if (filePath.startsWith("app/api/v1/admin/")) return true;
  if (filePath.startsWith("app/api/v1/source-connections/")) return true;
  return /^app\/api\/v1\/jobs\/\[jobid\]\/(?:retry|recover)\/route\.ts$/i.test(filePath);
}

test("admin edge exposes only audited privileged API route families", async () => {
  const worker = await read("infra/terraform/modules/cloudflare-admin-edge/admin-proxy.mjs");

  assert.match(worker, /\/api\/v1\/admin/);
  assert.match(worker, /\/api\/v1\/source-connections/);
  assert.match(worker, /retry\|recover/);
  assert.match(worker, /apirequest && !isprivilegedapi/);
  assert.match(worker, /headers\.delete\("host"\)/);
  assert.match(worker, /headers\.delete\("x-api-key"\)/);
  assert.match(worker, /x-frame-options/);
  assert.match(worker, /no-referrer/);
});

test("every route requiring admin:manage is represented by the admin edge allowlist", async () => {
  const privilegedRoutes: string[] = [];
  for (const filePath of await routeFiles("app/api/v1")) {
    const source = await read(filePath);
    if (source.includes("admin:manage")) privilegedRoutes.push(filePath.toLowerCase());
  }

  assert.ok(privilegedRoutes.length > 0, "expected at least one admin-managed API route");
  const outsideAllowlist = privilegedRoutes.filter((filePath) => !isEdgeAllowlistedAdminRoute(filePath));
  assert.deepEqual(outsideAllowlist, []);
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
