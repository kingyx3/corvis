import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { OidcVerifier } from "../../modules/identity-access/server/oidc.ts";
import {
  AuthenticationError,
  SessionEndedByPolicyError,
  classifyOidcFailure,
  resolveRequestIdentity,
  verifyGatewayIdentityAssertion,
} from "./request-context.ts";

// Every way a signed gateway assertion or a verified bearer token can be wrong is refused as an authentication failure.
const SECRET = "assertion-secret";
const NOW = new Date(1_800_000_100_000);

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, sub: "user-1", tenantId: "tenant-a", workspaceId: "workspace-a", roles: ["reviewer"],
    entitlements: { workspaceIds: ["workspace-a"] }, authMethod: "saml", sessionId: "session-1",
    iat: 1_800_000_000, exp: 1_800_000_240, ...overrides,
  };
}

function signed(payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

function refused(payload: unknown, message: RegExp): void {
  assert.throws(() => verifyGatewayIdentityAssertion(signed(payload), SECRET, NOW), (error: unknown) => error instanceof AuthenticationError && message.test(error.message));
}

test("an assertion needs a secret, a payload and a signature with a body", () => {
  for (const [assertion, secret] of [[null, SECRET], ["", SECRET], [signed(valid()), undefined], [signed(valid()), ""]] as const) {
    assert.throws(() => verifyGatewayIdentityAssertion(assertion, secret, NOW), /Missing signed identity assertion/);
  }
  for (const malformed of ["nodots", ".onlysignature", "payload."]) {
    assert.throws(() => verifyGatewayIdentityAssertion(malformed, SECRET, NOW), /Malformed identity assertion$/);
  }
});

test("a decoding failure is an authentication failure, never an exception from the runtime", (t) => {
  t.mock.method(Buffer, "from", () => { throw new Error("decoder failure"); });
  assert.throws(() => verifyGatewayIdentityAssertion("payload.signature", SECRET, NOW), /Malformed identity assertion encoding/);
});

test("the signature must match, whatever its length, and the payload must be JSON", () => {
  assert.throws(() => verifyGatewayIdentityAssertion(signed(valid(), "other-secret"), SECRET, NOW), /Invalid identity assertion signature/);
  assert.throws(() => verifyGatewayIdentityAssertion(`${signed(valid()).split(".")[0]}.AAAA`, SECRET, NOW), /Invalid identity assertion signature/);
  assert.throws(() => verifyGatewayIdentityAssertion(signed("not json at all"), SECRET, NOW), /Malformed identity assertion payload/);
});

test("the payload must be an object of the supported version with every identifying field", () => {
  for (const payload of [null, [], "text", 5]) refused(payload, /Invalid identity assertion payload|Malformed identity assertion payload/);
  refused(valid({ v: 2 }), /Unsupported identity assertion version/);
  for (const field of ["sub", "tenantId", "workspaceId", "sessionId"]) {
    refused(valid({ [field]: undefined }), new RegExp(`Invalid identity assertion ${field}`));
    refused(valid({ [field]: "" }), new RegExp(`Invalid identity assertion ${field}`));
    refused(valid({ [field]: 7 }), new RegExp(`Invalid identity assertion ${field}`));
  }
});

test("roles, auth method, timestamps and lifetime are checked", () => {
  refused(valid({ roles: undefined }), /has no roles/);
  refused(valid({ roles: [] }), /has no roles/);
  refused(valid({ roles: ["superuser"] }), /invalid role/);
  refused(valid({ roles: [3] }), /invalid role/);
  refused(valid({ authMethod: "ldap" }), /auth method/);
  refused(valid({ iat: "x" }), /timestamps/);
  refused(valid({ exp: 1.5 }), /timestamps/);
  refused(valid({ iat: 1_800_000_200, exp: 1_800_000_300 }), /issued in the future/);
  refused(valid({ iat: 1_799_999_000, exp: 1_799_999_100 }), /expired/);
  refused(valid({ iat: 1_800_000_100, exp: 1_800_000_100 }), /lifetime is invalid/);
  refused(valid({ iat: 1_799_999_900, exp: 1_800_000_300 }), /lifetime is invalid/);
});

test("entitlements must be an object of string lists, and the workspace must be entitled", () => {
  refused(valid({ entitlements: undefined }), /entitlements/);
  refused(valid({ entitlements: [] }), /entitlements/);
  refused(valid({ entitlements: "all" }), /entitlements/);
  refused(valid({ entitlements: {} }), /workspaceIds/);
  refused(valid({ entitlements: { workspaceIds: "workspace-a" } }), /workspaceIds/);
  refused(valid({ entitlements: { workspaceIds: ["workspace-a", ""] } }), /workspaceIds/);
  refused(valid({ entitlements: { workspaceIds: ["workspace-a", 3] } }), /workspaceIds/);
  refused(valid({ entitlements: { workspaceIds: ["workspace-a"], fundIds: "f" } }), /fundIds/);
  refused(valid({ entitlements: { workspaceIds: ["workspace-a"], documentIds: [" "] } }), /documentIds/);
  refused(valid({ entitlements: { workspaceIds: ["workspace-b"] } }), /Workspace context not entitled/);
});

test("email claims must be well typed, and a verified email needs an address", () => {
  refused(valid({ email: 5 }), /assertion email$/);
  refused(valid({ emailVerified: "yes" }), /emailVerified/);
  refused(valid({ emailVerified: true }), /Verified identity assertion email is missing/);
  refused(valid({ emailVerified: true, email: "  " }), /Verified identity assertion email is missing/);
  refused(valid({ emailVerified: true, email: 4 }), /assertion email$/);
});

test("a valid assertion yields the identity, with a normalised verified email only when one was asserted", () => {
  const full = verifyGatewayIdentityAssertion(signed(valid({
    email: " Person@Example.Test ", emailVerified: true,
    entitlements: { workspaceIds: ["workspace-a"], fundIds: ["f-1"], documentIds: ["d-1"], sourceDocumentAccessAllowed: true, internalAnalyticsAllowed: true, modelTrainingAllowed: true, redistributionAllowed: true },
  })), SECRET, NOW);
  assert.equal(full.authenticatedEmail, "person@example.test");
  assert.equal(full.emailVerified, true);
  assert.deepEqual(full.entitlements, {
    workspaceIds: ["workspace-a"], fundIds: ["f-1"], documentIds: ["d-1"],
    sourceDocumentAccessAllowed: true, internalAnalyticsAllowed: true, modelTrainingAllowed: true, redistributionAllowed: true,
  });
  const unverified = verifyGatewayIdentityAssertion(signed(valid({ email: "p@example.test", emailVerified: false })), SECRET, NOW);
  assert.equal(unverified.authenticatedEmail, "p@example.test");
  assert.equal(unverified.emailVerified, false);
  const bare = verifyGatewayIdentityAssertion(signed(valid()), SECRET, NOW);
  assert.equal("authenticatedEmail" in bare, false);
  assert.equal("emailVerified" in bare, false);
  // The default clock is the real one: an assertion issued now is current.
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.equal(verifyGatewayIdentityAssertion(signed(valid({ iat: nowSeconds - 5, exp: nowSeconds + 60 })), SECRET).subject, "user-1");
});

test("an OIDC failure is classified as an outage only when the identity provider is the problem", () => {
  assert.equal(classifyOidcFailure(new Error("invalid OIDC token signature")), "token_rejected");
  assert.equal(classifyOidcFailure("a plain string"), "token_rejected");
  assert.equal(classifyOidcFailure(undefined), "token_rejected");
  assert.equal(classifyOidcFailure(Object.assign(new Error("x"), { name: "AbortError" })), "idp_unavailable");
  assert.equal(classifyOidcFailure(Object.assign(new Error("x"), { name: "TimeoutError" })), "idp_unavailable");
  assert.equal(classifyOidcFailure(new Error("fetch failed")), "idp_unavailable");
  assert.equal(classifyOidcFailure(new Error("OIDC metadata request failed with status 503")), "idp_unavailable");
  assert.equal(classifyOidcFailure(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } })), "idp_unavailable");
  assert.equal(classifyOidcFailure(Object.assign(new Error("x"), { cause: { code: 7 } })), "token_rejected");
  assert.equal(classifyOidcFailure(Object.assign(new Error("x"), { cause: "text" })), "token_rejected");
  assert.equal(classifyOidcFailure(Object.assign(new Error("x"), { cause: null })), "token_rejected");
});

