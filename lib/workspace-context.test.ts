import assert from "node:assert/strict";
import test from "node:test";

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

async function freshWorkspaceContext(tag: string) {
  return import(`./workspace-context.ts?workspace-context-test=${tag}-${Date.now()}-${Math.random()}`);
}

test("server-side callers have no workspace context", async () => {
  const restore = setWindow(undefined);
  try {
    const { workspaceContext, workspaceContextHeaders, workspaceStorageKey } = await freshWorkspaceContext("server");
    assert.equal(workspaceContext(), null);
    assert.deepEqual(workspaceContextHeaders(), {});
    assert.equal(workspaceStorageKey("review"), "review:default:default");
  } finally { restore(); }
});

test("a loaded page pins its selected context and namespaces persisted UI state", async () => {
  let current = JSON.stringify({ tenantId: "tenant-a", workspaceId: "workspace-a" });
  const restore = setWindow({ localStorage: { getItem(key: string) { assert.equal(key, "corvis:workspace-context:v1"); return current; } } });
  try {
    const { workspaceContextHeaders, workspaceStorageKey } = await freshWorkspaceContext("pinned");
    assert.deepEqual(workspaceContextHeaders(), { "x-corvis-tenant": "tenant-a", "x-corvis-workspace": "workspace-a" });
    current = JSON.stringify({ tenantId: "tenant-b", workspaceId: "workspace-b" });
    assert.deepEqual(workspaceContextHeaders(), { "x-corvis-tenant": "tenant-a", "x-corvis-workspace": "workspace-a" });
    assert.equal(workspaceStorageKey("review"), "review:tenant-a:workspace-a");
  } finally { restore(); }
});

test("malformed, incomplete, and blocked persisted context safely degrades to no context", async () => {
  for (const [tag, localStorage] of [
    ["malformed", { getItem: () => "{" }],
    ["incomplete", { getItem: () => JSON.stringify({ tenantId: "tenant-a", workspaceId: 42 }) }],
    ["blocked", { getItem: () => { throw new DOMException("blocked", "SecurityError"); } }],
  ] as const) {
    const restore = setWindow({ localStorage });
    try {
      const { workspaceContext, workspaceContextHeaders } = await freshWorkspaceContext(tag);
      assert.equal(workspaceContext(), null);
      assert.deepEqual(workspaceContextHeaders(), {});
    } finally { restore(); }
  }
});
