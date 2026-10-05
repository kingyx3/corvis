import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { DEMO_OAUTH_PROVIDER_KEY, DEMO_TOKEN_PROVIDER_KEY } from "../adapters/source-providers.ts";
import { sourceConnectorDrivers } from "./source-connector-runtime.ts";
import type { ConnectorDriver } from "./source-connectors.ts";
import {
  approvedSourceProvider,
  approvedSourceProviders,
  credentialTypeOf,
  oauthProviderForConnection,
  providerDescriptor,
  registerApprovedSourceProvider,
  resolveScopeSelection,
  unregisterApprovedSourceProvider,
  type ApprovedSourceProvider,
} from "./source-providers.ts";

const originalDemo = process.env.CORVIS_DEMO_MODE;
afterEach(() => {
  if (originalDemo === undefined) delete process.env.CORVIS_DEMO_MODE; else process.env.CORVIS_DEMO_MODE = originalDemo;
  unregisterApprovedSourceProvider("acme-portal");
});

function driver(providerKey = "acme-portal"): ConnectorDriver {
  return { providerKey, connectorVersion: "1.0.0", testConnection: async () => ({ ok: true }), discover: async () => [], download: async () => ({ bytes: Buffer.alloc(0), contentType: "application/pdf" }) };
}

function provider(overrides: Partial<ApprovedSourceProvider> = {}): ApprovedSourceProvider {
  return {
    providerKey: "acme-portal", displayName: "Acme portal", summary: "Reads quarterly reports.", demo: false,
    connect: { method: "credential", credentialType: "scoped_api_token" },
    scope: [{ label: "Quarterly reports", path: "/q" }, { label: "Statements" }],
    disclosure: { reads: ["Reports."], behaviour: ["Daily."], limits: ["Read only."] },
    connectorVersion: "1.0.0",
    ...overrides,
  };
}

test("with nothing certified and no demo mode the registry is honestly empty", () => {
  delete process.env.CORVIS_DEMO_MODE;
  assert.deepEqual(approvedSourceProviders(), []);
  assert.equal(approvedSourceProvider("acme-portal"), undefined);
});

test("demo mode adds only the clearly labelled demo providers, and they never carry a driver", () => {
  process.env.CORVIS_DEMO_MODE = "true";
  const keys = approvedSourceProviders().map((entry) => entry.providerKey);
  assert.deepEqual(keys, [DEMO_OAUTH_PROVIDER_KEY, DEMO_TOKEN_PROVIDER_KEY]);
  assert.ok(approvedSourceProviders().every((entry) => entry.demo && /demo/i.test(entry.displayName) && /demonstration only/i.test(entry.summary)));
  assert.equal(sourceConnectorDrivers().has(DEMO_OAUTH_PROVIDER_KEY), false);
  assert.equal(sourceConnectorDrivers().has(DEMO_TOKEN_PROVIDER_KEY), false);
  assert.equal(approvedSourceProvider(DEMO_TOKEN_PROVIDER_KEY)?.providerKey, DEMO_TOKEN_PROVIDER_KEY);
});

test("registering a certified provider approves it together with its driver, and unregistering removes both", () => {
  delete process.env.CORVIS_DEMO_MODE;
  registerApprovedSourceProvider(provider(), driver());
  assert.deepEqual(approvedSourceProviders().map((entry) => entry.providerKey), ["acme-portal"]);
  assert.ok(sourceConnectorDrivers().has("acme-portal"));
  unregisterApprovedSourceProvider("acme-portal");
  assert.deepEqual(approvedSourceProviders(), []);
  assert.equal(sourceConnectorDrivers().has("acme-portal"), false);
});

test("an inconsistent approval is refused so a provider is never offered without the means to test it", () => {
  const oauthClient = { authorizationUrl: () => "x", exchangeCode: async () => ({}) };
  assert.throws(() => registerApprovedSourceProvider(provider({ providerKey: "A" }), driver("A")), /key is invalid/);
  assert.throws(() => registerApprovedSourceProvider(provider(), driver("other-portal")), /share a provider key/);
  assert.throws(() => registerApprovedSourceProvider(provider({ connect: { method: "oauth" } }), driver()), /needs an OAuth client/);
  assert.throws(() => registerApprovedSourceProvider(provider({ oauth: oauthClient }), driver()), /only an OAuth provider may have one/);
  assert.throws(() => registerApprovedSourceProvider(provider({ scope: [] }), driver()), /declare the scope/);
  assert.deepEqual(approvedSourceProviders().map((entry) => entry.providerKey).filter((key) => key === "acme-portal"), []);
  registerApprovedSourceProvider(provider({ connect: { method: "oauth" }, oauth: oauthClient }), driver());
  assert.equal(credentialTypeOf(approvedSourceProvider("acme-portal")!), "oauth_authorization_code");
});

