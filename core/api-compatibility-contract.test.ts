import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type Baseline = {
  version: number;
  apiPrefix: string;
  openapiVersion: string;
  publishedOperations: Record<string, string[]>;
  stableConventions: string[];
};

function operationsFromOpenApi(source: string): Map<string, Set<string>> {
  const operations = new Map<string, Set<string>>();
  let currentPath: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const pathMatch = /^  (\/[^:]+):\s*$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1]!;
      operations.set(currentPath, operations.get(currentPath) ?? new Set());
      continue;
    }
    const methodMatch = /^    (get|post|put|patch|delete|head|options):\s*$/.exec(line);
    if (currentPath && methodMatch) operations.get(currentPath)!.add(methodMatch[1]!);
  }
  return operations;
}

test("published API v1 paths and methods are append-only", async () => {
  const baseline = JSON.parse(await readFile("openapi/v1-compatibility-baseline.json", "utf8")) as Baseline;
  const openapi = await readFile("openapi/corvis-v1.yaml", "utf8");
  const operations = operationsFromOpenApi(openapi);

  assert.equal(baseline.version, 1);
  assert.equal(baseline.apiPrefix, "/api/v1");
  assert.match(openapi, new RegExp(`version: ${baseline.openapiVersion.replaceAll(".", "\\.")}`));

  for (const [path, methods] of Object.entries(baseline.publishedOperations)) {
    const actual = operations.get(path);
    assert.ok(actual, `breaking API change: published path ${path} disappeared from v1 OpenAPI`);
    for (const method of methods) {
      assert.ok(actual.has(method), `breaking API change: published operation ${method.toUpperCase()} ${path} disappeared from v1 OpenAPI`);
    }
  }
});

test("stable API conventions remain represented by the v1 contract", async () => {
  const baseline = JSON.parse(await readFile("openapi/v1-compatibility-baseline.json", "utf8")) as Baseline;
  const openapi = await readFile("openapi/corvis-v1.yaml", "utf8");
  for (const convention of baseline.stableConventions) {
    assert.ok(openapi.includes(convention), `stable v1 convention disappeared: ${convention}`);
  }
});

test("deprecation policy requires migration, notice, sunset and security override", async () => {
  const policy = (await readFile("docs/API_DEPRECATION.md", "utf8")).toLowerCase();
  for (const requirement of ["migration instructions", "deprecation notice", "deprecation` and `sunset", "new prefix such as `/api/v2`", "tenant-isolation vulnerability"]) {
    assert.ok(policy.includes(requirement), `deprecation policy missing: ${requirement}`);
  }
  assert.match(policy, /do not edit it to make a breaking change pass/);
  assert.match(policy, /webhook event payloads and export schemas are external contracts too/);
});
