import test from "node:test";
import assert from "node:assert/strict";
import { assertDocumentAccess, assertPermission, assertWorkspace, hasPermission, type RequestIdentity } from "./enterprise.ts";

const base: RequestIdentity = {
  subject: "user-1",
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  roles: ["analyst"],
  entitlements: { workspaceIds: ["workspace-a"], sourceDocumentAccessAllowed: false, documentIds: ["doc-a"] },
  authMethod: "oidc",
  sessionId: "session-a",
};

test("analyst can query research but cannot publish snapshots", () => {
  assert.equal(hasPermission(base, "research:query"), true);
  assert.equal(hasPermission(base, "snapshots:publish"), false);
  assert.throws(() => assertPermission(base, "snapshots:publish"));
});

test("workspace isolation fails closed", () => {
  assert.doesNotThrow(() => assertWorkspace(base, "workspace-a"));
  assert.throws(() => assertWorkspace(base, "workspace-b"));
});

test("source access is stricter than normalized document access", () => {
  assert.doesNotThrow(() => assertDocumentAccess(base, "doc-a", false));
  assert.throws(() => assertDocumentAccess(base, "doc-a", true));
  assert.throws(() => assertDocumentAccess(base, "doc-b", false));
});
