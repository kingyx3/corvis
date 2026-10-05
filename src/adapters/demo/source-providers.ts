import { createHash } from "node:crypto";
import type { SourceProviderDescriptor } from "../../core/source-connect-wizard.ts";
import type { ConnectorErrorClass, SecretPayload } from "../../lib/server/source-connectors.ts";
import type { SourceOAuthClient } from "../../lib/server/source-oauth.ts";

/**
 * Demonstration providers for the "Connect source" flow, served only in demo
 * mode (production refuses `CORVIS_DEMO_MODE`). They exist so the whole flow
 * (provider choice, disclosure, confirmation, OAuth redirect and PKCE, direct
 * credential entry, the connectivity test and its failures) can be exercised
 * and tested end to end without any real portal. They contact nothing and
 * are labelled "Demo" everywhere a customer sees them. Their only driver is the
 * demonstration one in ./source-driver.ts (fixed demonstration PDFs, demo mode
 * only): a real driver is built against the first customer-required provider
 * (#31), not speculatively.
 */

export const DEMO_OAUTH_PROVIDER_KEY = "demo-oauth-data-room";
export const DEMO_TOKEN_PROVIDER_KEY = "demo-api-portal";

/** Credentials the demo API-token provider recognises, so each test outcome can be reached on purpose. */
export const DEMO_TOKENS = {
  valid: "demo-valid-token",
  invalid: "demo-invalid-token",
  noAccess: "demo-no-access",
  unreachable: "demo-unreachable",
} as const;

export const DEMO_OAUTH_ACCESS_TOKEN = "demo-oauth-access-token";
export const DEMO_OAUTH_REFRESH_TOKEN = "demo-oauth-refresh-token";
/** The demo provider's access tokens live this long, so the expiry and refresh path (src/lib/server/source-oauth.ts) is real here too. */
export const DEMO_OAUTH_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const DEMO_CODE_PREFIX = "demo-code.";

/** The path of the in-product stand-in for a provider's consent page (see src/app/api/v1/source-connections/oauth/demo-consent). */
export const DEMO_CONSENT_PATH = "/api/v1/source-connections/oauth/demo-consent";

const DEMO_VERSION = "demo-1";

/**
 * Seeded demo connections (src/adapters/demo/source-connection-store.ts) that sign in with OAuth under a key that is not the
 * demo OAuth provider's, mapped to the provider that renews them. They are not offered for connecting anew.
 */
export const DEMO_OAUTH_RENEWAL_ALIASES: Readonly<Record<string, string>> = { "demo-vdr": DEMO_OAUTH_PROVIDER_KEY };

export type DemoProvider = SourceProviderDescriptor & { connectorVersion: string; oauth?: SourceOAuthClient };

const demoOAuthClient: SourceOAuthClient = {
  authorizationUrl({ state, codeChallenge, redirectUri }) {
    return `${DEMO_CONSENT_PATH}?${new URLSearchParams({ state, code_challenge: codeChallenge, redirect_uri: redirectUri }).toString()}`;
  },
  async exchangeCode({ code, codeVerifier }) {
    // The demo consent page issues `demo-code.<challenge>`; accepting it only for the matching verifier proves PKCE end to end.
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    if (code !== `${DEMO_CODE_PREFIX}${challenge}`) throw new Error("invalid_grant");
    return { accessToken: DEMO_OAUTH_ACCESS_TOKEN, tokenType: "bearer", refreshToken: DEMO_OAUTH_REFRESH_TOKEN, expiresAt: Date.now() + DEMO_OAUTH_TOKEN_LIFETIME_MS };
  },
  async refresh({ refreshToken }) {
    // The demo provider honors exactly one refresh token, so a refused refresh can be reached on purpose.
    if (refreshToken !== DEMO_OAUTH_REFRESH_TOKEN) throw new Error("invalid_grant");
    return { accessToken: DEMO_OAUTH_ACCESS_TOKEN, tokenType: "bearer", expiresAt: Date.now() + DEMO_OAUTH_TOKEN_LIFETIME_MS };
  },
};

