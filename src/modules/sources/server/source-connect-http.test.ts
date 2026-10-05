import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { DEMO_OAUTH_PROVIDER_KEY, DEMO_TOKEN_PROVIDER_KEY } from "../adapters/source-providers.ts";
import { oauthRedirectUri, parseConnectRequest, parseOAuthStartRequest, parseSecret, redactedConnection, usesSecureCookies } from "./source-connect-http.ts";
import type { SourceConnection } from "./source-connectors.ts";

const originalDemo = process.env.CORVIS_DEMO_MODE;
const originalPublic = process.env.CORVIS_PUBLIC_APP_URL;
afterEach(() => {
  if (originalDemo === undefined) delete process.env.CORVIS_DEMO_MODE; else process.env.CORVIS_DEMO_MODE = originalDemo;
  if (originalPublic === undefined) delete process.env.CORVIS_PUBLIC_APP_URL; else process.env.CORVIS_PUBLIC_APP_URL = originalPublic;
});

const refused = (code: string) => (error: unknown) => error instanceof Error && error.message === code;

test("the customer-facing connection never carries the secret reference", () => {
  const connection = { sourceConnectionId: "c", secretReference: "projects/p/secrets/x", connectionLabel: "L" } as SourceConnection;
  const shown = redactedConnection(connection);
  assert.deepEqual(shown, { sourceConnectionId: "c", connectionLabel: "L" });
});

test("the redirect URI is the configured public app URL, else the request's own origin, with the return marker", () => {
  delete process.env.CORVIS_PUBLIC_APP_URL;
  const request = new Request("http://internal.test:3000/api/v1/source-connections/oauth/start", { method: "POST" });
  assert.equal(oauthRedirectUri(request), "http://internal.test:3000/?source_oauth=return");
  assert.equal(usesSecureCookies(request), false);
  process.env.CORVIS_PUBLIC_APP_URL = "https://app.corvis.test";
  assert.equal(oauthRedirectUri(request), "https://app.corvis.test/?source_oauth=return");
  assert.equal(usesSecureCookies(request), true);
});

test("a connect request needs a provider, a name, the confirmation and an approved provider of the matching method", () => {
  process.env.CORVIS_DEMO_MODE = "true";
  const body = (overrides: Record<string, unknown> = {}) => ({ providerKey: DEMO_TOKEN_PROVIDER_KEY, connectionLabel: "  Our portal  ", scopeConfirmed: true, ...overrides });

  const { parsed, object } = parseConnectRequest(body({ secret: { token: "t" } }), "credential");
  assert.equal(parsed.provider.providerKey, DEMO_TOKEN_PROVIDER_KEY);
  assert.equal(parsed.connectionLabel, "Our portal");
  assert.deepEqual(object.secret, { token: "t" });
  assert.equal(parseConnectRequest(body({ providerKey: DEMO_OAUTH_PROVIDER_KEY }), "oauth").parsed.provider.connect.method, "oauth");

  for (const bad of [null, [], "x", 3]) assert.throws(() => parseConnectRequest(bad, "credential"), refused("invalid_request"));
  assert.throws(() => parseConnectRequest(body({ providerKey: "" }), "credential"), refused("provider_key_required"));
  assert.throws(() => parseConnectRequest(body({ providerKey: 7 }), "credential"), refused("provider_key_required"));
  assert.throws(() => parseConnectRequest(body({ connectionLabel: "   " }), "credential"), refused("connection_label_required"));
  assert.throws(() => parseConnectRequest(body({ connectionLabel: 5 }), "credential"), refused("connection_label_required"));
  assert.throws(() => parseConnectRequest(body({ connectionLabel: "x".repeat(201) }), "credential"), refused("connection_label_too_long"));
  assert.throws(() => parseConnectRequest(body({ scopeConfirmed: false }), "credential"), refused("source_scope_confirmation_required"));
  assert.throws(() => parseConnectRequest(body({ scopeConfirmed: "true" }), "credential"), refused("source_scope_confirmation_required"));
  assert.throws(() => parseConnectRequest(body({ providerKey: "not-approved" }), "credential"), refused("unregistered_provider"));
  assert.throws(() => parseConnectRequest(body(), "oauth"), refused("unregistered_provider"), "a credential provider cannot be connected through the OAuth flow");
  assert.throws(() => parseConnectRequest(body({ providerKey: DEMO_OAUTH_PROVIDER_KEY }), "credential"), refused("unregistered_provider"));
  delete process.env.CORVIS_DEMO_MODE;
  assert.throws(() => parseConnectRequest(body(), "credential"), refused("unregistered_provider"), "outside demo mode the demo providers are not approved");
});