test("a session ended by policy is an authentication failure that carries its reason", () => {
  const error = new SessionEndedByPolicyError("max_session");
  assert.ok(error instanceof AuthenticationError);
  assert.equal(error.reason, "max_session");
  assert.equal(error.name, "SessionEndedByPolicyError");
});

// ------------------------------------------------------------------ direct OIDC in production
const tenant = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";
const productionEnv = {
  NODE_ENV: "production", CORVIS_DEMO_MODE: "false", CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined,
  CORVIS_AUTH_ISSUER: "https://idp.validation.example", CORVIS_AUTH_AUDIENCE: "corvis", CORVIS_AUTH_JWKS_URL: undefined,
  CORVIS_DATABASE_DSN: "postgres://user:dummy@database.example.test/db", CORVIS_OBJECT_STORE_BUCKET: "bucket",
};

async function inProduction(run: () => Promise<void>, overrides: Record<string, string | undefined> = {}): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const merged = { ...productionEnv, ...overrides };
  const previous = Object.fromEntries(Object.keys(merged).map((key) => [key, env[key]]));
  try {
    for (const [key, value] of Object.entries(merged)) { if (value == null) delete env[key]; else env[key] = value; }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value == null) delete env[key]; else env[key] = value; }
  }
}

const bearer = (headers: Record<string, string> = {}) => new Request("https://corvis.example/api/v1/me", {
  headers: { authorization: "Bearer a.b.c", "x-corvis-tenant": tenant, "x-corvis-workspace": workspace, ...headers },
});

