import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import {
  PermissionedResearchService,
  ResearchCancelledError,
  ResearchProviderError,
  ResearchTimeoutError,
} from "./research.ts";

const SOURCE_DOCUMENT_ID = "00000000-0000-0000-0000-000000000101";

class FakeDb implements PostgresSqlApi {
  private readonly options: { hybridSearchEnabled?: boolean; citedSourceReferenceId?: string };
  constructor(options: { hybridSearchEnabled?: boolean; citedSourceReferenceId?: string } = {}) {
    this.options = options;
  }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    void parameters;
    if (sql.includes("from corvis_control.feature_flag where")) {
      return this.options.hybridSearchEnabled ? [{ flag_key: "retrieval.hybrid_search", enabled: true, kill_switch: false }] : [];
    }
    if (this.options.citedSourceReferenceId && sql.includes("from corvis_serving.source_references")) {
      return [{ source_reference_id: this.options.citedSourceReferenceId, document_id: SOURCE_DOCUMENT_ID }];
    }
    if (this.options.citedSourceReferenceId && sql.includes("from corvis_facts.observation_source_reference")) {
      // Two observations cite the same source: the open-reconciliation flag must be OR-ed across them.
      return [
        { source_reference_id: this.options.citedSourceReferenceId, observation_id: "00000000-0000-0000-0000-000000000001", has_open_reconciliation: false },
        { source_reference_id: this.options.citedSourceReferenceId, observation_id: "00000000-0000-0000-0000-000000000003", has_open_reconciliation: "true" },
      ];
    }
    if (sql.includes("bool_or(o.value_number is not null)")) {
      return [{ metric_code: "revenue", display_name: "Revenue", data_type: "number", aggregation_behavior: "additive sum", numeric_available: true }];
    }
    if (sql.includes("with scoped as")) {
      return [{
        observation_id: "00000000-0000-0000-0000-000000000001",
        fund_id: "fund-a",
        company_id: "company-a",
        metric_code: "revenue",
        value_number: 100,
        economic_period: "Q2 2025",
        source_reference_id: "00000000-0000-0000-0000-000000000002",
        version: 1,
      }];
    }
    return [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

const baseIdentity: RequestIdentity = {
  subject: "oidc|user-123",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["analyst"],
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-a"],
    documentIds: [SOURCE_DOCUMENT_ID],
    sourceDocumentAccessAllowed: false,
  },
  authMethod: "oidc",
  sessionId: "session-1",
};

// Entitled to source documents, so the retrieval phase reaches the external search index.
const searchIdentity: RequestIdentity = {
  ...baseIdentity,
  entitlements: { ...baseIdentity.entitlements, sourceDocumentAccessAllowed: true, sourceDocumentIds: [SOURCE_DOCUMENT_ID] },
};

const ENV_NAMES = [
  "CORVIS_AI_ENDPOINT",
  "CORVIS_AI_API_TOKEN",
  "CORVIS_SEARCH_ENDPOINT",
  "CORVIS_SEARCH_API_TOKEN",
  "CORVIS_RESEARCH_TIMEOUT_MS",
] as const;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Runs `body` with a stubbed environment and fetch, restoring both afterwards. */
async function withProviders(
  env: Partial<Record<(typeof ENV_NAMES)[number], string>>,
  fetchStub: typeof fetch,
  body: () => Promise<void>,
): Promise<void> {
  const originals = ENV_NAMES.map((name) => [name, process.env[name]] as const);
  const originalFetch = globalThis.fetch;
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_RESEARCH_TIMEOUT_MS = "30000";
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) process.env[name] = value;
  }
  globalThis.fetch = fetchStub;
  try {
    await body();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of originals) restoreEnv(name, value);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const aiAnswer = { answer: "Revenue was 100.", usedFactIds: ["00000000-0000-0000-0000-000000000001"] };
const searchEnv = { CORVIS_SEARCH_ENDPOINT: "https://search.example.test/" };
const hybridDb = () => new FakeDb({ hybridSearchEnabled: true });

/** A fetch stub that routes by URL: the search index and the AI service answer independently. */
function routedFetch(handlers: { search?: (init: RequestInit | undefined) => Promise<Response> | Response; ai?: (init: RequestInit | undefined) => Promise<Response> | Response }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/search")) return (handlers.search ?? (() => json({ hits: [] })))(init);
    return (handlers.ai ?? (() => json(aiAnswer)))(init);
  }) as typeof fetch;
}