test("the browser-safe descriptor is an explicit copy: no OAuth client, no connector version, no shared references", () => {
  const original = provider({ connect: { method: "oauth" }, oauth: { authorizationUrl: () => "https://secret.example", exchangeCode: async () => ({}) }, credentialHint: "Hint." });
  const descriptor = providerDescriptor(original);
  assert.deepEqual(Object.keys(descriptor).sort(), ["connect", "credentialHint", "demo", "disclosure", "displayName", "providerKey", "scope", "summary"]);
  assert.deepEqual(descriptor.connect, { method: "oauth" });
  assert.deepEqual(descriptor.scope, [{ label: "Quarterly reports", path: "/q" }, { label: "Statements" }]);
  assert.notEqual(descriptor.disclosure.reads, original.disclosure.reads);
  assert.doesNotMatch(JSON.stringify(descriptor), /secret\.example|connectorVersion|oauth":/);

  const direct = providerDescriptor(provider());
  assert.deepEqual(direct.connect, { method: "credential", credentialType: "scoped_api_token" });
  assert.equal("credentialHint" in direct, false);
  assert.equal(credentialTypeOf(provider({ connect: { method: "credential", credentialType: "service_account" } })), "service_account");
});

test("the provider that renews a connection's authorization is the approved OAuth provider, and in demo mode also the demo one for seeded connections", () => {
  const oauth = { authorizationUrl: () => "https://consent.example", exchangeCode: async () => ({}) };
  delete process.env.CORVIS_DEMO_MODE;
  assert.equal(oauthProviderForConnection("acme-portal"), undefined, "an unknown provider has nothing to renew it");
  assert.equal(oauthProviderForConnection("demo-vdr"), undefined, "the demo alias exists only in demo mode");
  registerApprovedSourceProvider(provider(), driver());
  assert.equal(oauthProviderForConnection("acme-portal"), undefined, "a provider that connects with a credential has no sign-in to renew");
  unregisterApprovedSourceProvider("acme-portal");
  registerApprovedSourceProvider(provider({ connect: { method: "oauth" }, oauth }), driver());
  assert.equal(oauthProviderForConnection("acme-portal")?.oauth, oauth);

  process.env.CORVIS_DEMO_MODE = "true";
  assert.equal(oauthProviderForConnection(DEMO_OAUTH_PROVIDER_KEY)?.providerKey, DEMO_OAUTH_PROVIDER_KEY);
  assert.equal(oauthProviderForConnection("demo-vdr")?.providerKey, DEMO_OAUTH_PROVIDER_KEY, "a seeded demo OAuth connection is renewed through the demo provider");
  assert.equal(oauthProviderForConnection(DEMO_TOKEN_PROVIDER_KEY), undefined);
  assert.equal(oauthProviderForConnection("acme-portal")?.oauth, oauth, "approved providers are still found in demo mode");
});

test("the approvals live on globalThis, so next dev evaluating this module again keeps them", () => {
  delete process.env.CORVIS_DEMO_MODE;
  const shared = globalThis as typeof globalThis & { approvedSourceProviders?: Map<string, ApprovedSourceProvider> };
  registerApprovedSourceProvider(provider(), driver());
  assert.equal(shared.approvedSourceProviders?.get("acme-portal")?.providerKey, "acme-portal");
});

const CHOICE_SCOPE = [{ id: "q", label: "Quarterly reports", path: "/q" }, { id: "s", label: "Statements" }, { id: "l", label: "Side letters", path: "/l" }];

test("a provider's folder ids reach the browser descriptor, and nothing else server-side does", () => {
  const described = providerDescriptor(provider({ scope: CHOICE_SCOPE }));
  assert.deepEqual(described.scope, CHOICE_SCOPE);
  assert.deepEqual(providerDescriptor(provider()).scope, [{ label: "Quarterly reports", path: "/q" }, { label: "Statements" }], "no id is invented for a provider that declares none");
});

test("no selection means the provider's whole declared scope, stored without the provider's internal ids", () => {
  assert.deepEqual(resolveScopeSelection(provider({ scope: CHOICE_SCOPE }), undefined), [{ label: "Quarterly reports", path: "/q" }, { label: "Statements" }, { label: "Side letters", path: "/l" }]);
  assert.deepEqual(resolveScopeSelection(provider(), undefined), [{ label: "Quarterly reports", path: "/q" }, { label: "Statements" }]);
});

test("a selection can only narrow what the provider declares, in the provider's order, and is never trusted as sent", () => {
  const choice = provider({ scope: CHOICE_SCOPE });
  assert.deepEqual(resolveScopeSelection(choice, ["l", "q"]), [{ label: "Quarterly reports", path: "/q" }, { label: "Side letters", path: "/l" }]);
  assert.deepEqual(resolveScopeSelection(choice, ["s"]), [{ label: "Statements" }]);
  const refused = (error: unknown) => error instanceof Error && error.message === "invalid_scope_selection";
  assert.throws(() => resolveScopeSelection(choice, []), refused, "nothing selected is not a scope");
  assert.throws(() => resolveScopeSelection(choice, ["q", "q"]), refused, "duplicates");
  assert.throws(() => resolveScopeSelection(choice, ["q", "/etc"]), refused, "an id the provider never declared cannot add a path");
  assert.throws(() => resolveScopeSelection(choice, "q"), refused, "not a list");
  assert.throws(() => resolveScopeSelection(choice, [1]), refused, "not strings");
  assert.throws(() => resolveScopeSelection(choice, null), refused);
  assert.throws(() => resolveScopeSelection(provider(), ["q"]), refused, "a provider that declares no choice refuses any selection");
  assert.throws(() => resolveScopeSelection(provider({ scope: [{ id: "only", label: "One folder" }] }), ["only"]), refused, "one folder is not a choice");
});
