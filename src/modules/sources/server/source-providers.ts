import { selectableScope, type SourceProviderDescriptor } from "../domain/source-connect-wizard.ts";
import { DEMO_OAUTH_RENEWAL_ALIASES, DEMO_SOURCE_PROVIDERS } from "../adapters/source-providers.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import { sourceConnectorDrivers } from "./source-connector-runtime.ts";
import { ConnectorGovernanceError, type ConnectorDriver, type CredentialType, type SourceScope } from "./source-connectors.ts";
import type { SourceOAuthClient } from "./source-oauth.ts";

/**
 * The registry of approved source providers: the only providers the "Connect
 * source" wizard offers and the only ones the connect routes accept. A
 * provider is approved when a real integration has been certified for it
 * (docs/features/SOURCE_CONNECTORS.md) and registered here together with its
 * `ConnectorDriver`; until then the registry is empty and the wizard says so
 * honestly. In demo mode (never production) the clearly labelled demo
 * providers are added so the whole flow can be exercised.
 */
export type ApprovedSourceProvider = SourceProviderDescriptor & {
  connectorVersion: string;
  /** Present exactly when `connect.method` is "oauth". */
  oauth?: SourceOAuthClient;
};

const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
// On `globalThis`, like the driver registry, so `next dev` re-evaluating this module does not drop an approval.
const sharedRegistry = globalThis as typeof globalThis & { approvedSourceProviders?: Map<string, ApprovedSourceProvider> };
const registered = (sharedRegistry.approvedSourceProviders ??= new Map<string, ApprovedSourceProvider>());

/**
 * Approves a certified provider and registers its driver in one step, so a
 * provider can never be offered without the means to test it.
 */
export function registerApprovedSourceProvider(provider: ApprovedSourceProvider, driver: ConnectorDriver): void {
  if (!PROVIDER_KEY_PATTERN.test(provider.providerKey)) throw new Error("approved source provider key is invalid");
  if (driver.providerKey !== provider.providerKey) throw new Error("approved source provider and its driver must share a provider key");
  if ((provider.connect.method === "oauth") !== (provider.oauth !== undefined)) throw new Error("an OAuth provider needs an OAuth client, and only an OAuth provider may have one");
  if (provider.scope.length === 0) throw new Error("an approved source provider must declare the scope it will read");
  registered.set(provider.providerKey, provider);
  sourceConnectorDrivers().set(provider.providerKey, driver);
}

/** Removes an approval (and its driver). Used by tests; a certified provider is withdrawn by a release, not at runtime. */
export function unregisterApprovedSourceProvider(providerKey: string): void {
  registered.delete(providerKey);
  sourceConnectorDrivers().delete(providerKey);
}

export function approvedSourceProviders(): ApprovedSourceProvider[] {
  return [...registered.values(), ...(getServerConfig().demoMode ? DEMO_SOURCE_PROVIDERS : [])];
}

export function approvedSourceProvider(providerKey: string): ApprovedSourceProvider | undefined {
  return approvedSourceProviders().find((provider) => provider.providerKey === providerKey);
}

/**
 * The approved OAuth provider that renews an existing connection's authorization, or undefined when there is none (the
 * provider was withdrawn, or it does not connect through OAuth). In demo mode the seeded demo connections that predate
 * the demo OAuth provider are renewed through it, so reauthorization can be exercised on them.
 */
export function oauthProviderForConnection(providerKey: string): ApprovedSourceProvider | undefined {
  const demoAlias = getServerConfig().demoMode ? DEMO_OAUTH_RENEWAL_ALIASES[providerKey] : undefined;
  const provider = approvedSourceProvider(demoAlias ?? providerKey);
  return provider?.oauth ? provider : undefined;
}

/** The browser-safe description: an explicit field copy, so server-only members (the OAuth client, the connector version) can never leak. */
export function providerDescriptor(provider: ApprovedSourceProvider): SourceProviderDescriptor {
  return {
    providerKey: provider.providerKey,
    displayName: provider.displayName,
    summary: provider.summary,
    demo: provider.demo,
    connect: provider.connect.method === "oauth" ? { method: "oauth" } : { method: "credential", credentialType: provider.connect.credentialType },
    scope: provider.scope.map((item) => ({ label: item.label, ...(item.path ? { path: item.path } : {}), ...(item.id ? { id: item.id } : {}) })),
    disclosure: { reads: [...provider.disclosure.reads], behaviour: [...provider.disclosure.behaviour], limits: [...provider.disclosure.limits] },
    ...(provider.credentialHint ? { credentialHint: provider.credentialHint } : {}),
  };
}

/** A scope item as it is stored with a connection: what is read, never the provider's internal id. */
function storedScope(item: { label: string; path?: string }): SourceScope {
  return item.path ? { label: item.label, path: item.path } : { label: item.label };
}

/**
 * The scope a new connection is created with, from what the browser asked for, checked against the provider's own
 * declaration (never trusted as sent). No selection means everything the provider declares. A selection must be a
 * non-empty list of distinct ids the provider declared as selectable, so a provider that offers no choice refuses any
 * selection, and an id the provider never declared cannot widen (or invent) the scope. The result keeps the provider's
 * order and is what is stored with the connection and what every later sync is limited to.
 */
export function resolveScopeSelection(provider: ApprovedSourceProvider, selection: unknown): SourceScope[] {
  if (selection === undefined) return provider.scope.map(storedScope);
  const selectable = selectableScope(provider.scope);
  if (!selectable || !Array.isArray(selection) || selection.length === 0 || selection.some((id) => typeof id !== "string")) {
    throw new ConnectorGovernanceError("invalid_scope_selection");
  }
  const chosen = new Set<string>(selection);
  if (chosen.size !== selection.length || [...chosen].some((id) => !selectable.some((item) => item.id === id))) {
    throw new ConnectorGovernanceError("invalid_scope_selection");
  }
  return selectable.filter((item) => chosen.has(item.id!)).map(storedScope);
}

export function credentialTypeOf(provider: ApprovedSourceProvider): CredentialType {
  return provider.connect.method === "oauth" ? "oauth_authorization_code" : provider.connect.credentialType;
}