/** A fetch stub that never settles on its own and rejects with the abort reason, like a real fetch. */
function hangingFetch(onStart?: () => void): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    onStart?.();
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;
}

/** A response whose body fails to parse, after optionally running a side effect (such as aborting the caller). */
function brokenBodyResponse(beforeFailure?: () => void): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      beforeFailure?.();
      throw new SyntaxError("Unexpected end of JSON input");
    },
  } as unknown as Response;
}

test("search and AI requests carry the configured bearer tokens", { concurrency: false }, async () => {
  const seen: Record<string, string | undefined> = {};
  const headerOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string>).authorization;
  await withProviders(
    { ...searchEnv, CORVIS_SEARCH_API_TOKEN: "search-token", CORVIS_AI_API_TOKEN: "ai-token" },
    routedFetch({
      search: (init) => { seen.search = headerOf(init); return json({ hits: [] }); },
      ai: (init) => { seen.ai = headerOf(init); return json(aiAnswer); },
    }),
    async () => {
      const answer = await new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?");
      assert.equal(answer.answer, "Revenue was 100.");
      assert.deepEqual(seen, { search: "Bearer search-token", ai: "Bearer ai-token" });
    },
  );
});

test("requests omit the authorization header when no token is configured", { concurrency: false }, async () => {
  const seen: Record<string, boolean> = {};
  const hasAuth = (init: RequestInit | undefined) => "authorization" in (init?.headers as Record<string, string>);
  await withProviders(
    searchEnv,
    routedFetch({
      search: (init) => { seen.search = hasAuth(init); return json({ hits: [] }); },
      ai: (init) => { seen.ai = hasAuth(init); return json(aiAnswer); },
    }),
    async () => {
      await new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?");
      assert.deepEqual(seen, { search: false, ai: false });
    },
  );
});

test("a caller signal that is already aborted cancels before any provider work", { concurrency: false }, async () => {
  let fetchCalls = 0;
  await withProviders({}, (async () => { fetchCalls += 1; return json(aiAnswer); }) as typeof fetch, async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      new PermissionedResearchService(new FakeDb()).answer(baseIdentity, "What was revenue?", { signal: controller.signal }),
      (error: unknown) => error instanceof ResearchCancelledError && error.code === "research_cancelled",
    );
    assert.equal(fetchCalls, 0);
  });
});

test("an abort while the AI response body streams keeps its cancel code", { concurrency: false }, async () => {
  const controller = new AbortController();
  await withProviders({}, (async () => brokenBodyResponse(() => controller.abort())) as typeof fetch, async () => {
    await assert.rejects(
      new PermissionedResearchService(new FakeDb()).answer(baseIdentity, "What was revenue?", { signal: controller.signal }),
      (error: unknown) => error instanceof ResearchCancelledError,
    );
  });
});

test("a deadline that expires while the AI response body streams keeps its timeout code", { concurrency: false }, async () => {
  await withProviders({ CORVIS_RESEARCH_TIMEOUT_MS: "5" }, (async (_input: RequestInfo | URL, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
    }),
  })) as unknown as typeof fetch, async () => {
    await assert.rejects(
      new PermissionedResearchService(new FakeDb()).answer(baseIdentity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchTimeoutError && error.code === "research_timeout",
    );
  });
});

for (const [label, body] of [["null", null], ["an array", [{ answer: "x" }]], ["a string", "answer"], ["a number", 42]] as const) {
  test(`an AI provider body that is ${label} surfaces as a structured provider error`, { concurrency: false }, async () => {
    await withProviders({}, (async () => json(body)) as typeof fetch, async () => {
      await assert.rejects(
        new PermissionedResearchService(new FakeDb()).answer(baseIdentity, "What was revenue?"),
        (error: unknown) => error instanceof ResearchProviderError && error.provider === "ai" && error.status === 200,
      );
    });
  });

  test(`a search provider body that is ${label} surfaces as a structured provider error`, { concurrency: false }, async () => {
    await withProviders(searchEnv, routedFetch({ search: () => json(body) }), async () => {
      await assert.rejects(
        new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?"),
        (error: unknown) => error instanceof ResearchProviderError && error.provider === "search" && error.status === 200,
      );
    });
  });
}

test("a missing search endpoint is a search provider error once retrieval is entitled and enabled", { concurrency: false }, async () => {
  let fetchCalls = 0;
  await withProviders({}, (async () => { fetchCalls += 1; return json(aiAnswer); }) as typeof fetch, async () => {
    await assert.rejects(
      new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchProviderError && error.provider === "search" && error.status === undefined,
    );
    assert.equal(fetchCalls, 0);
  });
});