export const DEMO_SOURCE_PROVIDERS: readonly DemoProvider[] = [
  {
    providerKey: DEMO_OAUTH_PROVIDER_KEY,
    displayName: "Demo data room (sign-in with OAuth)",
    summary: "Demonstration only: reads the fund reports folder of a fictional data room after you approve access on its consent page.",
    demo: true,
    connect: { method: "oauth" },
    scope: [{ id: "fund-reports", label: "Demo fund reports", path: "/Demo/Fund reports" }, { id: "side-letters", label: "Demo side letters", path: "/Demo/Side letters" }],
    disclosure: {
      reads: ["Quarterly reports and capital account statements in the folders listed below. You can leave a folder out before you confirm.", "File names, dates and the files themselves, so they can enter the normal Corvis review process."],
      behaviour: ["You are sent to the provider's own page to approve access, then returned here.", "Corvis tests the connection straight away. Scheduled collection starts only after the test passes, and then repeats on a regular schedule.", "You can pause, reauthorize or revoke the connection at any time."],
      limits: ["Corvis never sees your provider password.", "Corvis cannot upload, change or delete anything at the provider.", "Nothing outside the folders you confirm is read."],
    },
    connectorVersion: DEMO_VERSION,
    oauth: demoOAuthClient,
  },
  {
    providerKey: DEMO_TOKEN_PROVIDER_KEY,
    displayName: "Demo GP portal (API token)",
    summary: "Demonstration only: reads quarterly reports from a fictional GP portal using an API token you paste once.",
    demo: true,
    connect: { method: "credential", credentialType: "scoped_api_token" },
    scope: [{ id: "quarterly-reports", label: "Quarterly reports", path: "/Fund III/Quarterly" }, { id: "capital-accounts", label: "Capital account statements", path: "/Fund III/Capital accounts" }],
    disclosure: {
      reads: ["Quarterly reports and capital account statements for Fund III. You can leave one of the two folders out before you confirm.", "File names, dates and the files themselves, so they can enter the normal Corvis review process."],
      behaviour: ["You paste an API token that the provider issued to you. Corvis keeps it only in its secret store.", "Corvis tests the connection straight away. Scheduled collection starts only after the test passes, and then repeats on a regular schedule.", "You can pause, reauthorize or revoke the connection at any time."],
      limits: ["Corvis cannot upload, change or delete anything at the provider.", "The token is never shown again, logged or kept in your browser.", "Nothing outside the folders you confirm is read."],
    },
    credentialHint: `Demo only. Use ${DEMO_TOKENS.valid} to pass the test. To see a failed test, use ${DEMO_TOKENS.invalid} (rejected), ${DEMO_TOKENS.noAccess} (no access) or ${DEMO_TOKENS.unreachable} (cannot reach the provider).`,
    connectorVersion: DEMO_VERSION,
  },
];

export type DemoTestOutcome = { ok: true } | { ok: false; errorClass: ConnectorErrorClass };

/**
 * The connectivity-test result a demo connection will report, derived from the
 * credential at connect time. Only this non-secret outcome is kept; the
 * credential itself is dropped, like everywhere else in the demo store.
 */
export function demoTestOutcome(providerKey: string, secret: SecretPayload): DemoTestOutcome {
  if (providerKey === DEMO_OAUTH_PROVIDER_KEY) return secret.accessToken === DEMO_OAUTH_ACCESS_TOKEN ? { ok: true } : { ok: false, errorClass: "auth" };
  if (secret.token === DEMO_TOKENS.noAccess) return { ok: false, errorClass: "permission" };
  if (secret.token === DEMO_TOKENS.unreachable) return { ok: false, errorClass: "network" };
  // Anything but the one valid demo token is rejected, like a mistyped real token.
  return secret.token === DEMO_TOKENS.valid ? { ok: true } : { ok: false, errorClass: "auth" };
}
