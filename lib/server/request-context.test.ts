import test from "node:test";
import assert from "node:assert/strict";
import { AuthenticationError, resolveRequestIdentity } from "./request-context.ts";

const managedKeys = ["NODE_ENV","CORVIS_DEMO_MODE","CORVIS_TRUSTED_AUTH_PROXY_SECRET"] as const;

function withEnv(values: Record<string,string|undefined>, fn: () => void) {
  const env = process.env as Record<string, string | undefined>;
  const previous = Object.fromEntries(managedKeys.map((key) => [key, env[key]]));
  try {
    for (const [key,value] of Object.entries(values)) {
      if (value == null) delete env[key];
      else env[key] = value;
    }
    fn();
  } finally {
    for (const key of managedKeys) {
      if (previous[key] == null) delete env[key];
      else env[key] = previous[key];
    }
  }
}

const trustedEnvironment = {
  NODE_ENV: "test",
  CORVIS_DEMO_MODE: "false",
  CORVIS_TRUSTED_AUTH_PROXY_SECRET: "trusted-secret",
};

function trustedHeaders(overrides: Record<string,string> = {}) {
  return {
    "x-corvis-gateway-secret": "trusted-secret",
    "x-corvis-auth-subject": "user-1",
    "x-corvis-auth-tenant": "tenant-a",
    "x-corvis-auth-workspace": "workspace-a",
    "x-corvis-auth-roles": "reviewer",
    "x-corvis-entitled-workspaces": "workspace-a",
    ...overrides,
  };
}

test("production identity headers fail closed without trusted gateway secret", { concurrency: false }, () => {
  withEnv(trustedEnvironment, () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: {
      "x-corvis-auth-subject": "user-1", "x-corvis-auth-tenant": "tenant-a", "x-corvis-auth-workspace": "workspace-a", "x-corvis-auth-roles": "admin",
    }});
    assert.throws(() => resolveRequestIdentity(request), AuthenticationError);
  });
});

test("incorrect trusted gateway secret is rejected", { concurrency: false }, () => {
  withEnv(trustedEnvironment, () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({ "x-corvis-gateway-secret": "wrong-secret" }) });
    assert.throws(() => resolveRequestIdentity(request), AuthenticationError);
  });
});

test("trusted gateway identity resolves explicit tenant, role and source entitlement", { concurrency: false }, () => {
  withEnv(trustedEnvironment, () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({
      "x-corvis-auth-roles": "reviewer,unknown-role",
      "x-corvis-entitled-documents": "doc-a,doc-b",
      "x-corvis-source-access": "true",
      "x-corvis-auth-method": "saml",
    })});
    const identity = resolveRequestIdentity(request);
    assert.equal(identity.tenantId, "tenant-a");
    assert.deepEqual(identity.roles, ["reviewer"]);
    assert.deepEqual(identity.entitlements.documentIds, ["doc-a","doc-b"]);
    assert.equal(identity.entitlements.sourceDocumentAccessAllowed, true);
    assert.equal(identity.authMethod, "saml");
  });
});

test("workspace context cannot be selected outside the entitled workspace set", { concurrency: false }, () => {
  withEnv(trustedEnvironment, () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({
      "x-corvis-auth-workspace": "workspace-b",
      "x-corvis-entitled-workspaces": "workspace-a",
    })});
    assert.throws(() => resolveRequestIdentity(request), /Workspace context not entitled/);
  });
});

test("unknown or empty roles cannot create an authenticated request context", { concurrency: false }, () => {
  withEnv(trustedEnvironment, () => {
    for (const roles of ["", "root,superuser"]) {
      const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({ "x-corvis-auth-roles": roles }) });
      assert.throws(() => resolveRequestIdentity(request), /Missing authenticated request context/);
    }
  });
});

test("service-account authentication remains explicit and does not expand supplied roles", { concurrency: false }, () => {
  withEnv(trustedEnvironment, () => {
    const request = new Request("https://corvis.example/api/v1/me", { headers: trustedHeaders({
      "x-corvis-auth-method": "service_account",
      "x-corvis-auth-roles": "api_client,admin-ish",
    })});
    const identity = resolveRequestIdentity(request);
    assert.equal(identity.authMethod, "service_account");
    assert.deepEqual(identity.roles, ["api_client"]);
  });
});

test("demo identity is available only when explicitly enabled outside production", { concurrency: false }, () => {
  withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "true", CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined }, () => {
    const identity = resolveRequestIdentity(new Request("https://localhost/api/v1/me"));
    assert.equal(identity.authMethod, "demo");
    assert.equal(identity.tenantId, "tenant_demo");
  });
});
