import { MAX_CONNECTION_NAME_LENGTH, OAUTH_RETURN_MARKER } from "../../domain/source-connect-wizard.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { approvedSourceProvider, resolveScopeSelection, type ApprovedSourceProvider } from "../connectors/source-providers.ts";
import { ConnectorGovernanceError, assertSourceConnectionId, type SecretPayload, type SourceConnection, type SourceScope } from "../connectors/source-connectors.ts";

/** Customer-facing connection shape: never the secret reference, an internal resource pointer. */
export function redactedConnection(connection: SourceConnection): Omit<SourceConnection, "secretReference"> {
  const { secretReference, ...rest } = connection;
  void secretReference;
  return rest;
}

/** The app URL a provider redirects back to; the wizard resumes from the marker, and the code/state the provider appends. */
export function oauthRedirectUri(request: Request): string {
  const origin = getServerConfig().publicAppUrl ?? new URL(request.url).origin;
  return `${origin}/?${OAUTH_RETURN_MARKER}=return`;
}

/** Cookies are marked Secure whenever the app is served over HTTPS (behind a TLS-terminating proxy the public URL says so). */
export function usesSecureCookies(request: Request): boolean {
  return (getServerConfig().publicAppUrl ?? new URL(request.url).origin).startsWith("https:");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorGovernanceError("invalid_request");
  return value as Record<string, unknown>;
}

export type ParsedConnectRequest = {
  provider: ApprovedSourceProvider;
  connectionLabel: string;
  /** What the connection will read: the provider's declared scope, narrowed by a validated selection when one was sent. */
  scope: SourceScope[];
  /** The validated selection as sent (ids the provider declared), carried through an OAuth redirect; absent when everything is read. */
  scopeIds?: string[];
};

/**
 * The part of a connect or OAuth-start body both routes share. The administrator must have confirmed the disclosed
 * access (`scopeConfirmed: true`, set only after the wizard's confirmation step), and the provider must be approved:
 * the caller never supplies scope, credential type or connector version. The one thing an administrator may choose is
 * which of the provider's declared folders to include (`selectedScopeIds`), and that choice is checked against the
 * registry (`resolveScopeSelection`): it can only narrow what the provider declares, never add to it.
 */
export function parseConnectRequest(body: unknown, method: "oauth" | "credential"): { parsed: ParsedConnectRequest; object: Record<string, unknown> } {
  const object = asObject(body);
  if (typeof object.providerKey !== "string" || !object.providerKey) throw new ConnectorGovernanceError("provider_key_required");
  if (typeof object.connectionLabel !== "string" || !object.connectionLabel.trim()) throw new ConnectorGovernanceError("connection_label_required");
  if (object.connectionLabel.trim().length > MAX_CONNECTION_NAME_LENGTH) throw new ConnectorGovernanceError("connection_label_too_long");
  if (object.scopeConfirmed !== true) throw new ConnectorGovernanceError("source_scope_confirmation_required");
  const provider = approvedSourceProvider(object.providerKey);
  // An unknown provider and one that connects the other way are both "not approved for this flow".
  if (!provider || provider.connect.method !== method) throw new ConnectorGovernanceError("unregistered_provider");
  const scope = resolveScopeSelection(provider, object.selectedScopeIds);
  return { parsed: { provider, connectionLabel: object.connectionLabel.trim(), scope, ...(object.selectedScopeIds !== undefined ? { scopeIds: object.selectedScopeIds as string[] } : {}) }, object };
}

export type ParsedOAuthStart =
  /** Renews an existing connection's authorization: nothing but its id is sent, because scope and provider are already confirmed and recorded. */
  | { kind: "reauthorize"; sourceConnectionId: string }
  | { kind: "connect"; parsed: ParsedConnectRequest };

/** The OAuth-start body: `{ sourceConnectionId }` to renew a connection, otherwise the same body as a connect request. */
export function parseOAuthStartRequest(body: unknown): ParsedOAuthStart {
  const object = asObject(body);
  if (object.sourceConnectionId === undefined) return { kind: "connect", parsed: parseConnectRequest(object, "oauth").parsed };
  if (typeof object.sourceConnectionId !== "string") throw new ConnectorGovernanceError("invalid_request");
  assertSourceConnectionId(object.sourceConnectionId);
  return { kind: "reauthorize", sourceConnectionId: object.sourceConnectionId };
}

export function parseSecret(value: unknown): SecretPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) throw new ConnectorGovernanceError("secret_required");
  return value as SecretPayload;
}
