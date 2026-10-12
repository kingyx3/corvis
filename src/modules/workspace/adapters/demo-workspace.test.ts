import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { ResearchAnswer } from "@/shared/domain/enterprise";

// demo-workspace.ts uses the Next.js "@/..." alias; see research-http.test.ts.
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const { createDemoWorkspacePort } = await import("./demo-workspace.ts");

const globals = globalThis as Record<string, unknown>;

function setWindow(value: unknown): () => void {
  const hadWindow = Object.prototype.hasOwnProperty.call(globals, "window");
  const previous = globals.window;
  if (value === undefined) delete globals.window;
  else globals.window = value;
  return () => {
    if (hadWindow) globals.window = previous;
    else delete globals.window;
  };
}

function secondaryWorkspaceWindow(): unknown {
  const stored = JSON.stringify({ tenantId: "demo-tenant", workspaceId: "demo-secondary" });
  return { localStorage: { getItem: () => stored } };
}

const ANSWER: ResearchAnswer = { answer: "42", citations: [], semanticQueryIds: [] };

test("the secondary (read-only) demo workspace cannot pin or unpin research answers", async () => {
  const restore = setWindow(secondaryWorkspaceWindow());
  try {
    const port = createDemoWorkspacePort();
    await assert.rejects(
      port.pinResearchAnswer({ question: "q", answer: ANSWER, askedAt: new Date().toISOString() }),
      /workspace_read_only/,
    );
    await assert.rejects(port.unpinResearchAnswer("some-pin-id"), /workspace_read_only/);
  } finally { restore(); }
});

test("the primary demo workspace can pin and unpin research answers", async () => {
  const restore = setWindow(undefined);
  try {
    const port = createDemoWorkspacePort();
    const pin = await port.pinResearchAnswer({ question: "q", answer: ANSWER, askedAt: new Date().toISOString() });
    assert.deepEqual((await port.listResearchPins()).map((row) => row.pinId), [pin.pinId]);
    await port.unpinResearchAnswer(pin.pinId);
    assert.deepEqual(await port.listResearchPins(), []);
  } finally { restore(); }
});

test("a pin created while in the secondary workspace can never exist, so it cannot leak into the primary workspace's list", async () => {
  const toSecondary = setWindow(secondaryWorkspaceWindow());
  const port = createDemoWorkspacePort();
  try {
    await assert.rejects(port.pinResearchAnswer({ question: "q", answer: ANSWER, askedAt: new Date().toISOString() }));
  } finally { toSecondary(); }
  const toPrimary = setWindow(undefined);
  try {
    assert.deepEqual(await port.listResearchPins(), []);
  } finally { toPrimary(); }
});
