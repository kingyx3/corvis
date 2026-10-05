import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCustomerAcceptance, validateCustomerImplementationManifest } from "./customer-implementation.ts";

const manifest = {
  schemaVersion: "1",
  customerKey: "allocator-demo",
  environment: "uat",
  tenantId: "00000000-0000-4000-8000-000000000101",
  workspaceId: "00000000-0000-4000-8000-000000000102",
  release: { commitSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}`, migrationVersion: 22 },
  rights: { fundIds: ["fund-1"], sourceDocumentAccessAllowed: true, redistributionAllowed: true },
  providers: { postgresSecretName: "corvis-postgres-dsn-uat", objectBucket: "corvis-uat-source", sourceConnectionIds: [], deliveryWebhookIds: [] },
  cutover: { rollbackImageDigest: `sha256:${"c".repeat(64)}`, owner: "customer-ops", changeReference: "UAT-001" },
};

test("a sanitized versioned customer manifest passes deterministic validation", () => {
  const result = validateCustomerImplementationManifest(manifest);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("customer manifests reject inline credentials instead of becoming a secret store", () => {
  const result = validateCustomerImplementationManifest({ ...manifest, providers: { ...manifest.providers, accessToken: "do-not-store-this" } });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /secret material/);
});

test("acceptance stays blocked until every cutover dependency has objective evidence", () => {
  const scorecard = evaluateCustomerAcceptance({
    releaseGovernancePassed: true,
    migrationsCurrent: true,
    runtimeSecretsReady: true,
    sourceConnectivity: true,
    deliveryConnectivity: false,
    tenantIsolationVerified: true,
    lineageComplete: true,
    backfillReconciled: true,
    rollbackVerified: true,
    unresolvedExceptions: 0,
    undocumentedManualInterventions: 0,
  });
  assert.equal(scorecard.status, "blocked");
  assert.equal(scorecard.checks.find((check) => check.key === "delivery_connectivity")?.passed, false);
});

test("acceptance becomes ready only with a clean evidence set", () => {
  const scorecard = evaluateCustomerAcceptance({
    releaseGovernancePassed: true,
    migrationsCurrent: true,
    runtimeSecretsReady: true,
    sourceConnectivity: true,
    deliveryConnectivity: true,
    tenantIsolationVerified: true,
    lineageComplete: true,
    backfillReconciled: true,
    rollbackVerified: true,
    unresolvedExceptions: 0,
    undocumentedManualInterventions: 0,
  });
  assert.equal(scorecard.status, "ready");
  assert.equal(scorecard.checks.every((check) => check.passed), true);
});
