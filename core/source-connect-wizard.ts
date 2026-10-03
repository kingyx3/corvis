/**
 * The "Connect source" setup flow (story B1): what an approved provider looks
 * like to the browser, and the plain-language copy and input rules the wizard
 * follows. Everything here is pure, so the server registry
 * (lib/server/source-providers.ts) and the UI (features/documents/connect-source-wizard.tsx)
 * share one vocabulary and one set of rules, and it is unit-tested without a browser.
 *
 * A provider descriptor carries no credential, no URL and no server identifier
 * beyond its key: it is exactly what an administrator is shown before anything
 * is authorized.
 */
import {
  CONNECTOR_ERROR_COPY,
  buildCredentialSecret,
  type SecretBuildResult,
  type SourceConnectorErrorClass,
} from "./source-connection-health.ts";

export type ProviderScopeItem = { label: string; path?: string };

/** How an administrator authorizes the provider: a redirect through the provider's consent page, or a minimum credential typed once. */
export type ProviderConnect =
  | { method: "oauth" }
  | { method: "credential"; credentialType: "scoped_api_token" | "service_account" | "browser_session" };

/** Everything the wizard may show about an approved provider before authorization. */
export type SourceProviderDescriptor = {
  providerKey: string;
  displayName: string;
  /** One line: what Corvis can access at this provider. Shown in the provider list. */
  summary: string;
  /** True for the in-product demonstration provider, which never contacts a real portal. */
  demo: boolean;
  connect: ProviderConnect;
  /** The source scope Corvis is confirmed to read; recorded with the connection when it is created. */
  scope: ProviderScopeItem[];
  /** Plain-language disclosure of what the connection does, in three fixed groups. */
  disclosure: { reads: string[]; behaviour: string[]; limits: string[] };
  /** Optional extra guidance shown beside the credential field. */
  credentialHint?: string;
};

export const MAX_CONNECTION_NAME_LENGTH = 200;

export const CONNECT_CONFIRMATION_LABEL = "I am authorized to give Corvis access to this source, and I confirm the access described above.";
export const CONNECT_CONFIRMATION_REQUIRED = "Confirm that you are authorized and agree to the access described above before continuing.";

export type NameResult = { ok: true; name: string } | { ok: false; error: string };

/** The connection name an administrator will recognise in the list; never blank and bounded like the server's check. */
export function validateConnectionName(raw: string): NameResult {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Enter a name for this connection." };
  if (name.length > MAX_CONNECTION_NAME_LENGTH) return { ok: false, error: `Use ${MAX_CONNECTION_NAME_LENGTH} characters or fewer for the connection name.` };
  return { ok: true, name };
}

/** How the credential for a directly entered provider is collected. */
export type ConnectCredentialField = { kind: "token" | "json"; label: string; hint: string };

export function connectCredentialField(credentialType: "scoped_api_token" | "service_account" | "browser_session"): ConnectCredentialField {
  const sentence = "It is sent once, stored only in Corvis's secret store, never shown again and never kept in your browser.";
  if (credentialType === "service_account") return { kind: "json", label: "Service account key (JSON)", hint: `Paste the full JSON key. ${sentence}` };
  if (credentialType === "browser_session") return { kind: "token", label: "Session token", hint: `Paste the session token the provider issued. ${sentence}` };
  return { kind: "token", label: "API token", hint: `Paste the token the provider issued. ${sentence}` };
}

/** The `secret` body sent to the server for a typed credential. Error text never repeats what was typed. */
export function buildConnectSecret(credentialType: "scoped_api_token" | "service_account" | "browser_session", raw: string): SecretBuildResult {
  return buildCredentialSecret(credentialType, raw, "Enter the credential to continue.");
}

const GENERIC_TEST_FAILURE = "The provider did not accept the test, so Corvis could not confirm the connection.";

export type TestFailureText = { reason: string; nextStep: string };

/**
 * The plain-language reason a connectivity test did not pass and the one next
 * step. An unknown class, or none at all, gets a generic reason rather than a
 * stored code; the connection is never described as working.
 */
