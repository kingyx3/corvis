import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

type Classification = { pattern: string; visibility: string; reason: string };

function patternMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return path === base || path.startsWith(`${base}/`);
  }
  const escaped = pattern
    .replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replaceAll("{jobId}", "[^/]+")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

test("PR #149 OpenAPI omissions are explicit non-external classifications, not accidental gaps", async () => {
  const yaml = await readFile("openapi/corvis-v1.yaml", "utf8");
  const manifest = JSON.parse(await readFile("openapi/v1-route-classification.json", "utf8")) as { schemaVersion: number; routes: Classification[] };
  assert.equal(manifest.schemaVersion, 1);
  for (const route of manifest.routes) {
    assert.ok(route.pattern.startsWith("/"));
    assert.ok(route.visibility.length > 0);
    assert.ok(route.reason.length > 10);
  }

  const intentionallyNonExternal = [
    "/source-connections",
    "/source-connections/00000000-0000-4000-8000-000000000001/test",
    "/extraction-review/candidates",
    "/reconciliation-exceptions/resolve",
    "/jobs/job-1/retry",
    "/jobs/job-1/recover",
    "/admin/feature-flags",
    "/admin/webhooks/subscriptions/00000000-0000-4000-8000-000000000001",
    "/access/invitations",
    "/admin/tenants/invitations",
    "/invitations/accept",
  ];

  for (const path of intentionallyNonExternal) {
    assert.doesNotMatch(yaml, new RegExp(`^  ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"), `${path} should not be silently promoted into the external contract`);
    assert.ok(manifest.routes.some((entry) => patternMatches(entry.pattern, path)), `${path} must be explicitly classified`);
  }
});

test("every /api/v1 route handler is either in the OpenAPI contract or explicitly classified", async () => {
  const { readdir } = await import("node:fs/promises");
  const yaml = await readFile("openapi/corvis-v1.yaml", "utf8");
  const manifest = JSON.parse(await readFile("openapi/v1-route-classification.json", "utf8")) as { routes: Classification[] };
  const normalise = (path: string) => path.replace(/\{[^}]+\}/g, "{}");
  const specPaths = new Set([...yaml.matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((match) => normalise(match[1]!)));

  const routes: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`);
      else if (entry.name === "route.ts") routes.push(dir.slice("src/app/api/v1".length) || "/");
    }
  }
  await walk("src/app/api/v1");
  assert.ok(routes.length > 50, "route discovery must find the API surface");

  const unaccounted = routes
    .map((route) => route.replace(/\[([^\]]+)\]/g, "{$1}"))
    .filter((path) => !specPaths.has(normalise(path)) && !manifest.routes.some((entry) => patternMatches(entry.pattern, path) || patternMatches(entry.pattern.replace(/\{[^}]+\}/g, "{jobId}"), path.replace(/\{[^}]+\}/g, "{jobId}"))));
  assert.deepEqual(unaccounted, [], "add each route to openapi/corvis-v1.yaml or openapi/v1-route-classification.json");
});
