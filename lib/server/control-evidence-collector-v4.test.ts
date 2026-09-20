import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlEvidenceCollectionError,
  parseSecurityAcceptanceEvidence,
  securityAcceptanceResult,
  type SecurityAcceptanceEdgeEvidence,
} from "./control-evidence-collector.ts";

const requiredV4 = [
  "customer-edge-https",
  "admin-edge-https",
  "api-https-worker-and-cache-isolation",
  "http-redirects-to-https",
  "csrf-cors-cross-site-block",
  "cloudflare-waf-probe",
  "cloudflare-rate-limit-probe",
  "direct-api-gateway-missing-edge-key-blocked",
  "direct-api-gateway-invalid-edge-key-blocked",
  "direct-cloud-run-origin-bypass-blocked",
  "cloud-run-invoker-policy-is-gateway-only",
] as const;

function evidence(): SecurityAcceptanceEdgeEvidence {
  return {
    schemaVersion: "corvis.security-acceptance.v4",
    environment: "uat",
    checkedAt: "2026-09-20T00:00:00Z",
    source: "github-actions",
    checks: requiredV4.map((name) => ({ name, status: "pass" as const })),
    summary: { passed: requiredV4.length, failed: 0, skipped: 0 },
  };
}

test("gateway security-acceptance v4 evidence is accepted", () => {
  const parsed = parseSecurityAcceptanceEvidence(evidence());
  assert.equal(parsed.schemaVersion, "corvis.security-acceptance.v4");
  assert.equal(securityAcceptanceResult(parsed), "pass");
});

test("gateway security-acceptance v4 rejects missing required checks", () => {
  const current = evidence();
  assert.throws(
    () => parseSecurityAcceptanceEvidence({
      ...current,
      checks: current.checks.slice(1),
      summary: { passed: current.checks.length - 1, failed: 0, skipped: 0 },
    }),
    ControlEvidenceCollectionError,
  );
});

test("gateway security-acceptance v4 skips remain non-promotable", () => {
  const current = evidence();
  const skipped = parseSecurityAcceptanceEvidence({
    ...current,
    checks: current.checks.map((check, index) => index === 0 ? { ...check, status: "skip" } : check),
    summary: { passed: current.checks.length - 1, failed: 0, skipped: 1 },
  });
  assert.equal(securityAcceptanceResult(skipped), "fail");
});
