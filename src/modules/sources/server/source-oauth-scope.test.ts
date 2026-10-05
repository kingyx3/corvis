import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { sourceConnectorSecretReference } from "./source-connector-runtime.ts";
import type { SecretPayload, SecretStore } from "./source-connectors.ts";
import { consumeOAuthAttempt, startOAuthAttempt, type SourceOAuthClient } from "./source-oauth.ts";

class FakeSecrets implements SecretStore {
  readonly entries = new Map<string, SecretPayload>();
  private counter = 0;
  async write(tenantId: string, providerKey: string, secret: SecretPayload): Promise<string> {
    const reference = sourceConnectorSecretReference(tenantId, providerKey, ++this.counter);
    this.entries.set(reference, structuredClone(secret));
    return reference;
  }
  async read(reference: string): Promise<SecretPayload> {
    if (!this.entries.has(reference)) throw new Error("secret_reference_not_found");
    return this.entries.get(reference)!;
  }
  async revoke(reference: string): Promise<void> { this.entries.delete(reference); }
}

const admin = { subject: "admin-1", tenantId: "tenant-a", workspaceId: "workspace-1", roles: ["admin"], entitlements: { workspaceIds: ["workspace-1"] }, authMethod: "demo", sessionId: "s" } as RequestIdentity;

let lastState = "";
const client: SourceOAuthClient = {
  authorizationUrl(input) { lastState = input.state; return `https://provider.test/consent?state=${input.state}`; },
  async exchangeCode() { return { accessToken: "x" }; },
};

async function start(secrets: FakeSecrets, scopeIds?: string[]) {
  const started = await startOAuthAttempt(admin, { providerKey: "acme-oauth", connectionLabel: "Acme", client, redirectUri: "https://app.test/?source_oauth=return", ...(scopeIds ? { scopeIds } : {}) }, { secrets });
  return { reference: started.attemptReference, state: lastState };
}

const invalid = (error: unknown) => error instanceof Error && error.message === "oauth_attempt_invalid";

test("the folders chosen before the sign-in travel with the pending attempt and come back with it", async () => {
  const secrets = new FakeSecrets();
  const chosen = await start(secrets, ["q", "l"]);
  assert.deepEqual(secrets.entries.get(chosen.reference)!.scopeIds, ["q", "l"]);
  const consumed = await consumeOAuthAttempt(admin, { attemptReference: chosen.reference, state: chosen.state }, { secrets });
  assert.deepEqual(consumed.scopeIds, ["q", "l"]);

  const plain = await start(secrets);
  assert.equal(secrets.entries.get(plain.reference)!.scopeIds, undefined, "no selection is stored as none");
  assert.equal((await consumeOAuthAttempt(admin, { attemptReference: plain.reference, state: plain.state }, { secrets })).scopeIds, undefined);
});

test("a pending attempt whose stored folder choice is malformed is refused like any other tampered attempt", async () => {
  const secrets = new FakeSecrets();
  const list = await start(secrets);
  secrets.entries.get(list.reference)!.scopeIds = [7];
  await assert.rejects(consumeOAuthAttempt(admin, { attemptReference: list.reference, state: list.state }, { secrets }), invalid);
  const text = await start(secrets);
  secrets.entries.get(text.reference)!.scopeIds = "q";
  await assert.rejects(consumeOAuthAttempt(admin, { attemptReference: text.reference, state: text.state }, { secrets }), invalid);
});
