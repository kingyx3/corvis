import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { PermissionedResearchService } from "./research.ts";

type Call = { kind: "query" | "execute"; sql: string; parameters: PostgresPrimitive[] };

class FakeDb implements PostgresSqlApi {
  calls: Call[] = [];
  candidates: PostgresRow[] = [{
    metric_code: "revenue",
    display_name: "Revenue",
    data_type: "number",
    aggregation_behavior: "additive sum",
    numeric_available: true,
  }];
  factRows: PostgresRow[] = [{
    observation_id: "00000000-0000-0000-0000-000000000001",
    fund_id: "fund-a",
    company_id: "company-a",
    holding_id: "holding-a",
    instrument_id: "instrument-a",
    metric_code: "revenue",
    value_number: 100,
    currency: "USD",
    economic_period: "Q2 2025",
    report_date: "2025-06-30",
    source_reference_id: "00000000-0000-0000-0000-000000000002",
    version: 1,
  }];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ kind: "query", sql, parameters });
    if (sql.includes("bool_or(o.value_number is not null)")) return this.candidates;
    if (sql.includes("with scoped as")) return this.factRows;
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.calls.push({ kind: "execute", sql, parameters });
  }

  async health(): Promise<boolean> { return true; }
}

const identity: RequestIdentity = {
  subject: "oidc|user-123",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["analyst"],
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-b", "fund-a"],
    documentIds: ["00000000-0000-0000-0000-000000000101", "00000000-0000-0000-0000-000000000102"],
    sourceDocumentAccessAllowed: false,
  },
  authMethod: "oidc",
  sessionId: "session-1",
};

test("research sends only the deterministic semantic result to the AI service and persists its query shape", async () => {
  const db = new FakeDb();
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  const originalFetch = globalThis.fetch;
  let aiBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://ai.example.test/answer");
    aiBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({
      answer: "Revenue was 100.",
      usedFactIds: ["00000000-0000-0000-0000-000000000001"],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await new PermissionedResearchService(db).answer(identity, "What was fund-a revenue in Q2 2025?");
    assert.equal(result.answer, "Revenue was 100.");
    assert.equal(result.citations.length, 0);
    assert.equal(result.semanticQueryIds.length, 1);
    assert.equal(result.computedResults?.[0]?.status, "executed");
    assert.equal(result.computedResults?.[0]?.metricCode, "revenue");
    assert.equal(result.computedResults?.[0]?.rows[0]?.value_number, 100);

    const queries = db.calls.filter((call) => call.kind === "query");
    assert.equal(queries.length, 2);
    assert.match(queries[0]?.sql ?? "", /bool_or\(o\.value_number is not null\)/i);
    assert.match(queries[1]?.sql ?? "", /with scoped as/i);
    assert.doesNotMatch(queries[1]?.sql ?? "", /limit 750/i);
    assert.equal(queries[1]?.parameters[3], "revenue");

    const log = db.calls.find((call) => call.kind === "execute");
    assert.ok(log);
    assert.match(log.sql, /corvis_control\.semantic_query_log/i);
    assert.equal(log.parameters[0], identity.tenantId);
    assert.equal(log.parameters[2], identity.subject);
    assert.match(String(log.parameters[6]), /"version":"v2"/);
    assert.match(String(log.parameters[6]), /"metricCode":"revenue"/);

    const semanticQuery = aiBody?.semanticQuery as {
      status?: string;
      shape?: Record<string, unknown>;
      result?: { rows?: Array<Record<string, unknown>>; factIds?: string[] };
      rows?: Array<Record<string, unknown>>;
    };
    assert.equal(semanticQuery.status, "executed");
    assert.equal(semanticQuery.shape?.metricCode, "revenue");
    assert.equal(semanticQuery.result?.rows?.length, 1);
    assert.deepEqual(semanticQuery.result?.factIds, ["00000000-0000-0000-0000-000000000001"]);
    assert.equal(semanticQuery.rows?.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAi === undefined) delete process.env.CORVIS_AI_ENDPOINT;
    else process.env.CORVIS_AI_ENDPOINT = originalAi;
  }
});

test("research does not call source retrieval when source-document access is denied", async () => {
  const db = new FakeDb();
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalSearch = process.env.CORVIS_SEARCH_ENDPOINT;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_SEARCH_ENDPOINT = "https://search.example.test";
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ answer: "Revenue was 100." }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await new PermissionedResearchService(db).answer(identity, "What was revenue?");
    assert.deepEqual(urls, ["https://ai.example.test/answer"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAi === undefined) delete process.env.CORVIS_AI_ENDPOINT;
    else process.env.CORVIS_AI_ENDPOINT = originalAi;
    if (originalSearch === undefined) delete process.env.CORVIS_SEARCH_ENDPOINT;
    else process.env.CORVIS_SEARCH_ENDPOINT = originalSearch;
  }
});

test("source retrieval receives only the authoritative document subset and the governed fund scope", async () => {
  const db = new FakeDb();
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalSearch = process.env.CORVIS_SEARCH_ENDPOINT;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_SEARCH_ENDPOINT = "https://search.example.test";
  const originalFetch = globalThis.fetch;
  let searchBody: unknown;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "https://search.example.test/search") {
      searchBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ hits: [
        { sourceReferenceId: "src-allowed", documentId: "00000000-0000-0000-0000-000000000101", text: "Allowed evidence" },
        { sourceReferenceId: "src-denied", documentId: "00000000-0000-0000-0000-000000000102", text: "Denied evidence" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ answer: "Revenue was 100." }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const sourceScoped: RequestIdentity = {
      ...identity,
      entitlements: {
        ...identity.entitlements,
        sourceDocumentAccessAllowed: true,
        sourceDocumentIds: ["00000000-0000-0000-0000-000000000101"],
      },
    };
    const result = await new PermissionedResearchService(db).answer(sourceScoped, "Show fund-a revenue source evidence");
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0]?.documentId, "00000000-0000-0000-0000-000000000101");
    assert.equal(result.computedResults?.[0]?.status, "executed");
    const filters = (searchBody as { filters: { documentIds: string[]; fundIds: string[] } }).filters;
    assert.deepEqual(filters.documentIds, sourceScoped.entitlements.sourceDocumentIds);
    assert.deepEqual(filters.fundIds, ["fund-a"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAi === undefined) delete process.env.CORVIS_AI_ENDPOINT;
    else process.env.CORVIS_AI_ENDPOINT = originalAi;
    if (originalSearch === undefined) delete process.env.CORVIS_SEARCH_ENDPOINT;
    else process.env.CORVIS_SEARCH_ENDPOINT = originalSearch;
  }
});

test("research rejects AI responses that claim facts outside the governed semantic result", async () => {
  const db = new FakeDb();
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    answer: "Revenue was 999.",
    usedFactIds: ["00000000-0000-0000-0000-000000000999"],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  try {
    await assert.rejects(
      () => new PermissionedResearchService(db).answer(identity, "What was revenue?"),
      /outside the governed semantic result/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAi === undefined) delete process.env.CORVIS_AI_ENDPOINT;
    else process.env.CORVIS_AI_ENDPOINT = originalAi;
  }
});
