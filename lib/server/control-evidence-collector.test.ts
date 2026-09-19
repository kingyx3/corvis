import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlEvidenceCollectionError,
  collectSecurityAcceptanceEvidence,
  computePayloadDigest,
  parseSecurityAcceptanceEvidence,
  securityAcceptanceResult,
  type SecurityAcceptanceEdgeEvidence,
  type SecurityAcceptancePostgresRlsEvidence,
} from "./control-evidence-collector.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };

class FakeDb implements PostgresSqlApi {
  calls: Call[] = [];
  priorRows: PostgresRow[];
  promotionRows: PostgresRow[];
  failOn?: (sql: string) => boolean;

  constructor(priorRows: PostgresRow[] = [], promotionRows: PostgresRow[] = [{ new_version: 2 }], failOn?: (sql: string) => boolean) {
    this.priorRows = priorRows;
    this.promotionRows = promotionRows;
    this.failOn = failOn;
  }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (this.failOn?.(sql)) throw new Error("simulated database failure");
    if (sql.includes("promote_control_implementation")) return this.promotionRows;
    if (sql.includes("from corvis_control.control_evidence_record")) return this.priorRows;
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.calls.push({ sql, parameters });
    if (this.failOn?.(sql)) throw new Error("simulated database failure");
  }

  async health(): Promise<boolean> {
    return true;
  }
}

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

function postgresRlsEvidence(overrides: Partial<SecurityAcceptancePostgresRlsEvidence> = {}): SecurityAcceptancePostgresRlsEvidence {
  return {
    schemaVersion: "corvis.postgres-rls-security-acceptance.v1",
    environment: "uat",
    checkedAt: "2026-09-19T00:00:00Z",
    result: "pass",
    source: "github-actions",
    checks: ["two-tenant-workspace-read-isolation"],
    ...overrides,
  };
}

function edgeEvidence(overrides: Partial<SecurityAcceptanceEdgeEvidence> = {}): SecurityAcceptanceEdgeEvidence {
  return {
    schemaVersion: "corvis.security-acceptance.v1",
    environment: "uat",
    checkedAt: "2026-09-19T00:00:00Z",
    source: "github-actions",
    checks: [{ name: "customer-hostname-tls", status: "pass", startedAt: "2026-09-19T00:00:00Z" }],
    summary: { passed: 1, failed: 0 },
    ...overrides,
  };
}

test("parseSecurityAcceptanceEvidence accepts both known schemas and rejects everything else", () => {
  assert.equal(parseSecurityAcceptanceEvidence(postgresRlsEvidence()).schemaVersion, "corvis.postgres-rls-security-acceptance.v1");
  assert.equal(parseSecurityAcceptanceEvidence(edgeEvidence()).schemaVersion, "corvis.security-acceptance.v1");

  assert.throws(() => parseSecurityAcceptanceEvidence(null), ControlEvidenceCollectionError);
  assert.throws(() => parseSecurityAcceptanceEvidence({ schemaVersion: "unknown" }), ControlEvidenceCollectionError);
  assert.throws(() => parseSecurityAcceptanceEvidence({ ...postgresRlsEvidence(), checkedAt: undefined }), ControlEvidenceCollectionError);
  assert.throws(() => parseSecurityAcceptanceEvidence({ ...postgresRlsEvidence(), result: "unknown" }), ControlEvidenceCollectionError);
  assert.throws(() => parseSecurityAcceptanceEvidence({ ...edgeEvidence(), summary: {} }), ControlEvidenceCollectionError);
});

test("securityAcceptanceResult uses individual checks rather than trusting a summary", () => {
  assert.equal(securityAcceptanceResult(postgresRlsEvidence({ result: "pass" })), "pass");
  assert.equal(securityAcceptanceResult(postgresRlsEvidence({ result: "fail" })), "fail");
  assert.equal(securityAcceptanceResult(edgeEvidence({ summary: { passed: 2, failed: 0 } })), "pass");
  assert.equal(securityAcceptanceResult(edgeEvidence({ checks: [{ name: "tls", status: "fail" }], summary: { passed: 0, failed: 1 } })), "fail");
});

