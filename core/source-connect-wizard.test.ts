import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_ERROR_CLASSES,
  buildCredentialSecret,
  buildReauthorizeSecret,
} from "./source-connection-health.ts";
import {
  MAX_CONNECTION_NAME_LENGTH,
  OAUTH_RETURN_MARKER,
  buildConnectSecret,
  connectCredentialField,
  connectFailureMessage,
  describeOnDemandTest,
  describeTestFailure,
  parseOAuthReturn,
  validateConnectionName,
  withoutOAuthReturn,
} from "./source-connect-wizard.ts";

test("a connection name is trimmed, required and bounded like the server's check", () => {
  assert.deepEqual(validateConnectionName("  Meridian portal  "), { ok: true, name: "Meridian portal" });
  assert.deepEqual(validateConnectionName("   "), { ok: false, error: "Enter a name for this connection." });
  assert.equal(validateConnectionName("x".repeat(MAX_CONNECTION_NAME_LENGTH)).ok, true);
  const tooLong = validateConnectionName("x".repeat(MAX_CONNECTION_NAME_LENGTH + 1));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.ok ? "" : tooLong.error, /200 characters or fewer/);
});

test("each credential type collects its credential the way the provider issues it, and says it is never shown again", () => {
  const token = connectCredentialField("scoped_api_token");
  assert.equal(token.kind, "token");
  assert.equal(token.label, "API token");
  const session = connectCredentialField("browser_session");
  assert.equal(session.kind, "token");
  assert.equal(session.label, "Session token");
  const account = connectCredentialField("service_account");
  assert.equal(account.kind, "json");
  for (const field of [token, session, account]) assert.match(field.hint, /never shown again and never kept in your browser/);
});

test("a typed credential becomes the secret body; errors never repeat what was typed", () => {
  assert.deepEqual(buildConnectSecret("scoped_api_token", "  tok-123  "), { ok: true, secret: { token: "tok-123" } });
  assert.deepEqual(buildConnectSecret("browser_session", "sess"), { ok: true, secret: { token: "sess" } });
  assert.deepEqual(buildConnectSecret("scoped_api_token", "   "), { ok: false, error: "Enter the credential to continue." });
  assert.deepEqual(buildConnectSecret("service_account", '{"client_email":"a@b"}'), { ok: true, secret: { client_email: "a@b" } });
  const notJson = buildConnectSecret("service_account", "super-secret-not-json");
  assert.equal(notJson.ok, false);
  assert.doesNotMatch(JSON.stringify(notJson), /super-secret/);
  assert.equal(buildConnectSecret("service_account", "[1]").ok, false);
  assert.equal(buildConnectSecret("service_account", "null").ok, false);
});

test("reauthorization and the wizard share one credential rule and differ only in the empty-field wording", () => {
  assert.deepEqual(buildReauthorizeSecret("scoped_api_token", ""), { ok: false, error: "Enter the new credential." });
  assert.deepEqual(buildCredentialSecret("scoped_api_token", "", "custom"), { ok: false, error: "custom" });
  assert.equal(buildCredentialSecret("oauth_authorization_code", "x", "custom").ok, false, "an OAuth credential is never typed in");
});

test("every connector error class has a plain reason and one next step, and no stored code is shown", () => {
  for (const errorClass of CONNECTOR_ERROR_CLASSES) {
    const failure = describeTestFailure(errorClass);
    assert.ok(failure.reason.length > 20, errorClass);
    assert.ok(failure.nextStep.length > 20, errorClass);
    assert.doesNotMatch(`${failure.reason} ${failure.nextStep}`, new RegExp(`\\b${errorClass}\\b`.replace("_", "[_ ]")), `${errorClass} is a stored code`);
  }
  assert.match(describeTestFailure("auth").nextStep, /Reauthorize/);
  assert.match(describeTestFailure("permission").nextStep, /Reauthorize/);
  assert.match(describeTestFailure("network").nextStep, /Test again in a few minutes/);
  assert.match(describeTestFailure("provider_change").nextStep, /Contact Corvis support/);
});

test("an unknown or missing error class gets a generic reason instead of a code or a claim that it works", () => {
  for (const unknown of [undefined, "alien", "constructor", "__proto__"]) {
    const failure = describeTestFailure(unknown);
    assert.match(failure.reason, /could not confirm the connection/);
    assert.match(failure.nextStep, /contact Corvis support/);
  }
});

test("an on-demand test result reads as a sentence naming the connection", () => {
  assert.deepEqual(describeOnDemandTest("Atlas", { ok: true }), { tone: "success", text: "Atlas: the connection test passed. Corvis can reach the provider with the access you confirmed." });
  const failed = describeOnDemandTest("Atlas", { ok: false, errorClass: "network" });
  assert.equal(failed.tone, "error");
  assert.match(failed.text, /^Atlas: the connection test did not pass\. Corvis could not reach the provider/);
  assert.equal(describeOnDemandTest("Atlas", { ok: false }).tone, "error");
});

test("a refused connect is explained by status without echoing server codes", () => {
  assert.match(connectFailureMessage(403), /permission/);
  assert.match(connectFailureMessage(404), /no longer available/);
  assert.match(connectFailureMessage(422), /no longer available/);
  assert.match(connectFailureMessage(400), /not accepted/);
  assert.match(connectFailureMessage(500), /Nothing was saved/);
  assert.match(connectFailureMessage(undefined), /Nothing was saved/);
});

test("only a URL carrying the return marker is read as a provider redirect", () => {
  assert.deepEqual(parseOAuthReturn(""), { kind: "none" });
  assert.deepEqual(parseOAuthReturn("?code=abc&state=xyz"), { kind: "none" }, "a bare code in the URL is never interpreted");
  assert.deepEqual(parseOAuthReturn(`?${OAUTH_RETURN_MARKER}=return&code=abc&state=xyz`), { kind: "callback", code: "abc", state: "xyz" });
  assert.deepEqual(parseOAuthReturn(`?${OAUTH_RETURN_MARKER}=return&error=access_denied&state=xyz`), { kind: "denied" });
  assert.deepEqual(parseOAuthReturn(`?${OAUTH_RETURN_MARKER}=return&code=abc`), { kind: "invalid" });
  assert.deepEqual(parseOAuthReturn(`?${OAUTH_RETURN_MARKER}=return&state=xyz`), { kind: "invalid" });
  assert.deepEqual(parseOAuthReturn(`?${OAUTH_RETURN_MARKER}=return`), { kind: "invalid" });
});

test("the redirect parameters are removed from the URL while unrelated ones stay", () => {
  assert.equal(withoutOAuthReturn(`?${OAUTH_RETURN_MARKER}=return&code=abc&state=xyz&iss=https%3A%2F%2Fp`), "");
  assert.equal(withoutOAuthReturn(`?keep=1&${OAUTH_RETURN_MARKER}=return&error=access_denied&error_description=no`), "?keep=1");
  assert.equal(withoutOAuthReturn(""), "");
});
