import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { generateControlEvidence, getSourceReference, listControlEvidence } from "./operations.ts";
import { PostgresOperationsRepository, PostgresWorkspaceRepository } from "./platform-repositories.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { PermissionedResearchService } from "./research.ts";

type Call = { kind: "query" | "execute"; sql: string; parameters: PostgresPrimitive[] };

const tenantA = "00000000-0000-0000-0000-000000000010";
const tenantB = "00000000-0000-0000-0000-000000000011";
const workspaceA = "00000000-0000-0000-0000-000000000020";
const workspaceB = "00000000-0000-0000-0000-000000000021";
const observationA = "00000000-0000-0000-0000-000000000101";
const observationB = "00000000-0000-0000-0000-000000000102";
const sourceA = "00000000-0000-0000-0000-000000000201";
const sourceB = "00000000-0000-0000-0000-000000000202";
const documentA = "00000000-0000-0000-0000-000000000301";
const documentB = "00000000-0000-0000-0000-000000000302";
const snapshotA = "00000000-0000-0000-0000-000000000401";
const snapshotB = "00000000-0000-0000-0000-000000000402";

function identity(tenantId: string): RequestIdentity {
  const isA = tenantId === tenantA;
  const documentId = isA ? documentA : documentB;
  return {
    subject: isA ? "oidc|tenant-a-user" : "oidc|tenant-b-user",
    tenantId,
    workspaceId: isA ? workspaceA : workspaceB,
    roles: ["analyst"],
    entitlements: {
      workspaceIds: [isA ? workspaceA : workspaceB],
      documentIds: [documentId],
      sourceDocumentIds: [documentId],
      fundIds: [isA ? "fund-a" : "fund-b"],
      sourceDocumentAccessAllowed: true,
      redistributionAllowed: true,
    },
    authMethod: "oidc",
    sessionId: isA ? "session-a" : "session-b",
  };
}

class TenantAwareDb implements PostgresSqlApi {
  calls: Call[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ kind: "query", sql, parameters });
    const tenantId = String(parameters[0] ?? "");
    const isA = tenantId === tenantA;

    if (sql.includes("corvis_serving.documents")) {
      return [{ tenant_id: tenantId, document_id: isA ? documentA : documentB, display_name: isA ? "Tenant A report" : "Tenant B report" }];
    }
    if (sql.includes("corvis_serving.fund_period_snapshots")) {
      return [{ tenant_id: tenantId, snapshot_id: isA ? snapshotA : snapshotB, schema_version: "v1", taxonomy_version: isA ? "tenant-a-taxonomy" : "tenant-b-taxonomy" }];
    }
    if (sql.includes("select count(*) as row_count") && sql.includes("corvis_serving.observations")) {
      return [{ row_count: isA ? 3 : 7 }];
    }
    if (sql.includes("from corvis_control.control_evidence")) {
      return [{ tenant_id: tenantId, evidence_id: isA ? "evidence-a" : "evidence-b" }];
    }
    if (sql.includes("from corvis_serving.source_references")) {
      return [{ tenant_id: tenantId, source_reference_id: isA ? sourceA : sourceB, document_id: isA ? documentA : documentB }];
    }
    if (sql.includes("from corvis_serving.observations") && sql.includes("review_state='approved'")) {
      return [{
        tenant_id: tenantId,
        observation_id: isA ? observationA : observationB,
        fund_id: isA ? "fund-a" : "fund-b",
        metric_code: "revenue",
        value_number: isA ? 100 : 200,
        source_reference_id: isA ? sourceA : sourceB,
        version: 1,
      }];
    }
    if (sql.includes("from corvis_control.feature_flag where")) {
      return [{ flag_key: "retrieval.hybrid_search", enabled: true, kill_switch: false, configuration: {} }];
    }
    if (sql.includes("feature_flag_emergency_stop")) return [];
    if (sql.includes("select\n    (select count(*) from corvis_control.audit_event")) {
      return [{ audit_events: isA ? 5 : 9, failed_jobs: 0, completed_deletions: 1, published_snapshots: 1 }];
    }
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.calls.push({ kind: "execute", sql, parameters });
  }

  async health(): Promise<boolean> { return true; }
}

