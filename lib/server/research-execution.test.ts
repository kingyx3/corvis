import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity, ResearchProgressPhase } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  parseResearchQuestion,
  PermissionedResearchService,
  ResearchCancelledError,
  ResearchProviderError,
  ResearchTimeoutError,
} from "./research.ts";

class FakeDb implements PostgresSqlApi {
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    void parameters;
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

const identity: RequestIdentity = {
  subject: "oidc|user-123",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["analyst"],
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-a"],
    documentIds: ["00000000-0000-0000-0000-000000000101"],
    sourceDocumentAccessAllowed: false,
  },
  authMethod: "oidc",
  sessionId: "session-1",
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("research reports deterministic execution phases in order", { concurrency: false }, async () => {
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalTimeout = process.env.CORVIS_RESEARCH_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_RESEARCH_TIMEOUT_MS = "30000";
  globalThis.fetch = (async () => new Response(JSON.stringify({ answer: "Revenue was 100." }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

  try {
    const phases: ResearchProgressPhase[] = [];
    const answer = await new PermissionedResearchService(new FakeDb()).answer(identity, "What was revenue?", {
      onProgress: (phase) => phases.push(phase),
    });
    assert.equal(answer.answer, "Revenue was 100.");
    assert.deepEqual(phases, ["planning", "retrieval", "generation"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CORVIS_AI_ENDPOINT", originalAi);
    restoreEnv("CORVIS_RESEARCH_TIMEOUT_MS", originalTimeout);
  }
});

test("research deadline aborts a hanging AI provider", { concurrency: false }, async () => {
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalTimeout = process.env.CORVIS_RESEARCH_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_RESEARCH_TIMEOUT_MS = "5";
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;

  try {
    await assert.rejects(
      new PermissionedResearchService(new FakeDb()).answer(identity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchTimeoutError && error.code === "research_timeout",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CORVIS_AI_ENDPOINT", originalAi);
    restoreEnv("CORVIS_RESEARCH_TIMEOUT_MS", originalTimeout);
  }
});

test("caller cancellation aborts in-flight AI provider work", { concurrency: false }, async () => {
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalTimeout = process.env.CORVIS_RESEARCH_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_RESEARCH_TIMEOUT_MS = "30000";
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    providerStarted();
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;

  try {
    const controller = new AbortController();
    const pending = new PermissionedResearchService(new FakeDb()).answer(identity, "What was revenue?", { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ResearchCancelledError && error.code === "research_cancelled",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CORVIS_AI_ENDPOINT", originalAi);
    restoreEnv("CORVIS_RESEARCH_TIMEOUT_MS", originalTimeout);
  }
});

test("AI provider failures surface as structured provider errors", { concurrency: false }, async () => {
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalTimeout = process.env.CORVIS_RESEARCH_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_RESEARCH_TIMEOUT_MS = "30000";
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;

  try {
    await assert.rejects(
      new PermissionedResearchService(new FakeDb()).answer(identity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchProviderError && error.code === "research_provider_error" && error.provider === "ai" && error.status === 503,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CORVIS_AI_ENDPOINT", originalAi);
    restoreEnv("CORVIS_RESEARCH_TIMEOUT_MS", originalTimeout);
  }
});

test("an unreachable AI provider surfaces as a structured provider error, not an internal failure", { concurrency: false }, async () => {
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalTimeout = process.env.CORVIS_RESEARCH_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_RESEARCH_TIMEOUT_MS = "30000";
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;

  try {
    await assert.rejects(
      new PermissionedResearchService(new FakeDb()).answer(identity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchProviderError && error.provider === "ai",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CORVIS_AI_ENDPOINT", originalAi);
    restoreEnv("CORVIS_RESEARCH_TIMEOUT_MS", originalTimeout);
  }
});

test("a non-JSON AI provider body surfaces as a structured provider error, not an internal failure", { concurrency: false }, async () => {
  const originalAi = process.env.CORVIS_AI_ENDPOINT;
  const originalTimeout = process.env.CORVIS_RESEARCH_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.CORVIS_AI_ENDPOINT = "https://ai.example.test";
  process.env.CORVIS_RESEARCH_TIMEOUT_MS = "30000";
  globalThis.fetch = (async () => new Response("<html>gateway</html>", { status: 200 })) as typeof fetch;

  try {
    await assert.rejects(
      new PermissionedResearchService(new FakeDb()).answer(identity, "What was revenue?"),
      (error: unknown) => error instanceof ResearchProviderError && error.provider === "ai" && error.status === 200,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("CORVIS_AI_ENDPOINT", originalAi);
    restoreEnv("CORVIS_RESEARCH_TIMEOUT_MS", originalTimeout);
  }
});

test("parseResearchQuestion accepts only a non-empty string question within the length limit", () => {
  assert.equal(parseResearchQuestion({ question: "  What was revenue?  " }), "What was revenue?");
  assert.equal(parseResearchQuestion({ question: "x".repeat(4000) }), "x".repeat(4000));
  for (const body of [null, undefined, "What?", [], {}, { question: 42 }, { question: ["a"] }, { question: { text: "a" } }, { question: "   " }, { question: "x".repeat(4001) }]) {
    assert.equal(parseResearchQuestion(body), null, `rejects ${JSON.stringify(body)}`);
  }
});