test("a typed secret must be a non-empty object", () => {
  assert.deepEqual(parseSecret({ token: "t" }), { token: "t" });
  for (const bad of [undefined, null, [], "x", {}]) assert.throws(() => parseSecret(bad), refused("secret_required"));
});

test("an OAuth start is either a new connection (the connect body) or the renewal of one connection (only its id)", () => {
  process.env.CORVIS_DEMO_MODE = "true";
  const id = "00000000-0000-4000-8000-00000000d005";
  assert.deepEqual(parseOAuthStartRequest({ sourceConnectionId: id }), { kind: "reauthorize", sourceConnectionId: id });
  const created = parseOAuthStartRequest({ providerKey: DEMO_OAUTH_PROVIDER_KEY, connectionLabel: " Room ", scopeConfirmed: true });
  assert.equal(created.kind, "connect");
  assert.equal(created.kind === "connect" && created.parsed.connectionLabel, "Room");

  for (const bad of [null, [], "x"]) assert.throws(() => parseOAuthStartRequest(bad), refused("invalid_request"));
  assert.throws(() => parseOAuthStartRequest({ sourceConnectionId: 7 }), refused("invalid_request"));
  assert.throws(() => parseOAuthStartRequest({ sourceConnectionId: "not-a-uuid" }), refused("connection_not_found"), "an id that cannot name a connection is a not-found, never a database error");
  assert.throws(() => parseOAuthStartRequest({ providerKey: DEMO_TOKEN_PROVIDER_KEY, connectionLabel: "X", scopeConfirmed: true }), refused("unregistered_provider"));
});

test("a connect request may narrow the provider's folders, checked against the registry, and the choice is carried for an OAuth redirect", () => {
  process.env.CORVIS_DEMO_MODE = "true";
  const body = (overrides: Record<string, unknown> = {}) => ({ providerKey: DEMO_TOKEN_PROVIDER_KEY, connectionLabel: "Our portal", scopeConfirmed: true, ...overrides });

  const whole = parseConnectRequest(body(), "credential").parsed;
  assert.deepEqual(whole.scope, [{ label: "Quarterly reports", path: "/Fund III/Quarterly" }, { label: "Capital account statements", path: "/Fund III/Capital accounts" }]);
  assert.equal(whole.scopeIds, undefined);

  const narrowed = parseConnectRequest(body({ selectedScopeIds: ["capital-accounts"] }), "credential").parsed;
  assert.deepEqual(narrowed.scope, [{ label: "Capital account statements", path: "/Fund III/Capital accounts" }]);
  assert.deepEqual(narrowed.scopeIds, ["capital-accounts"]);

  for (const bad of [[], ["nope"], ["capital-accounts", "capital-accounts"], "capital-accounts", [3]]) {
    assert.throws(() => parseConnectRequest(body({ selectedScopeIds: bad }), "credential"), refused("invalid_scope_selection"));
  }
  const started = parseOAuthStartRequest({ providerKey: DEMO_OAUTH_PROVIDER_KEY, connectionLabel: "Room", scopeConfirmed: true, selectedScopeIds: ["side-letters"] });
  assert.deepEqual(started.kind === "connect" && started.parsed.scopeIds, ["side-letters"]);
});
