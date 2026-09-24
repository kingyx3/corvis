import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is
// needed: route modules use the Next.js "@/..." path alias that plain
// `node --test` cannot resolve on its own.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";

const { GET: capabilitiesGet } = await import("@/app/api/v1/capabilities/route");

type Capabilities = { permissions: string[]; sourceDocumentAccessAllowed: boolean; redistributionAllowed: boolean };

function request(roles: string, options: { redistribution?: boolean } = {}): Request {
  return new Request("https://corvis.test/api/v1/capabilities", {
    headers: {
      "x-corvis-demo-tenant": "tenant-capabilities",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": `capabilities-${roles}`,
      "x-corvis-demo-roles": roles,
      "x-corvis-demo-redistribution": options.redistribution ? "true" : "false",
      "x-correlation-id": "corr-capabilities",
    },
  });
}

async function capabilities(response: Response): Promise<Capabilities> {
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Capabilities; correlationId: string };
  assert.equal(body.correlationId, "corr-capabilities");
  return body.data;
}

test("GET /capabilities reports exactly the permissions the resolved roles grant", async () => {
  const readOnly = await capabilities(await capabilitiesGet(request("read_only")));
  assert.deepEqual(readOnly.permissions, ["documents:read", "observations:read"]);

  const reviewer = await capabilities(await capabilitiesGet(request("reviewer")));
  assert.deepEqual(reviewer.permissions, ["documents:read", "sources:read", "observations:read", "observations:review", "research:query", "exports:create"]);
  assert.equal(reviewer.permissions.includes("admin:manage"), false);
  assert.equal(reviewer.permissions.includes("snapshots:publish"), false);

  const admin = await capabilities(await capabilitiesGet(request("admin")));
  assert.ok(admin.permissions.includes("admin:manage"));
});

test("GET /capabilities reflects data rights, not just roles", async () => {
  const withoutRedistribution = await capabilities(await capabilitiesGet(request("analyst")));
  assert.equal(withoutRedistribution.redistributionAllowed, false);
  assert.ok(withoutRedistribution.permissions.includes("exports:create"), "role permission and data right are reported independently");

  const withRedistribution = await capabilities(await capabilitiesGet(request("analyst", { redistribution: true })));
  assert.equal(withRedistribution.redistributionAllowed, true);
  assert.equal(typeof withRedistribution.sourceDocumentAccessAllowed, "boolean");
});

test("GET /capabilities returns only presentation fields, never identity internals", async () => {
  const response = await capabilitiesGet(request("admin"));
  const body = await response.json() as { data: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.data).sort(), ["permissions", "redistributionAllowed", "sourceDocumentAccessAllowed"]);
});