test("computePayloadDigest is a deterministic hex sha256 that chains off the previous digest", () => {
  const evidence = postgresRlsEvidence();
  const first = computePayloadDigest(evidence, null);
  const same = computePayloadDigest(evidence, null);
  const chained = computePayloadDigest(evidence, first);

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same, "identical payload and previous digest must produce the same digest");
  assert.notEqual(chained, first, "chaining a different previous digest must change the resulting digest");

  const differentPayload = computePayloadDigest(postgresRlsEvidence({ checkedAt: "2026-09-20T00:00:00Z" }), null);
  assert.notEqual(differentPayload, first, "a changed payload must change the digest");

  // Key order in the source object must not matter: canonicalization sorts keys.
  const reordered = { ...evidence } as Record<string, unknown>;
  const reorderedKeys = Object.keys(reordered).reverse();
  const reorderedEvidence = reorderedKeys.reduce<Record<string, unknown>>((accumulator, key) => {
    accumulator[key] = reordered[key];
    return accumulator;
  }, {});
  assert.equal(computePayloadDigest(reorderedEvidence as unknown as SecurityAcceptancePostgresRlsEvidence, null), first);
});

test("records a first, passing postgres-rls evidence record as revision 1 and promotes the control", async () => {
  const db = new FakeDb([], [{ new_version: 2 }]);
  const outcome = await collectSecurityAcceptanceEvidence(
    { tenantId: TENANT_ID, evidence: postgresRlsEvidence(), collectedBy: "ci:security-acceptance", sourceRunUri: "https://example.test/run/1" },
    db,
  );

  assert.equal(outcome.controlCode, "ISO-TENANT-RLS");
  assert.equal(outcome.sourceKey, "security-acceptance.postgres-rls");
  assert.equal(outcome.revision, 1);
  assert.equal(outcome.result, "pass");
  assert.equal(outcome.previousDigest, null);
  assert.match(outcome.payloadDigest, /^[0-9a-f]{64}$/);
  assert.equal(outcome.collectedAt, "2026-09-19T00:00:00.000Z");
  assert.equal(outcome.validThrough, "2026-10-19T00:00:00.000Z", "postgres-rls cadence is 30 days");
  assert.equal(outcome.promotedVersion, 2);

  const insertCall = db.calls.find((call) => call.sql.includes("insert into corvis_control.control_evidence_record"));
  assert.ok(insertCall, "must insert an append-only evidence record");
  assert.deepEqual(insertCall?.parameters, [
    TENANT_ID,
    outcome.evidenceRecordId,
    "ISO-TENANT-RLS",
    "security-acceptance.postgres-rls",
    1,
    "pass",
    "2026-09-19T00:00:00.000Z",
    "2026-10-19T00:00:00.000Z",
    "ci:security-acceptance",
    "https://example.test/run/1",
    outcome.payloadDigest,
    null,
    null,
  ]);

  const promotionCall = db.calls.find((call) => call.sql.includes("promote_control_implementation"));
  assert.ok(promotionCall, "a passing record must attempt promotion");
  assert.deepEqual(promotionCall?.parameters.slice(0, 3), [TENANT_ID, "ISO-TENANT-RLS", "ci:security-acceptance"]);
});

test("chains a second revision off the first revision's digest instead of starting a new chain", async () => {
  const priorDigest = "a".repeat(64);
  const db = new FakeDb([{ revision: 1, payload_digest: priorDigest }]);
  const evidence = postgresRlsEvidence();
  const outcome = await collectSecurityAcceptanceEvidence({ tenantId: TENANT_ID, evidence, collectedBy: "ci:security-acceptance" }, db);

  assert.equal(outcome.revision, 2);
  assert.equal(outcome.previousDigest, priorDigest);
  assert.equal(outcome.payloadDigest, computePayloadDigest(evidence, priorDigest));
  assert.notEqual(outcome.payloadDigest, computePayloadDigest(evidence, null), "must not silently drop the chain");
});