function assertCallsStayInTenant(calls: Call[], tenantId: string) {
  assert.ok(calls.length > 0, "expected database calls");
  for (const call of calls) {
    if (/corvis_(control|serving|facts|source|consolidated)/.test(call.sql)) {
      assert.equal(call.parameters[0], tenantId, `query must bind ${tenantId} as its first tenant parameter: ${call.sql}`);
    }
  }
}

test("workspace and export repositories isolate two tenants", async () => {
  const db = new TenantAwareDb();
  const workspace = new PostgresWorkspaceRepository(db);
  const operations = new PostgresOperationsRepository(db);

  const aStart = db.calls.length;
  const aDocs = await workspace.listDocuments(identity(tenantA));
  const aExport = await operations.exportManifest(identity(tenantA));
  const aCalls = db.calls.slice(aStart);

  const bStart = db.calls.length;
  const bDocs = await workspace.listDocuments(identity(tenantB));
  const bExport = await operations.exportManifest(identity(tenantB));
  const bCalls = db.calls.slice(bStart);

  assert.equal(aDocs[0]?.document_id, documentA);
  assert.equal(bDocs[0]?.document_id, documentB);
  assert.deepEqual(aExport.snapshots.map((row) => row.snapshot_id), [snapshotA]);
  assert.deepEqual(bExport.snapshots.map((row) => row.snapshot_id), [snapshotB]);
  assert.equal(aExport.observationCount, 3);
  assert.equal(bExport.observationCount, 7);
  assertCallsStayInTenant(aCalls, tenantA);
  assertCallsStayInTenant(bCalls, tenantB);
});

test("export enqueue writes and outbox events cannot cross tenants", async () => {
  const db = new TenantAwareDb();
  const operations = new PostgresOperationsRepository(db);

  const makeManifest = (tenantId: string, snapshotId: string) => ({
    exportId: tenantId === tenantA ? "00000000-0000-0000-0000-000000000501" : "00000000-0000-0000-0000-000000000502",
    tenantId,
    generatedAt: "2026-09-19T00:00:00.000Z",
    schemaVersion: "v1",
    taxonomyVersion: "v1",
    snapshotIds: [snapshotId],
    format: "csv" as const,
    rowCounts: { observations: 1, snapshots: 1 },
    checksumSha256: "abc123",
  });

  await operations.enqueueExport(identity(tenantA), makeManifest(tenantA, snapshotA));
  const aCalls = db.calls.splice(0);
  await operations.enqueueExport(identity(tenantB), makeManifest(tenantB, snapshotB));
  const bCalls = db.calls.splice(0);

  assert.equal(aCalls.length, 2);
  assert.equal(bCalls.length, 2);
  assertCallsStayInTenant(aCalls, tenantA);
  assertCallsStayInTenant(bCalls, tenantB);
  assert.match(aCalls[0]?.sql ?? "", /corvis_serving\.export_job/);
  assert.match(aCalls[1]?.sql ?? "", /corvis_control\.outbox_event/);
});

test("control evidence and source evidence stay tenant-scoped", async () => {
  const db = new TenantAwareDb();

  const aEvidence = await listControlEvidence(identity(tenantA), db);
  const aSource = await getSourceReference(identity(tenantA), sourceA, db);
  const aCalls = db.calls.splice(0);
  const bEvidence = await listControlEvidence(identity(tenantB), db);
  const bSource = await getSourceReference(identity(tenantB), sourceB, db);
  const bCalls = db.calls.splice(0);

  assert.equal(aEvidence[0]?.evidence_id, "evidence-a");
  assert.equal(bEvidence[0]?.evidence_id, "evidence-b");
  assert.equal(aSource?.document_id, documentA);
  assert.equal(bSource?.document_id, documentB);
  assertCallsStayInTenant(aCalls, tenantA);
  assertCallsStayInTenant(bCalls, tenantB);
});

