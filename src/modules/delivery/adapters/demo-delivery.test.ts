import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// demo-delivery.ts uses the Next.js "@/..." alias; see research-http.test.ts.
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const { createDemoDeliveryPort } = await import("./demo-delivery.ts");

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

function readOnlyRoleWindow(): unknown {
  return { localStorage: { getItem: () => null }, sessionStorage: { getItem: (key: string) => (key === "corvis:demo:role" ? "read_only" : null) } };
}

function secondaryWorkspaceWindow(): unknown {
  const stored = JSON.stringify({ tenantId: "demo-tenant", workspaceId: "demo-secondary" });
  return { localStorage: { getItem: () => stored }, sessionStorage: { getItem: () => null } };
}

test("createExport() refuses a read-only demo role, mirroring production's assertRedistributionAllowed", async () => {
  const restore = setWindow(readOnlyRoleWindow());
  try {
    const port = createDemoDeliveryPort();
    await assert.rejects(port.createExport("csv"), /redistribution_not_allowed/);
  } finally { restore(); }
});

test("createExport() refuses the secondary (read-only) demo workspace", async () => {
  const restore = setWindow(secondaryWorkspaceWindow());
  try {
    const port = createDemoDeliveryPort();
    await assert.rejects(port.createExport("csv"), /redistribution_not_allowed/);
  } finally { restore(); }
});

test("createExport() succeeds for the primary demo workspace with no read-only role set", async () => {
  const restore = setWindow(undefined);
  try {
    const port = createDemoDeliveryPort();
    const manifest = await port.createExport("csv");
    assert.ok(manifest.exportId);
  } finally { restore(); }
});
