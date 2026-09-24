import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is
// needed: route modules use the Next.js "@/..." path alias.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

// A non-demo, non-production identity (the trusted-gateway compatibility
// path), because only that path carries a document entitlement allowlist.
process.env.CORVIS_DEMO_MODE = "false";
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";
process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = "route-test-secret";

const TENANT = "66666666-6666-4666-8666-666666666666";
const DOCUMENT = "22222222-2222-4222-8222-222222222222";
const OTHER_DOCUMENT = "22222222-2222-4222-8222-000000000000";
const RUN = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "55555555-5555-4555-8555-555555555555";

// ---- Minimal fake Postgres HTTP backend for the candidate review tables ----
type Row = Record<string, unknown>;
const requirements = new Map<string, Row>();
const events = new Map<string, Row>();
const sqlLog: string[] = [];

function handleSql(sql: string, parameters: unknown[]): Row[] {
  sqlLog.push(sql);
  if (sql.includes("from corvis_source.extraction_run")) {
    if (parameters[1] !== DOCUMENT || parameters[2] !== RUN) return [];
    return [{
      extraction_run_id: RUN, document_id: DOCUMENT, document_artifact_version_id: "33333333-3333-4333-8333-333333333333",
      representation_id: "44444444-4444-4444-8444-444444444444", candidate_count: 1, candidate_set_sha256: "a".repeat(64),
      schema_version: "1.2", skill_id: "skill", skill_version: "1", status: "ready",
    }];
  }
  if (sql.includes("from corvis_source.extraction_candidate")) {
    return [{
      candidate_id: CANDIDATE, candidate_key: "metric:revenue", candidate_type: "metric_observation",
      payload: { metricCode: "revenue" }, confidence: { value: 0.9 }, provenance: { extractionRunId: RUN },
      exception_codes: [], source_reference_count: 1,
    }];
  }
  if (sql.includes("insert into corvis_review.candidate_review_requirement")) {
    if (!requirements.has(String(parameters[2]))) {
      requirements.set(String(parameters[2]), {
        candidate_fingerprint_sha256: parameters[4], risk_tier: parameters[5], required_approvals: parameters[6],
        requires_exception_resolution: parameters[7], blocking_reasons: parameters[8],
      });
    }
    return [];
  }
  if (sql.includes("from corvis_review.candidate_review_requirement")) {
    const row = requirements.get(String(parameters[2]));
    return row ? [row] : [];
  }
  if (sql.includes("insert into corvis_review.candidate_review_event")) {
    const id = String(parameters[1]);
    if (!events.has(id)) {
      events.set(id, {
        review_event_id: id, event_sequence: events.size + 1, extraction_run_id: parameters[2], candidate_id: parameters[3],
        review_policy_version: parameters[4], actor_subject: parameters[5], decision: parameters[6], reason_code: parameters[7],
        correction_payload: parameters[8], resolved_exception_codes: parameters[9],
      });
    }
    return [];
  }
  if (sql.includes("from corvis_review.candidate_review_event") && sql.includes("review_event_id=$2")) {
    const row = events.get(String(parameters[1]));
    return row ? [row] : [];
  }
  if (sql.includes("from corvis_review.candidate_review_event")) return [...events.values()];
  if (sql.includes("resume_blocked_reviewed_stage")) return [{ resumed: true }];
  return [];
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql, parameters } = JSON.parse(String(init?.body ?? "{}")) as { sql: string; parameters: unknown[] };
  return new Response(JSON.stringify({ rows: handleSql(sql, parameters ?? []) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { POST } = await import("@/app/api/v1/extraction-review/route");

function request(body: unknown, options: { subject?: string; documents?: string; key?: string } = {}): Request {
  return new Request("https://corvis.test/api/v1/extraction-review", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.key ?? "key-1",
      "x-corvis-gateway-secret": "route-test-secret",
      "x-corvis-auth-subject": options.subject ?? "reviewer-1",
      "x-corvis-auth-tenant": TENANT,
      "x-corvis-auth-workspace": "77777777-7777-4777-8777-777777777777",
      "x-corvis-auth-roles": "reviewer",
      "x-corvis-entitled-documents": options.documents ?? DOCUMENT,
    },
    body: JSON.stringify(body),
  });
}

function command(overrides: Record<string, unknown> = {}) {
  return { documentId: DOCUMENT, extractionRunId: RUN, candidateId: CANDIDATE, decision: "approve", reasonCode: "SOURCE_VERIFIED", ...overrides };
}

test("POST /extraction-review denies a reviewer who is not entitled to the document before touching review state", async () => {
  const before = sqlLog.length;
  const response = await POST(request(command(), { documents: OTHER_DOCUMENT }));
  assert.equal(response.status, 403);
  assert.equal(sqlLog.slice(before).some((sql) => sql.includes("candidate_review_event")), false);
});

test("POST /extraction-review answers 400 for malformed ids, non-string fields and null/array bodies", async () => {
  const bodies: unknown[] = [
    null,
    [],
    command({ documentId: "not-a-uuid" }),
    command({ extractionRunId: "run-1" }),
    command({ candidateId: 7 }),
    command({ reasonCode: { code: "x" } }),
    command({ decision: "resolve_exception", resolvedExceptionCodes: [1] }),
    command({ decision: "approve", resolvedExceptionCodes: ["x"] }),
    command({ decision: "approve", correctionPayload: { valueNumeric: "1" } }),
  ];
  for (const body of bodies) {
    const response = await POST(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("POST /extraction-review maps an unknown candidate to 404 instead of an internal error", async () => {
  const response = await POST(request(command({ candidateId: "99999999-9999-4999-8999-999999999999" })));
  assert.equal(response.status, 404);
  assert.equal((await response.json() as { error: string }).error, "candidate_not_found");
});

test("POST /extraction-review records distinct events for two reviewers who send the same idempotency key", async () => {
  events.clear();
  const first = await POST(request(command(), { subject: "reviewer-a", key: "shared-key" }));
  assert.equal(first.status, 202);
  const second = await POST(request(command(), { subject: "reviewer-b", key: "shared-key" }));
  assert.equal(second.status, 202, "a second reviewer must not collide with the first reviewer's event");
  assert.equal(events.size, 2);
  const retry = await POST(request(command(), { subject: "reviewer-a", key: "shared-key" }));
  assert.equal(retry.status, 202);
  assert.equal(events.size, 2, "the same reviewer's retry stays idempotent");
});