export function describeTestFailure(errorClass: string | undefined): TestFailureText {
  const known = errorClass !== undefined && Object.prototype.hasOwnProperty.call(CONNECTOR_ERROR_COPY, errorClass)
    ? CONNECTOR_ERROR_COPY[errorClass as SourceConnectorErrorClass]
    : undefined;
  if (!known) return { reason: GENERIC_TEST_FAILURE, nextStep: "Test again in a few minutes. If it keeps failing, contact Corvis support and mention this connection's name." };
  const kind = known.action.kind;
  if (kind === "reauthorize") return { reason: known.summary, nextStep: "Close this dialog and use Reauthorize on the connection to provide a new credential, then test again." };
  if (kind === "wait") return { reason: known.summary, nextStep: "This is usually temporary. Test again in a few minutes." };
  return { reason: known.summary, nextStep: "Contact Corvis support and mention this connection's name." };
}

export const TEST_FAILURE_CONSEQUENCE = "Scheduled collection stays off for this connection until a test passes. Nothing is collected in the meantime.";

/** Plain-language outcome of a connection test run on demand from the connection list. */
export function describeOnDemandTest(label: string, result: { ok: boolean; errorClass?: string }): { tone: "success" | "error"; text: string } {
  if (result.ok) return { tone: "success", text: `${label}: the connection test passed. Corvis can reach the provider with the access you confirmed.` };
  const failure = describeTestFailure(result.errorClass);
  return { tone: "error", text: `${label}: the connection test did not pass. ${failure.reason} ${failure.nextStep}` };
}

/** Plain-language reason a connect request was refused, by HTTP status. Never echoes server codes or request content. */
export function connectFailureMessage(status: number | undefined): string {
  if (status === 403) return "You do not have permission to connect sources.";
  if (status === 409) return "This workspace is already connected to this source. Use Test connection or Reauthorize on the existing connection, or revoke it first to connect again.";
  if (status === 429) return "Too many connection attempts in a short time. Wait a few minutes and try again.";
  if (status === 404 || status === 422) return "This source is no longer available to connect. Close this dialog and choose again.";
  if (status === 400) return "The request was not accepted. Check what you entered and try again.";
  return "The connection could not be created. Nothing was saved; try again.";
}

// ---------------------------------------------------------------------------
// The redirect back from a provider's consent page
// ---------------------------------------------------------------------------

/** Marks the app URL a provider redirects back to; the wizard resumes only when it is present. */
export const OAUTH_RETURN_MARKER = "source_oauth";
export const OAUTH_RETURN_QUERY_KEYS = [OAUTH_RETURN_MARKER, "code", "state", "error", "error_description", "iss"] as const;

export type OAuthReturn =
  | { kind: "none" }
  /** The administrator declined, or the provider refused: nothing was authorized. */
  | { kind: "denied" }
  /** A response the wizard cannot use (no code or no state): treated as a failed attempt, never retried silently. */
  | { kind: "invalid" }
  | { kind: "callback"; code: string; state: string };

/** Reads a provider redirect from a URL query string. Only a URL carrying the return marker is ever interpreted. */
export function parseOAuthReturn(search: string): OAuthReturn {
  const params = new URLSearchParams(search);
  if (!params.has(OAUTH_RETURN_MARKER)) return { kind: "none" };
  if (params.has("error")) return { kind: "denied" };
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return { kind: "invalid" };
  return { kind: "callback", code, state };
}

/** The same URL query without the redirect parameters, so a reload or a shared link never replays a one-time code. */
export function withoutOAuthReturn(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of OAUTH_RETURN_QUERY_KEYS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export const OAUTH_ATTEMPT_UNUSABLE = "This sign-in attempt can no longer be used. It may have expired, been used already, or been started in another browser. Nothing was connected or changed.";
export const OAUTH_DENIED = "Access was not approved at the provider, so nothing was connected or changed and nothing was stored.";

/** Shown while the wizard exchanges the one-time code. */
export const OAUTH_COMPLETING = "Finishing the sign-in and testing the connection.";
