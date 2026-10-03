import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { sourceConnectorSecretReference } from "./source-connector-runtime.ts";
import type { SecretPayload, SecretStore, SecretWriteOptions } from "./source-connectors.ts";
import {
  OAUTH_ATTEMPT_COOKIE,
  OAUTH_ATTEMPT_TTL_SECONDS,
  attemptCookie,
  clearedAttemptCookie,
  consumeOAuthAttempt,
  discardOAuthAttempt,
  pkceChallenge,
  readAttemptCookie,
  startOAuthAttempt,
  type SourceOAuthClient,
} from "./source-oauth.ts";

class FakeSecrets implements SecretStore {
  readonly entries = new Map<string, SecretPayload>();
  readonly writes: Array<{ tenantId: string; providerKey: string; options?: SecretWriteOptions }> = [];
  failReads = false;
  failRevokes = false;
  private counter = 0;
  async write(tenantId: string, providerKey: string, secret: SecretPayload, options?: SecretWriteOptions): Promise<string> {
    const reference = sourceConnectorSecretReference(tenantId, providerKey, ++this.counter);
    this.entries.set(reference, structuredClone(secret));
    this.writes.push({ tenantId, providerKey, ...(options ? { options } : {}) });
    return reference;
  }
  async read(reference: string): Promise<SecretPayload> {
    if (this.failReads || !this.entries.has(reference)) throw new Error("secret_reference_not_found");
    return this.entries.get(reference)!;
  }
  async revoke(reference: string): Promise<void> {
    if (this.failRevokes) throw new Error("gone");
    this.entries.delete(reference);
  }
}

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return { subject: "admin-1", tenantId: "tenant-a", workspaceId: "workspace-1", roles: ["admin"], entitlements: { workspaceIds: ["workspace-1"] }, authMethod: "demo", sessionId: "s", ...overrides } as RequestIdentity;
}

let lastAuthorization: { state: string; codeChallenge: string; redirectUri: string } | undefined;
const client: SourceOAuthClient = {
  authorizationUrl(input) { lastAuthorization = input; return `https://provider.test/consent?state=${input.state}`; },
  async exchangeCode() { return { accessToken: "x" }; },
};

async function start(secrets: FakeSecrets, who = identity()) {
  const started = await startOAuthAttempt(who, { providerKey: "acme-oauth", connectionLabel: "Acme", client, redirectUri: "https://app.test/?source_oauth=return" }, { secrets });
  return { started, state: lastAuthorization!.state, challenge: lastAuthorization!.codeChallenge };
}

const invalid = (error: unknown) => error instanceof Error && error.message === "oauth_attempt_invalid";

test("starting an attempt keeps state and the PKCE verifier server-side with a short TTL and hands the browser only a pointer", async () => {
  const secrets = new FakeSecrets();
  const { started, state, challenge } = await start(secrets);
  assert.equal(started.authorizationUrl, `https://provider.test/consent?state=${state}`);
  assert.equal(lastAuthorization?.redirectUri, "https://app.test/?source_oauth=return");
  assert.deepEqual(secrets.writes, [{ tenantId: "tenant-a", providerKey: "oauth-attempt", options: { ttlSeconds: OAUTH_ATTEMPT_TTL_SECONDS } }]);
  const stored = secrets.entries.get(started.attemptReference)!;
  assert.equal(stored.state, state);
  assert.equal(pkceChallenge(String(stored.codeVerifier)), challenge, "the challenge sent to the provider is the S256 of the stored verifier");
  assert.equal(createHash("sha256").update(String(stored.codeVerifier)).digest("base64url"), challenge);
  assert.ok(String(stored.codeVerifier).length >= 43, "RFC 7636 minimum verifier length");
  assert.ok(!started.authorizationUrl.includes(String(stored.codeVerifier)), "the verifier never reaches the provider URL");
  assert.ok(!started.attemptReference.includes(String(stored.codeVerifier)), "nor the browser's pointer");
});

test("a valid redirect consumes the attempt exactly once", async () => {
  const secrets = new FakeSecrets();
  const { started, state } = await start(secrets);
  const consumed = await consumeOAuthAttempt(identity(), { attemptReference: started.attemptReference, state }, { secrets });
  assert.equal(consumed.providerKey, "acme-oauth");
  assert.equal(consumed.connectionLabel, "Acme");
  assert.ok(consumed.codeVerifier.length >= 43);
  assert.equal(secrets.entries.size, 0, "the pending attempt is destroyed");
  await assert.rejects(consumeOAuthAttempt(identity(), { attemptReference: started.attemptReference, state }, { secrets }), invalid, "a replayed redirect finds nothing");
});

test("a failure to destroy the attempt does not turn a valid redirect into an error", async () => {
  const secrets = new FakeSecrets();
  const { started, state } = await start(secrets);
  secrets.failRevokes = true;
  const consumed = await consumeOAuthAttempt(identity(), { attemptReference: started.attemptReference, state }, { secrets });
  assert.equal(consumed.providerKey, "acme-oauth");
});

