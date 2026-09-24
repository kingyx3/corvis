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
  ];

  for (const path of intentionallyNonExternal) {
    assert.doesNotMatch(yaml, new RegExp(`^  ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"), `${path} should not be silently promoted into the external contract`);
    assert.ok(manifest.routes.some((entry) => patternMatches(entry.pattern, path)), `${path} must be explicitly classified`);
  }
});
