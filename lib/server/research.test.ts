import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "@/core/enterprise";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { PermissionedResearchService } from "./research.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };

class FakeDb implements PostgresSqlApi {
  calls: Call[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return [{
      observation_id: "00000000-0000-0000-0000-000000000001",
      fund_id: "fund-a",
      metric_code: "revenue",
      value_number: 100,
      source_reference_id: "00000000-0000-0000-0000-000000000002",
      version: 1,
    }];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.calls.push({ sql, parameters });
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

test("research queries only tenant/fund/document-scoped Postgres serving data and persists the query shape", async () => {
  const db = new FakeDb();
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), "https://ai.example.test/answer");
    return new Response(JSON.stringify({ answer: "Revenue was 100." }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await new PermissionedResearchService(db).answer(identity, "What was revenue?");
    assert.equal(result.answer, "Revenue was 100.");
    assert.equal(result.citations.length, 0);
    assert.equal(result.semanticQueryIds.length, 1);

    const read = db.calls[0];
    assert.match(read.sql, /from corvis_serving\.observations o/i);
    assert.match(read.sql, /join corvis_source\.source_reference r/i);
    assert.match(read.sql, /o\.tenant_id=\$1/i);
    assert.match(read.sql, /o\.fund_id in/i);
    assert.match(read.sql, /r\.document_id::text in/i);
    assert.equal(read.parameters[0], identity.tenantId);
    assert.equal(read.parameters[1], JSON.stringify(["fund-a", "fund-b"]));
    assert.equal(read.parameters[2], JSON.stringify(identity.entitlements.documentIds));

    const log = db.calls[1];
    assert.match(log.sql, /corvis_control\.semantic_query_log/i);
    assert.equal(log.parameters[0], identity.tenantId);
    assert.equal(log.parameters[2], identity.subject);
    assert.match(String(log.parameters[6]), /"source":"corvis_serving\.observations"/);
    assert.match(String(log.parameters[6]), /"documentIds":/);
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

test("source retrieval receives only the authoritative source-document subset and drops unexpected hits", async () => {
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
    const result = await new PermissionedResearchService(db).answer(sourceScoped, "Show source evidence");
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0]?.documentId, "00000000-0000-0000-0000-000000000101");
    assert.deepEqual((searchBody as { filters: { documentIds: string[] } }).filters.documentIds, sourceScoped.entitlements.sourceDocumentIds);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAi === undefined) delete process.env.CORVIS_AI_ENDPOINT;
    else process.env.CORVIS_AI_ENDPOINT = originalAi;
    if (originalSearch === undefined) delete process.env.CORVIS_SEARCH_ENDPOINT;
    else process.env.CORVIS_SEARCH_ENDPOINT = originalSearch;
  }
});
