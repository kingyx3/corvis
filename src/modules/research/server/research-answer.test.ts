import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { answerResearchQuestion } from "./research-answer.ts";
import { ResearchProviderError } from "./research.ts";

const identity: RequestIdentity = {
  subject: "demo|reviewer",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["reviewer"],
  entitlements: { workspaceIds: ["00000000-0000-0000-0000-000000000020"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
};

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("demo research reports each phase in order and honours cancellation between phases", { concurrency: false }, async () => {
  await withEnv({ CORVIS_DEMO_MODE: "true" }, async () => {
    const phases: string[] = [];
    const answer = await answerResearchQuestion(identity, "What is NAV?", { onProgress: (phase) => phases.push(phase) });
    assert.deepEqual(phases, ["planning", "retrieval", "generation"]);
    assert.equal(answer.answer, "Demo-mode response for: What is NAV?.");
    assert.deepEqual([answer.citations, answer.semanticQueryIds], [[], []]);
    assert.match(answer.uncertainty ?? "", /Demo mode/);
    assert.equal((await answerResearchQuestion(identity, "No options")).citations.length, 0);

    const aborted = new AbortController();
    aborted.abort(new Error("cancelled up front"));
    await assert.rejects(answerResearchQuestion(identity, "q", { signal: aborted.signal }), /cancelled up front/);

    for (const stopAfter of ["planning", "retrieval", "generation"]) {
      const controller = new AbortController();
      const seen: string[] = [];
      await assert.rejects(
        answerResearchQuestion(identity, "q", { signal: controller.signal, onProgress: (phase) => { seen.push(phase); if (phase === stopAfter) controller.abort(new Error(`stopped after ${stopAfter}`)); } }),
        new RegExp(`stopped after ${stopAfter}`),
      );
      assert.equal(seen.at(-1), stopAfter, "no phase starts after the abort");
    }
  });
});

test("outside demo mode research fails closed through the permissioned research service when no AI endpoint is configured", { concurrency: false }, async () => {
  await withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "false", CORVIS_AI_ENDPOINT: undefined, CORVIS_DATABASE_DSN: "postgres://corvis:secret@localhost:5432/corvis" }, async () => {
    const phases: string[] = [];
    await assert.rejects(
      answerResearchQuestion(identity, "What is NAV?", { onProgress: (phase) => phases.push(phase) }),
      (error: unknown) => error instanceof ResearchProviderError && error.provider === "ai",
    );
    assert.deepEqual(phases, [], "no research phase starts before the provider check");
    await assert.rejects(answerResearchQuestion(identity, "What is NAV?"), ResearchProviderError);
  });
});