test("a failing evidence file is still recorded but never attempts to promote the control", async () => {
  const db = new FakeDb();
  const outcome = await collectSecurityAcceptanceEvidence(
    { tenantId: TENANT_ID, evidence: edgeEvidence({ checks: [{ name: "tls", status: "fail" }], summary: { passed: 0, failed: 1 } }), collectedBy: "ci:security-acceptance" },
    db,
  );

  assert.equal(outcome.controlCode, "ISO-EDGE");
  assert.equal(outcome.result, "fail");
  assert.equal(outcome.promotedVersion, null);

  const insertCall = db.calls.find((call) => call.sql.includes("insert into corvis_control.control_evidence_record"));
  assert.equal(insertCall?.parameters[5], "fail");

  const promotionCall = db.calls.find((call) => call.sql.includes("promote_control_implementation"));
  assert.equal(promotionCall, undefined, "a failing record must never attempt promotion");
});

test("surfaces a promotion-call failure instead of swallowing it", async () => {
  const db = new FakeDb([], [], (sql) => sql.includes("promote_control_implementation"));
  await assert.rejects(
    () => collectSecurityAcceptanceEvidence({ tenantId: TENANT_ID, evidence: postgresRlsEvidence(), collectedBy: "ci:security-acceptance" }, db),
    /simulated database failure/,
  );

  const insertCall = db.calls.find((call) => call.sql.includes("insert into corvis_control.control_evidence_record"));
  assert.ok(insertCall, "the evidence record itself must still have been recorded before the promotion attempt failed");
});

test("surfaces an insert failure instead of swallowing it", async () => {
  const db = new FakeDb([], [], (sql) => sql.includes("insert into corvis_control.control_evidence_record"));
  await assert.rejects(
    () => collectSecurityAcceptanceEvidence({ tenantId: TENANT_ID, evidence: postgresRlsEvidence(), collectedBy: "ci:security-acceptance" }, db),
    /simulated database failure/,
  );
});

test("requires a tenant id and a collector identity", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => collectSecurityAcceptanceEvidence({ tenantId: "", evidence: postgresRlsEvidence(), collectedBy: "ci:security-acceptance" }, db),
    ControlEvidenceCollectionError,
  );
  await assert.rejects(
    () => collectSecurityAcceptanceEvidence({ tenantId: TENANT_ID, evidence: postgresRlsEvidence(), collectedBy: "" }, db),
    ControlEvidenceCollectionError,
  );
});

const edgeNames = ["customer-edge-https", "admin-edge-https", "api-https-and-cache-isolation",
  "http-redirects-to-https", "csrf-cors-cross-site-block", "cloudflare-waf-probe",
  "cloudflare-rate-limit-probe", "direct-load-balancer-origin-mtls-blocked",
  "direct-cloud-run-origin-bypass-blocked"];
function v3Evidence(): SecurityAcceptanceEdgeEvidence {
  return edgeEvidence({ schemaVersion: "corvis.security-acceptance.v3",
    checks: edgeNames.map((name) => ({ name, status: "pass" })),
    summary: { passed: 9, failed: 0, skipped: 0 } });
}

test("current v3 producer schema is accepted and skipped runtime checks block promotion", async () => {
  const evidence = v3Evidence();
  assert.equal(securityAcceptanceResult(parseSecurityAcceptanceEvidence(evidence)), "pass");
  const skipped = { ...evidence, checks: evidence.checks.map((check, index) => index === 0 ? { ...check, status: "skip" as const } : check),
    summary: { passed: 8, failed: 0, skipped: 1 } };
  const db = new FakeDb();
  const result = await collectSecurityAcceptanceEvidence({ tenantId: TENANT_ID, evidence: skipped, collectedBy: "ci" }, db);
  assert.equal(result.result, "fail");
  assert.equal(result.promotedVersion, null);
  assert.ok(!db.calls.some((call) => call.sql.includes("promote_control_implementation")));
});

test("empty, incomplete, duplicate and contradictory evidence cannot pass validation", () => {
  const evidence = v3Evidence();
  for (const invalid of [
    { ...evidence, checks: [] },
    { ...evidence, checks: evidence.checks.slice(1), summary: { passed: 8, failed: 0 } },
    { ...evidence, checks: [...evidence.checks, evidence.checks[0]] },
    { ...evidence, summary: { passed: 9, failed: -1 } },
    { ...evidence, checkedAt: "invalid" },
    { ...evidence, source: "unattributed" },
    { ...postgresRlsEvidence(), checks: [""] },
  ]) assert.throws(() => parseSecurityAcceptanceEvidence(invalid), ControlEvidenceCollectionError);
});
