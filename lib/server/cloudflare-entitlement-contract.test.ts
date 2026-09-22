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

test("Cloudflare baseline remains deployable on Free while Pro managed WAF stays optional", async () => {
  const edge = await read("infra/terraform/modules/cloudflare-edge/main.tf");
  const variables = await read("infra/terraform/modules/cloudflare-edge/variables.tf");

  const customWaf = ruleset(edge, "custom_waf", "managed_waf");
  const rateLimits = ruleset(edge, "rate_limits", "cache");
  const cache = ruleset(edge, "cache");

  // Free currently allows five custom WAF rules, one rate-limit rule and ten
  // cache rules. Keep the baseline comfortably inside those counts.
  assert.equal((customWaf.match(/\bref\s*=/g) ?? []).length, 3);
  assert.equal((rateLimits.match(/\bref\s*=/g) ?? []).length, 1);
  assert.equal((cache.match(/\bref\s*=/g) ?? []).length, 1);

  // The Free rate-limit expression supports Path plus IP counting only, with a
  // 10-second counting/mitigation period. Host/header/method matching would move
  // this baseline onto a higher entitlement.
  assert.ok(rateLimits.includes('expression  = "(starts_with(http.request.uri.path, \\"/api/\\"))"'));
  assert.doesNotMatch(rateLimits, /http\.host|http\.request\.headers|http\.request\.method/);
  assert.ok(rateLimits.includes('characteristics     = ["cf.colo.id", "ip.src"]'));
  assert.match(rateLimits, /period\s*=\s*10/);
  assert.match(rateLimits, /mitigation_timeout\s*=\s*10/);
  assert.match(rateLimits, /requests_per_period\s*=\s*local\.api_requests_per_10_seconds/);
  assert.match(edge, /api_requests_per_10_seconds\s*=\s*max\(1,\s*ceil\(var\.api_requests_per_minute \/ 6\)\)/);

  // The deterministic WAF probe is path-based and does not consume a
  // request-header entitlement.
  assert.ok(customWaf.includes('expression  = "(http.request.uri.path eq \\"/__corvis/security/waf-block\\")"'));
  assert.doesNotMatch(customWaf, /http\.request\.headers/);

  // Paid managed rules are an explicit Pro+ opt-in, never part of the Free
  // baseline. Free still receives Cloudflare's provider-managed Free ruleset.
  assert.match(variables, /variable "enable_managed_waf"[\s\S]*?default\s*=\s*false/);
  assert.match(variables, /keep false on free/i);
});

test("security acceptance exercises the real Free-compatible rules without header probes", async () => {
  const acceptance = await read(".github/scripts/security-acceptance.mjs");

  assert.doesNotMatch(acceptance, /x-corvis-security-probe/);
  assert.match(acceptance, /\/__corvis\/security\/waf-block/);
  assert.match(acceptance, /await sleep\(11_000\)/);
  assert.match(acceptance, /maxProbeRequests = 80/);
  assert.match(acceptance, /\/api\/v1\/health/);
});
