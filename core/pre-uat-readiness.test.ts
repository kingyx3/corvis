import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type AcceptancePlan = {
  version: number;
  environment: string;
  bootstrapDependencies: string[];
  requiredEvidence: string[];
  scenarios: Array<{ id: string; required: boolean; issues: number[]; assertions: string[] }>;
};

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await read(path)) as T;
}

test("pre-UAT acceptance plan covers every production-like failure and recovery class", async () => {
  const plan = await readJson<AcceptancePlan>("ops/uat/acceptance-plan.json");
  assert.equal(plan.version, 1);
  assert.equal(plan.environment, "uat");
  assert.ok(plan.bootstrapDependencies.includes("github-wif-trust"));
  assert.ok(plan.bootstrapDependencies.includes("provider-owned-postgres-tls-dsn"));
  assert.ok(plan.bootstrapDependencies.includes("real-idp-issuer-audience-jwks"));

  const requiredEvidence = new Set(plan.requiredEvidence);
  for (const evidence of [
    "customer-admin-api-worker-control-loop-isolation",
    "postgres-tls-migrations-and-rls",
    "duplicate-delivery-and-crash-idempotency",
    "retry-dead-letter-and-authorized-recovery",
    "correction-replay-and-republication-idempotency",
    "cross-tenant-and-service-identity-negative-tests",
    "known-good-rollback",
  ]) assert.ok(requiredEvidence.has(evidence), `missing required UAT evidence: ${evidence}`);

  const scenarios = new Map(plan.scenarios.map((scenario) => [scenario.id, scenario]));
  for (const id of [
    "success-path",
    "review-block-resume",
    "duplicate-redelivery",
    "worker-crash-after-side-effect",
    "retry-dead-letter-recovery",
    "correction-republication",
    "tenant-isolation",
    "service-identity-negative",
    "rollback",
    "customer-cutover-dry-run",
    "security-assessment-readiness",
  ]) {
    const scenario = scenarios.get(id);
    assert.ok(scenario, `missing required UAT scenario: ${id}`);
    assert.equal(scenario.required, true);
    assert.ok(scenario.assertions.length > 0);
  }
});

test("security assessment pack is safe for a public repo and matches runtime boundaries", async () => {
  const scope = (await read("ops/security-assessment/README.md")).toLowerCase();
  const roe = (await read("ops/security-assessment/rules-of-engagement.md")).toLowerCase();
  const corpus = await readJson<{ classification: string; tenants: unknown[]; constraints: string[] }>("ops/security-assessment/sanitized-test-corpus.json");

  for (const boundary of ["cloudflare", "api gateway", "cloud run", "postgres rls", "pub/sub", "cloud tasks", "control-loop"]) {
    assert.ok(scope.includes(boundary), `assessment scope missing ${boundary}`);
  }
  for (const negative of ["cross-tenant", "direct origin", "unauthorized worker", "rls bypass", "webhook", "export"]) {
    assert.ok(scope.includes(negative), `assessment negative coverage missing ${negative}`);
  }
  assert.ok(roe.includes("synthetic/sanitized test data only"));
  assert.ok(roe.includes("persistent denial of service"));
  assert.ok(roe.includes("full sensitive evidence remains in the access-controlled assessment repository"));
  assert.equal(corpus.classification, "synthetic-public-fixture");
  assert.equal(corpus.tenants.length, 2);
  assert.ok(corpus.constraints.includes("no-real-customer-data"));
  assert.ok(corpus.constraints.includes("no-production-secrets"));
});

test("acceptance contract points at the current implementation owners rather than inventing parallel tracks", async () => {
  const plan = await readJson<AcceptancePlan>("ops/uat/acceptance-plan.json");
  const issueRefs = new Set(plan.scenarios.flatMap((scenario) => scenario.issues));
  for (const issue of [8, 12, 13, 77, 78, 79, 80]) assert.ok(issueRefs.has(issue), `missing owning issue #${issue}`);

  for (const path of [
    ".github/workflows/promote-environment.yml",
    ".github/workflows/security-acceptance.yml",
    ".github/workflows/terraform-deploy.yml",
    ".github/workflows/runtime-secrets.yml",
    "ops/customer-implementation/manifest.schema.json",
  ]) {
    assert.ok((await read(path)).length > 0, `required pre-UAT implementation missing: ${path}`);
  }
});
