import assert from "node:assert/strict";
import test from "node:test";
import { workspaceContext, workspaceContextHeaders, workspaceStorageKey } from "./workspace-context.ts";

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

test("server-side callers have no workspace context", () => {
  const restore = setWindow(undefined);
  try {
    assert.equal(workspaceContext(), null);
    assert.deepEqual(workspaceContextHeaders(), {});
    assert.equal(workspaceStorageKey("review"), "review:default:default");
  } finally { restore(); }
});

test("a loaded page pins its selected context and namespaces persisted UI state", () => {
  let current = JSON.stringify({ tenantId: "tenant-a", workspaceId: "workspace-a" });
  const browserWindow = { localStorage: { getItem(key: string) { assert.equal(key, "corvis:workspace-context:v1"); return current; } } };
  const restore = setWindow(browserWindow);
  try {
    assert.deepEqual(workspaceContextHeaders(), { "x-corvis-tenant": "tenant-a", "x-corvis-workspace": "workspace-a" });
    current = JSON.stringify({ tenantId: "tenant-b", workspaceId: "workspace-b" });
    assert.deepEqual(workspaceContextHeaders(), { "x-corvis-tenant": "tenant-a", "x-corvis-workspace": "workspace-a" });
    assert.equal(workspaceStorageKey("review"), "review:tenant-a:workspace-a");
  } finally { restore(); }
});

test("malformed, incomplete, and blocked persisted context safely degrades to no context", () => {
  const cases = [
    { localStorage: { getItem: () => "{" } },
    { localStorage: { getItem: () => JSON.stringify({ tenantId: 42, workspaceId: "workspace-a" }) } },
    { localStorage: { getItem: () => JSON.stringify({ tenantId: "tenant-a", workspaceId: 42 }) } },
    { localStorage: { getItem: () => { throw new DOMException("blocked", "SecurityError"); } } },
  ];
  for (const browserWindow of cases) {
    const restore = setWindow(browserWindow);
    try {
      assert.equal(workspaceContext(), null);
      assert.deepEqual(workspaceContextHeaders(), {});
    } finally { restore(); }
  }
});
