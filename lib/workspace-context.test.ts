import assert from "node:assert/strict";
import test from "node:test";
import { workspaceContextHeaders, workspaceStorageKey, WORKSPACE_CONTEXT_KEY } from "./workspace-context.ts";

test("a loaded page pins its selected context and namespaces persisted UI state", () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.window;
  let current = JSON.stringify({ tenantId: "tenant-a", workspaceId: "workspace-a" });
  globals.window = { localStorage: { getItem(key: string) { assert.equal(key, WORKSPACE_CONTEXT_KEY); return current; } } };
  try {
    assert.deepEqual(workspaceContextHeaders(), { "x-corvis-tenant": "tenant-a", "x-corvis-workspace": "workspace-a" });
    current = JSON.stringify({ tenantId: "tenant-b", workspaceId: "workspace-b" });
    assert.deepEqual(workspaceContextHeaders(), { "x-corvis-tenant": "tenant-a", "x-corvis-workspace": "workspace-a" });
    assert.equal(workspaceStorageKey("review"), "review:tenant-a:workspace-a");
  } finally { globals.window = previous; }
});