test("retrieval is skipped without a search call when the hybrid search flag is not enabled", { concurrency: false }, async () => {
  let searchCalls = 0;
  await withProviders(searchEnv, routedFetch({ search: () => { searchCalls += 1; return json({ hits: [] }); } }), async () => {
    const answer = await new PermissionedResearchService(new FakeDb()).answer(searchIdentity, "What was revenue?");
    assert.equal(answer.answer, "Revenue was 100.");
    assert.equal(searchCalls, 0);
  });
});

test("an unreachable search index surfaces as a structured provider error", { concurrency: false }, async () => {
  await withProviders(searchEnv, routedFetch({ search: () => { throw new TypeError("fetch failed"); } }), async () => {
    await assert.rejects(
      new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchProviderError && error.provider === "search" && error.status === undefined,
    );
  });
});

test("caller cancellation while the search index hangs keeps its cancel code", { concurrency: false }, async () => {
  const controller = new AbortController();
  await withProviders(searchEnv, hangingFetch(() => queueMicrotask(() => controller.abort())), async () => {
    await assert.rejects(
      new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?", { signal: controller.signal }),
      (error: unknown) => error instanceof ResearchCancelledError,
    );
  });
});

test("a deadline that expires while the search index hangs keeps its timeout code", { concurrency: false }, async () => {
  await withProviders({ ...searchEnv, CORVIS_RESEARCH_TIMEOUT_MS: "5" }, hangingFetch(), async () => {
    await assert.rejects(
      new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchTimeoutError,
    );
  });
});

test("a failing search index response surfaces its status in a structured provider error", { concurrency: false }, async () => {
  await withProviders(searchEnv, routedFetch({ search: () => new Response("unavailable", { status: 503 }) }), async () => {
    await assert.rejects(
      new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchProviderError && error.provider === "search" && error.status === 503,
    );
  });
});

test("a non-JSON search index body surfaces as a structured provider error", { concurrency: false }, async () => {
  await withProviders(searchEnv, routedFetch({ search: () => brokenBodyResponse() }), async () => {
    await assert.rejects(
      new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchProviderError && error.provider === "search" && error.status === 200,
    );
  });
});

test("an abort while the search response body streams keeps its cancel code", { concurrency: false }, async () => {
  const controller = new AbortController();
  await withProviders(searchEnv, routedFetch({ search: () => brokenBodyResponse(() => controller.abort()) }), async () => {
    await assert.rejects(
      new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?", { signal: controller.signal }),
      (error: unknown) => error instanceof ResearchCancelledError,
    );
  });
});

test("a search body whose hits are not an array is treated as no hits", { concurrency: false }, async () => {
  let aiBody: { retrieval?: unknown } | undefined;
  await withProviders(
    searchEnv,
    routedFetch({
      search: () => json({ hits: "not-an-array" }),
      ai: (init) => { aiBody = JSON.parse(String(init?.body)); return json(aiAnswer); },
    }),
    async () => {
      const answer = await new PermissionedResearchService(hybridDb()).answer(searchIdentity, "What was revenue?");
      assert.equal(answer.answer, "Revenue was 100.");
      assert.deepEqual(answer.citations, []);
      assert.deepEqual(aiBody?.retrieval, []);
    },
  );
});

test("several observations citing one retrieved source collapse into a single citation that keeps any open reconciliation", { concurrency: false }, async () => {
  const sourceReferenceId = "00000000-0000-0000-0000-000000000002";
  await withProviders(
    searchEnv,
    routedFetch({ search: () => json({ hits: [{ sourceReferenceId, documentId: SOURCE_DOCUMENT_ID, page: 3, label: "Q2 report", text: "Revenue was 100." }] }) }),
    async () => {
      const db = new FakeDb({ hybridSearchEnabled: true, citedSourceReferenceId: sourceReferenceId });
      const answer = await new PermissionedResearchService(db).answer(searchIdentity, "What was revenue?");
      assert.equal(answer.citations.length, 1);
      assert.equal(answer.citations[0]?.sourceReferenceId, sourceReferenceId);
      assert.equal(answer.citations[0]?.observationId, "00000000-0000-0000-0000-000000000001");
      assert.equal(answer.citations[0]?.hasOpenReconciliation, true);
    },
  );
});
