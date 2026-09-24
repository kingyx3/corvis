import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function ruleset(source: string, name: string, nextName?: string): string {
  const marker = `resource "cloudflare_ruleset" "${name}"`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name} Cloudflare ruleset`);
  if (!nextName) return source.slice(start);
  const end = source.indexOf(`resource "cloudflare_ruleset" "${nextName}"`, start + marker.length);
  assert.ok(end > start, `missing ruleset after ${name}`);
  return source.slice(start, end);
}

test("shared Cloudflare zone policy has one Terraform owner and environment roots own only host resources", async () => {
  const environmentEdge = await read("infra/terraform/modules/cloudflare-edge/main.tf");
  const sharedPolicy = await read("infra/terraform/modules/cloudflare-zone-policy/main.tf");
  const sharedRoot = await read("infra/terraform/shared/cloudflare/main.tf");
  const uat = await read("infra/terraform/environments/uat/main.tf");
  const prod = await read("infra/terraform/environments/prod/main.tf");

  assert.doesNotMatch(environmentEdge, /cloudflare_zone_setting|cloudflare_ruleset/);
  assert.match(environmentEdge, /cloudflare_worker/);
  assert.match(environmentEdge, /cloudflare_workers_route/);
  assert.match(environmentEdge, /cloudflare_dns_record/);

  assert.match(sharedRoot, /module "zone_policy"/);
  assert.match(sharedRoot, /source\s*=\s*"\.\.\/\.\.\/modules\/cloudflare-zone-policy"/);
  assert.equal((sharedPolicy.match(/resource "cloudflare_ruleset"/g) ?? []).length, 4);
  assert.equal((sharedPolicy.match(/resource "cloudflare_zone_setting"/g) ?? []).length, 4);

  assert.doesNotMatch(uat, /enable_managed_waf\s*=/);
  assert.doesNotMatch(prod, /enable_managed_waf\s*=/);
});

test("one root domain derives only first-level prod and UAT hostnames and exact browser origins", async () => {
  const sharedPolicy = await read("infra/terraform/modules/cloudflare-zone-policy/main.tf");
  const uat = await read("infra/terraform/environments/uat/main.tf");
  const prod = await read("infra/terraform/environments/prod/main.tf");

  for (const label of ["api", "app", "admin", "api-uat", "app-uat", "admin-uat"]) {
    assert.match(sharedPolicy, new RegExp(`"${label}\\.\\$\\{var\\.zone_name\\}"`));
  }
  assert.doesNotMatch(sharedPolicy, /\.uat\.\$\{var\.zone_name\}/);

  assert.match(uat, /api_hostname\s*=.*"api-uat\.\$\{trimspace\(var\.cloudflare_zone_name\)\}"/);
  assert.match(uat, /customer_hostname\s*=.*"app-uat\.\$\{trimspace\(var\.cloudflare_zone_name\)\}"/);
  assert.match(uat, /admin_hostname\s*=.*"admin-uat\.\$\{trimspace\(var\.cloudflare_zone_name\)\}"/);
  assert.match(prod, /api_hostname\s*=.*"api\.\$\{trimspace\(var\.cloudflare_zone_name\)\}"/);

  assert.match(uat, /upload_allowed_origins\s*=.*\["https:\/\/\$\{local\.customer_hostname\}"\]/);
  assert.match(uat, /browser_allowed_origins\s*=.*\["https:\/\/\$\{local\.customer_hostname\}", "https:\/\/\$\{local\.admin_hostname\}"\]/);
  assert.match(prod, /upload_allowed_origins\s*=.*\["https:\/\/\$\{local\.customer_hostname\}"\]/);
  assert.doesNotMatch(`${uat}\n${prod}`, /allowed_origins[\s\S]*\*/i);
});

test("Cloudflare shared policy scopes application behavior and preserves Free or Pro entitlement paths", async () => {
  const policy = await read("infra/terraform/modules/cloudflare-zone-policy/main.tf");
  const variables = await read("infra/terraform/modules/cloudflare-zone-policy/variables.tf");

  const customWaf = ruleset(policy, "custom_waf", "managed_waf");
  const managedWaf = ruleset(policy, "managed_waf", "rate_limits");
  const rateLimits = ruleset(policy, "rate_limits", "cache");
  const cache = ruleset(policy, "cache");

  assert.equal((customWaf.match(/\bref\s*=/g) ?? []).length, 3);
  assert.match(customWaf, /local\.corvis_host_expression/);
  assert.match(managedWaf, /expression\s*=\s*local\.corvis_host_expression/);
  assert.match(cache, /expression\s*=\s*local\.corvis_host_expression/);

  // Free: one path-only rule, 10-second period, IP counting. Host is not an
  // available Free rate-limit match field, so environment isolation remains
  // authoritative in the application's Postgres-backed rate limiter.
  assert.match(rateLimits, /rate_limit_corvis_api_by_ip_free/);
  assert.ok(rateLimits.includes('expression  = "(starts_with(http.request.uri.path, \\"/api/\\"))"'));
  assert.match(rateLimits, /characteristics\s*=\s*\["cf\.colo\.id", "ip\.src"\]/);
  assert.match(rateLimits, /period\s*=\s*10/);
  assert.match(rateLimits, /mitigation_timeout\s*=\s*10/);

  // Pro+: two independent rules use Host matching so prod and UAT do not share
  // the same Cloudflare edge counter.
  assert.match(rateLimits, /rate_limit_prod_api_by_ip/);
  assert.match(rateLimits, /http\.host eq \\"\$\{local\.prod_api_hostname\}\\"/);
  assert.match(rateLimits, /rate_limit_uat_api_by_ip/);
  assert.match(rateLimits, /http\.host eq \\"\$\{local\.uat_api_hostname\}\\"/);

  assert.match(variables, /variable "enable_managed_waf"[\s\S]*?default\s*=\s*false/);
  assert.match(variables, /Free-compatible one-rule baseline/i);
});

test("shared zone workflow uses independent state and a dedicated least-privilege policy token", async () => {
  const workflow = await read(".github/workflows/cloudflare-zone-policy.yml");

  assert.match(workflow, /environment:\s*uat/);
  assert.match(workflow, /corvis-shared-tf-state/);
  assert.match(workflow, /prefix=corvis\/cloudflare-zone-policy/);
  assert.match(workflow, /secrets\.CLOUDFLARE_ZONE_POLICY_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /github\.ref != 'refs\/heads\/main'/);
  assert.match(workflow, /release-governance\.mjs/);
});

test("environment lifecycle cannot delete or address the independent shared Cloudflare state", async () => {
  const lifecycle = await read(".github/workflows/gcp-decommission.yml");
  const shared = await read(".github/workflows/cloudflare-zone-policy.yml");

  assert.match(lifecycle, /TF_STATE_BUCKET:\s*\$\{\{ format\('\{0\}-corvis-tf-state'/);
  assert.doesNotMatch(lifecycle, /corvis-shared-tf-state|cloudflare-zone-policy/);
  assert.match(shared, /corvis-shared-tf-state/);
  assert.match(shared, /prefix=corvis\/cloudflare-zone-policy/);
});

test("security acceptance exercises the real Free-compatible rules without header probes", async () => {
  const acceptance = await read(".github/scripts/security-acceptance.mjs");

  assert.doesNotMatch(acceptance, /x-corvis-security-probe/);
  assert.match(acceptance, /\/__corvis\/security\/waf-block/);
  assert.match(acceptance, /await sleep\(11_000\)/);
  assert.match(acceptance, /maxProbeRequests = 80/);
  assert.match(acceptance, /\/api\/v1\/health/);
});