test("a wrong state, another administrator, another workspace or an expired attempt is refused and still destroys the attempt", async () => {
  const cases: Array<[string, { who?: RequestIdentity; state?: string; now?: () => number }]> = [
    ["wrong state", { state: "forged-state-value" }],
    ["state of a different length", { state: "x" }],
    ["another administrator", { who: identity({ subject: "admin-2" }) }],
    ["another workspace", { who: identity({ workspaceId: "workspace-2" }) }],
    ["an expired attempt", { now: () => Date.now() + (OAUTH_ATTEMPT_TTL_SECONDS + 5) * 1000 }],
  ];
  for (const [label, override] of cases) {
    const secrets = new FakeSecrets();
    const { started, state } = await start(secrets);
    await assert.rejects(consumeOAuthAttempt(override.who ?? identity(), { attemptReference: started.attemptReference, state: override.state ?? state }, { secrets, ...(override.now ? { now: override.now } : {}) }), invalid, label);
    assert.equal(secrets.entries.size, 0, `${label}: the attempt is single-use whatever the outcome`);
  }
});

test("a missing, foreign-tenant, unreadable or malformed attempt is refused before it can be used", async () => {
  const secrets = new FakeSecrets();
  const { started, state } = await start(secrets);
  await assert.rejects(consumeOAuthAttempt(identity(), { attemptReference: undefined, state }, { secrets }), invalid);
  await assert.rejects(consumeOAuthAttempt(identity({ tenantId: "tenant-b" }), { attemptReference: started.attemptReference, state }, { secrets }), invalid, "a pointer minted for another tenant");
  assert.equal(secrets.entries.size, 1, "a foreign pointer never reads or destroys the attempt");
  secrets.failReads = true;
  await assert.rejects(consumeOAuthAttempt(identity(), { attemptReference: started.attemptReference, state }, { secrets }), invalid);
  secrets.failReads = false;

  for (const payload of [{ kind: "something_else" }, { kind: "source_oauth_attempt", providerKey: 1 }]) {
    const reference = await secrets.write("tenant-a", "oauth-attempt", payload);
    await assert.rejects(consumeOAuthAttempt(identity(), { attemptReference: reference, state }, { secrets }), invalid);
  }
});

test("a declined attempt is destroyed without being read, and only inside the caller's tenant", async () => {
  const secrets = new FakeSecrets();
  const { started } = await start(secrets);
  await discardOAuthAttempt(identity({ tenantId: "tenant-b" }), started.attemptReference, { secrets });
  assert.equal(secrets.entries.size, 1);
  await discardOAuthAttempt(identity(), undefined, { secrets });
  assert.equal(secrets.entries.size, 1);
  secrets.failRevokes = true;
  await discardOAuthAttempt(identity(), started.attemptReference, { secrets });
  assert.equal(secrets.entries.size, 1, "a store failure never fails the caller");
  secrets.failRevokes = false;
  await discardOAuthAttempt(identity(), started.attemptReference, { secrets });
  assert.equal(secrets.entries.size, 0);
});

test("the cookie is HttpOnly, SameSite=Lax, scoped to the OAuth routes and short-lived, and Secure over HTTPS", () => {
  const secure = attemptCookie("projects/p/secrets/corvis-src-t-oauth-attempt-1", true);
  assert.match(secure, new RegExp(`^${OAUTH_ATTEMPT_COOKIE}=`));
  for (const part of ["Path=/api/v1/source-connections/oauth", `Max-Age=${OAUTH_ATTEMPT_TTL_SECONDS}`, "HttpOnly", "SameSite=Lax", "Secure"]) assert.ok(secure.includes(part), part);
  assert.ok(!attemptCookie("x", false).includes("Secure"));
  assert.match(clearedAttemptCookie(true), /Max-Age=0.*Secure/);
  assert.ok(!clearedAttemptCookie(false).includes("Secure"));
});

test("the pointer is read back from the request cookie, tolerating other cookies and refusing malformed ones", () => {
  const reference = "projects/p/secrets/corvis-src-t-oauth-attempt-1";
  const withCookie = (cookie?: string) => new Request("https://app.test/", cookie === undefined ? {} : { headers: { cookie } });
  assert.equal(readAttemptCookie(withCookie(`a=1; ${OAUTH_ATTEMPT_COOKIE}=${encodeURIComponent(reference)}; b=2`)), reference);
  assert.equal(readAttemptCookie(withCookie()), undefined);
  assert.equal(readAttemptCookie(withCookie("a=1; novalue; b=2")), undefined);
  assert.equal(readAttemptCookie(withCookie(`${OAUTH_ATTEMPT_COOKIE}=`)), undefined);
  assert.equal(readAttemptCookie(withCookie(`${OAUTH_ATTEMPT_COOKIE}=%E0%A4%A`)), undefined);
});
