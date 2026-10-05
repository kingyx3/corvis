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

type PerformanceBudgets = {
  version: number;
  environment: string;
  api: { readP95Ms: number; writeP95Ms: number; errorRatePercentMax: number };
  web: { initialPageInteractiveP95Ms: number; routeTransitionP95Ms: number; adminRefreshP95Ms: number };
  processing: { uploadToRegisteredP95Seconds: number; registeredToReviewReadyP95Minutes: number; approvedToPublishedP95Minutes: number };
  load: { concurrentInteractiveUsers: number; concurrentDocumentJourneys: number; largeDocumentPages: number; sustainedMinutes: number };
  failureConditions: string[];
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
    "production-no-demo-or-mock-fallback",
    "performance-and-load-budgets",
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
    "no-production-mocks",
    "performance-load",
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

test("production-like performance budgets are explicit and fail closed", async () => {
  const budgets = await readJson<PerformanceBudgets>("ops/uat/performance-budgets.json");
  assert.equal(budgets.version, 1);
  assert.equal(budgets.environment, "uat");
  assert.ok(budgets.api.readP95Ms > 0 && budgets.api.readP95Ms <= 1000);
  assert.ok(budgets.api.writeP95Ms >= budgets.api.readP95Ms);
  assert.ok(budgets.api.errorRatePercentMax > 0 && budgets.api.errorRatePercentMax <= 1);
  assert.ok(budgets.web.initialPageInteractiveP95Ms <= 3000);
  assert.ok(budgets.processing.registeredToReviewReadyP95Minutes <= 10);
  assert.ok(budgets.load.concurrentInteractiveUsers >= 50);
  assert.ok(budgets.load.concurrentDocumentJourneys >= 20);
  assert.ok(budgets.load.largeDocumentPages >= 500);
  for (const condition of ["authorization-or-rls-bypass", "duplicate-logical-business-effect", "unbounded-queue-growth"]) {
    assert.ok(budgets.failureConditions.includes(condition), `missing load-test failure condition: ${condition}`);
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
  for (const issue of [8, 9, 12, 13, 77, 78, 79, 80]) assert.ok(issueRefs.has(issue), `missing owning issue #${issue}`);

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
