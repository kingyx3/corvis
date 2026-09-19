import test from "node:test";
import assert from "node:assert/strict";
import { assertDocumentAccess, assertPermission, assertWorkspace, hasPermission, type Permission, type RequestIdentity, type Role } from "./enterprise.ts";

const base: RequestIdentity = {
  subject: "user-1",
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  roles: ["analyst"],
  entitlements: { workspaceIds: ["workspace-a"], sourceDocumentAccessAllowed: false, documentIds: ["doc-a"] },
  authMethod: "oidc",
  sessionId: "session-a",
};

const roleCases: Array<{ role: Role; allowed: Permission[]; denied: Permission[] }> = [
  {
    role: "read_only",
    allowed: ["documents:read", "observations:read"],
    denied: ["documents:write", "sources:read", "observations:review", "snapshots:publish", "research:query", "exports:create", "admin:manage"],
  },
  {
    role: "api_client",
    allowed: ["documents:read", "observations:read", "research:query", "exports:create"],
    denied: ["documents:write", "sources:read", "observations:review", "snapshots:publish", "admin:manage"],
  },
  {
    role: "analyst",
    allowed: ["documents:read", "sources:read", "observations:read", "research:query", "exports:create"],
    denied: ["documents:write", "observations:review", "snapshots:publish", "admin:manage"],
  },
  {
    role: "reviewer",
    allowed: ["documents:read", "sources:read", "observations:read", "observations:review", "research:query", "exports:create"],
    denied: ["documents:write", "snapshots:publish", "admin:manage"],
  },
];

test("analyst can query research but cannot publish snapshots", () => {
  assert.equal(hasPermission(base, "research:query"), true);
  assert.equal(hasPermission(base, "snapshots:publish"), false);
  assert.throws(() => assertPermission(base, "snapshots:publish"));
});

for (const { role, allowed, denied } of roleCases) {
  test(`${role} role cannot escalate outside its explicit permission set`, () => {
    const identity = { ...base, roles: [role] };
    for (const permission of allowed) assert.equal(hasPermission(identity, permission), true, `${role} should allow ${permission}`);
    for (const permission of denied) {
      assert.equal(hasPermission(identity, permission), false, `${role} should deny ${permission}`);
      assert.throws(() => assertPermission(identity, permission));
    }
  });
}

test("workspace isolation fails closed", () => {
  assert.doesNotThrow(() => assertWorkspace(base, "workspace-a"));
  assert.throws(() => assertWorkspace(base, "workspace-b"));
});

test("workspace switching fails even if a different workspace appears in the entitlement list", () => {
  const multiWorkspace = {
    ...base,
    entitlements: { ...base.entitlements, workspaceIds: ["workspace-a", "workspace-b"] },
  };
  assert.throws(() => assertWorkspace(multiWorkspace, "workspace-b"));
});

test("source access is stricter than normalized document access", () => {
  assert.doesNotThrow(() => assertDocumentAccess(base, "doc-a", false));
  assert.throws(() => assertDocumentAccess(base, "doc-a", true));
  assert.throws(() => assertDocumentAccess(base, "doc-b", false));
});

test("document entitlement does not become a wildcard when a scoped list is present", () => {
  for (const documentId of ["doc-b", "doc-c", "tenant-b-doc-a"]) {
    assert.throws(() => assertDocumentAccess(base, documentId, false));
  }
});

test("an explicit empty document entitlement list denies every document", () => {
  const noDocuments = { ...base, entitlements: { ...base.entitlements, documentIds: [] } };
  assert.throws(() => assertDocumentAccess(noDocuments, "doc-a", false));
});
