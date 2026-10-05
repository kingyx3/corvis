import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { sourceConnectorSecretReference } from "./source-connector-runtime.ts";
import type { SecretPayload, SecretStore, SecretWriteOptions } from "./source-connectors.ts";
import {
  OAUTH_ATTEMPT_COOKIE,
  OAUTH_ATTEMPT_TTL_SECONDS,
  attemptCookie,
  clearedAttemptCookie,
  consumeOAuthAttempt,
  discardOAuthAttempt,
  freshOAuthCredential,
  OAUTH_EXPIRY_SKEW_SECONDS,
  OAuthCredentialExpiredError,
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

test("a pointer that merely contains the caller's own tenant suffix after a victim's reference is still refused", async () => {
  // belongsToTenant() must match the *entire* reference, not just contain the expected suffix: `GcpSecretManagerSecretStore`
  // splices the reference straight into a URL, where a `#` fragment is dropped by URL parsing before the request
  // reaches the server, so a string like "<victim's real reference>#<attacker's own valid suffix>" would pass a
  // substring check yet actually resolve to the victim's secret once requested.
  const secrets = new FakeSecrets();
  const { started: victim } = await start(secrets, identity({ tenantId: "tenant-victim" }));
  const smuggled = `${victim.attemptReference}#projects/corvis-local-dev/secrets/corvis-src-tenant-a-oauth-attempt-9`;
  await assert.rejects(consumeOAuthAttempt(identity(), { attemptReference: smuggled, state: "whatever" }, { secrets }), invalid);
  assert.equal(secrets.entries.size, 1, "the victim's attempt must survive the attempted smuggling read");
  assert.equal(await discardOAuthAttempt(identity(), smuggled, { secrets }), undefined);
  assert.equal(secrets.entries.size, 1, "and the attempted smuggling discard");
});

test("a declined attempt is destroyed whatever the store does, and only inside the caller's tenant", async () => {
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

test("a declined attempt reports only which provider (and connection) it was for, and nothing at all for one that is not this administrator's", async () => {
  const secrets = new FakeSecrets();
  const plain = await startOAuthAttempt(identity(), { providerKey: "acme", connectionLabel: "Room", client, redirectUri: "https://app.test/" }, { secrets });
  assert.deepEqual(await discardOAuthAttempt(identity(), plain.attemptReference, { secrets }), { providerKey: "acme" });
  assert.equal(secrets.entries.size, 0);

  const renewal = await startOAuthAttempt(identity(), { providerKey: "acme", connectionLabel: "Room", client, redirectUri: "https://app.test/", reauthorizeConnectionId: "conn-1" }, { secrets });
  assert.deepEqual(await discardOAuthAttempt(identity(), renewal.attemptReference, { secrets }), { providerKey: "acme", reauthorizeConnectionId: "conn-1" });

  const foreign = await startOAuthAttempt(identity(), { providerKey: "acme", connectionLabel: "Room", client, redirectUri: "https://app.test/" }, { secrets });
  assert.equal(await discardOAuthAttempt(identity({ subject: "admin-2" }), foreign.attemptReference, { secrets }), undefined, "another administrator's attempt is destroyed but not reported");
  assert.equal(secrets.entries.size, 0);
  assert.equal(await discardOAuthAttempt(identity(), foreign.attemptReference, { secrets }), undefined, "an attempt that is already gone");

  const junk = await secrets.write("tenant-a", "oauth-attempt", { kind: "something_else" });
  assert.equal(await discardOAuthAttempt(identity(), junk, { secrets }), undefined);
  assert.equal(secrets.entries.size, 0);
});

test("an attempt that renews a connection carries its id to the completion, and only as a string", async () => {
  const secrets = new FakeSecrets();
  const started = await startOAuthAttempt(identity(), { providerKey: "acme", connectionLabel: "Room", client, redirectUri: "https://app.test/", reauthorizeConnectionId: "conn-1" }, { secrets });
  const consumed = await consumeOAuthAttempt(identity(), { attemptReference: started.attemptReference, state: lastAuthorization!.state }, { secrets });
  assert.equal(consumed.reauthorizeConnectionId, "conn-1");

  const plain = await startOAuthAttempt(identity(), { providerKey: "acme", connectionLabel: "Room", client, redirectUri: "https://app.test/" }, { secrets });
  assert.equal("reauthorizeConnectionId" in await consumeOAuthAttempt(identity(), { attemptReference: plain.attemptReference, state: lastAuthorization!.state }, { secrets }), false);

  const forged = await startOAuthAttempt(identity(), { providerKey: "acme", connectionLabel: "Room", client, redirectUri: "https://app.test/" }, { secrets });
  const stored = secrets.entries.get(forged.attemptReference)!;
  stored.reauthorizeConnectionId = 5;
  await assert.rejects(consumeOAuthAttempt(identity(), { attemptReference: forged.attemptReference, state: lastAuthorization!.state }, { secrets }), invalid);
});

const T0 = 1_000_000_000_000;
const refreshing = (impl: SourceOAuthClient["refresh"]): SourceOAuthClient => ({ ...client, ...(impl ? { refresh: impl } : {}) });

test("a credential with no expiry, or with time left beyond the skew, is used as it is and never refreshed", async () => {
  const never = refreshing(async () => { throw new Error("must not refresh"); });
  for (const credential of [{ accessToken: "a" }, { accessToken: "a", expiresAt: "soon" }, { accessToken: "a", refreshToken: "r", expiresAt: T0 + (OAUTH_EXPIRY_SKEW_SECONDS + 1) * 1000 }]) {
    const fresh = await freshOAuthCredential(credential, never, () => T0);
    assert.deepEqual(fresh, { credential, refreshed: false });
  }
});

test("an expired or expiring credential is refreshed through the provider and keeps its refresh token unless the provider rotates it", async () => {
  const expiring = { accessToken: "old", refreshToken: "r1", expiresAt: T0 + 5_000 };
  const kept = await freshOAuthCredential(expiring, refreshing(async ({ refreshToken }) => { assert.equal(refreshToken, "r1"); return { accessToken: "new", expiresAt: T0 + 3_600_000 }; }), () => T0);
  assert.deepEqual(kept, { credential: { accessToken: "new", expiresAt: T0 + 3_600_000, refreshToken: "r1" }, refreshed: true });

  const rotated = await freshOAuthCredential({ ...expiring, expiresAt: T0 - 1 }, refreshing(async () => ({ accessToken: "new", refreshToken: "r2" })), () => T0);
  assert.equal(rotated.credential.refreshToken, "r2");
  const blank = await freshOAuthCredential(expiring, refreshing(async () => ({ accessToken: "new", refreshToken: "" })), () => T0);
  assert.equal(blank.credential.refreshToken, "r1", "an empty rotated token is not a rotation");
});

test("a refresh the provider refuses is harmless while the credential still has time left, and fatal once it has expired", async () => {
  const refused = refreshing(async () => { throw new Error("invalid_grant"); });
  const expiring = { accessToken: "old", refreshToken: "r1", expiresAt: T0 + 5_000 };
  assert.deepEqual(await freshOAuthCredential(expiring, refused, () => T0), { credential: expiring, refreshed: false });

  const expired = { ...expiring, expiresAt: T0 - 1 };
  await assert.rejects(freshOAuthCredential(expired, refused, () => T0), (error: unknown) => error instanceof OAuthCredentialExpiredError && error.connectorErrorClass === "reauthorization" && error.name === "OAuthCredentialExpiredError");
  // Nothing to refresh with: no client, a client without refresh, no refresh token, or an empty one.
  await assert.rejects(freshOAuthCredential(expired, undefined, () => T0), OAuthCredentialExpiredError);
  await assert.rejects(freshOAuthCredential(expired, refreshing(undefined), () => T0), OAuthCredentialExpiredError);
  await assert.rejects(freshOAuthCredential({ accessToken: "a", expiresAt: T0 - 1 }, refused, () => T0), OAuthCredentialExpiredError);
  await assert.rejects(freshOAuthCredential({ accessToken: "a", refreshToken: "", expiresAt: T0 - 1 }, refused, () => T0), OAuthCredentialExpiredError);
  assert.deepEqual(await freshOAuthCredential({ accessToken: "a", expiresAt: T0 + 5_000 }, undefined, () => T0), { credential: { accessToken: "a", expiresAt: T0 + 5_000 }, refreshed: false });
});

test("freshOAuthCredential reads the real clock when none is supplied", async () => {
  assert.equal((await freshOAuthCredential({ accessToken: "a", expiresAt: Date.now() + 3_600_000 }, undefined)).refreshed, false);
  await assert.rejects(freshOAuthCredential({ accessToken: "a", expiresAt: Date.now() - 3_600_000 }, undefined), OAuthCredentialExpiredError);
});