test("generated control evidence counts and writes only the caller tenant", async () => {
  const db = new TenantAwareDb();
  const readiness = async () => ({ identity: "configured", postgres: "configured" } as const);

  const aResult = await generateControlEvidence(identity(tenantA), { db, readiness });
  const aCalls = db.calls.splice(0);
  const bResult = await generateControlEvidence(identity(tenantB), { db, readiness });
  const bCalls = db.calls.splice(0);

  assert.equal(aResult.result, "pass");
  assert.equal(bResult.result, "pass");
  assert.equal(aResult.payload.counts.audit_events, 5);
  assert.equal(bResult.payload.counts.audit_events, 9);
  assertCallsStayInTenant(aCalls, tenantA);
  assertCallsStayInTenant(bCalls, tenantB);
  assert.match(aCalls.at(-1)?.sql ?? "", /insert into corvis_control\.control_evidence/);
  assert.match(bCalls.at(-1)?.sql ?? "", /insert into corvis_control\.control_evidence/);
});

test("research keeps semantic facts, retrieval filters and AI context isolated by tenant", { concurrency: false }, async () => {
  const db = new TenantAwareDb();
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalSearch = process.env.CORVIS_SEARCH_ENDPOINT;
  const originalFetch = globalThis.fetch;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_SEARCH_ENDPOINT = "https://search.example.test";

  const searchFilters: Array<Record<string, unknown>> = [];
  const aiPayloads: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/search")) {
      const filters = body.filters as Record<string, unknown>;
      searchFilters.push(filters);
      const isA = filters.tenantId === tenantA;
      return new Response(JSON.stringify({ hits: [{
        sourceReferenceId: isA ? sourceA : sourceB,
        documentId: isA ? documentA : documentB,
        text: isA ? "Tenant A evidence" : "Tenant B evidence",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/answer")) {
      aiPayloads.push(body);
      return new Response(JSON.stringify({ answer: "Scoped answer" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    const service = new PermissionedResearchService(db);
    await service.answer(identity(tenantA), "What was revenue?");
    const aCalls = db.calls.splice(0);
    await service.answer(identity(tenantB), "What was revenue?");
    const bCalls = db.calls.splice(0);

    assertCallsStayInTenant(aCalls, tenantA);
    assertCallsStayInTenant(bCalls, tenantB);
    assert.deepEqual(searchFilters.map((filters) => filters.tenantId), [tenantA, tenantB]);
    assert.deepEqual(searchFilters.map((filters) => filters.workspaceId), [workspaceA, workspaceB]);
    assert.deepEqual(searchFilters.map((filters) => filters.documentIds), [[documentA], [documentB]]);
    assert.deepEqual(searchFilters.map((filters) => filters.fundIds), [["fund-a"], ["fund-b"]]);

    const aSemantic = aiPayloads[0]?.semanticQuery as { rows?: Array<Record<string, unknown>> };
    const bSemantic = aiPayloads[1]?.semanticQuery as { rows?: Array<Record<string, unknown>> };
    const aRetrieval = aiPayloads[0]?.retrieval as Array<Record<string, unknown>>;
    const bRetrieval = aiPayloads[1]?.retrieval as Array<Record<string, unknown>>;
    assert.deepEqual(aSemantic.rows?.map((row) => row.observation_id), [observationA]);
    assert.deepEqual(bSemantic.rows?.map((row) => row.observation_id), [observationB]);
    assert.deepEqual(aRetrieval.map((row) => row.documentId), [documentA]);
    assert.deepEqual(bRetrieval.map((row) => row.documentId), [documentB]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAi === undefined) delete process.env.CORVIS_AI_ENDPOINT;
    else process.env.CORVIS_AI_ENDPOINT = originalAi;
    if (originalSearch === undefined) delete process.env.CORVIS_SEARCH_ENDPOINT;
    else process.env.CORVIS_SEARCH_ENDPOINT = originalSearch;
  }
});
