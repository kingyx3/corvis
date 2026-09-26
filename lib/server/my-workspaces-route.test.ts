import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is needed.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";

const { GET } = await import("@/app/api/v1/my-workspaces/route");

type Membership = { workspaceId: string; workspaceDisplayName?: string; roles: string[] };

function request(): Request {
  return new Request("https://corvis.test/api/v1/my-workspaces", {
    headers: {
      "x-corvis-demo-tenant": "tenant-my-workspaces",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-workspace-name": "Primary Workspace",
      "x-corvis-demo-subject": "my-workspaces-user",
      "x-corvis-demo-roles": "analyst",
      "x-correlation-id": "corr-my-workspaces",
    },
  });
}

test("GET /my-workspaces reports the demo identity's single simulated workspace", async () => {
  const response = await GET(request());
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Membership[]; correlationId: string };
  assert.equal(body.correlationId, "corr-my-workspaces");
  assert.deepEqual(body.data, [{ workspaceId: "workspace-1", workspaceDisplayName: "Primary Workspace", roles: ["analyst"] }]);
});

test("GET /my-workspaces returns only chrome fields, never raw identity internals", async () => {
  const response = await GET(request());
  const body = await response.json() as { data: Array<Record<string, unknown>> };
  for (const membership of body.data) {
    assert.deepEqual(Object.keys(membership).sort(), ["roles", "workspaceDisplayName", "workspaceId"]);
  }
});