test("direct OIDC carries the verified email and token claims into the identity", { concurrency: false }, async (t) => {
  t.mock.method(OidcVerifier.prototype, "verify", async () => ({ subject: "user-1", sessionId: "sid-1", issuer: "https://idp.validation.example", audience: "corvis", email: "p@example.test", emailVerified: true }));
  await inProduction(async () => {
    const identity = await resolveRequestIdentity(bearer());
    assert.deepEqual([identity.authenticatedEmail, identity.emailVerified, identity.tokenIssuer, identity.tokenAudience], ["p@example.test", true, "https://idp.validation.example", "corvis"]);
  });
});

test("direct OIDC lets its own authentication failures through and logs every other failure without the token", { concurrency: false }, async (t) => {
  const logged: Array<Record<string, unknown>> = [];
  t.mock.method(console, "warn", (line: unknown) => { logged.push(JSON.parse(String(line)) as Record<string, unknown>); });
  t.mock.method(console, "error", (line: unknown) => { logged.push(JSON.parse(String(line)) as Record<string, unknown>); });
  const failures: unknown[] = [new AuthenticationError("already an authentication failure"), "plain string", new Error("invalid OIDC token signature"), new Error("fetch failed")];
  let next = 0;
  t.mock.method(OidcVerifier.prototype, "verify", async () => { throw failures[next++]; });
  await inProduction(async () => {
    await assert.rejects(resolveRequestIdentity(bearer()), /already an authentication failure/);
    assert.equal(logged.length, 0, "an authentication failure is not re-logged as a verification failure");
    await assert.rejects(resolveRequestIdentity(bearer({ "x-correlation-id": "corr-1" })), /OIDC authentication failed/);
    await assert.rejects(resolveRequestIdentity(bearer()), /OIDC authentication failed/);
    await assert.rejects(resolveRequestIdentity(bearer()), /OIDC authentication failed/);
  });
  assert.deepEqual(logged.map((line) => [line.correlationId, line.reason, line.errorName, line.message]), [
    ["corr-1", "token_rejected", "string", "unknown"],
    ["unknown", "token_rejected", "Error", "invalid OIDC token signature"],
    ["unknown", "idp_unavailable", "Error", "fetch failed"],
  ]);
  assert.ok(logged.every((line) => !JSON.stringify(line).includes("a.b.c")), "the token is never logged");
});
