import type { ConnectorDriver, SecretPayload, SecretStore } from "./source-connectors.ts";

/**
 * Builds a secret resource name that satisfies the
 * `source_connection_secret_reference_tenant_scoped` check in migration 018:
 * after the tenant id the suffix may only use `[a-z0-9-]` and at most 64
 * characters. Provider keys legitimately contain `_` and may be 64 characters
 * long, so they are slugged and truncated here; otherwise a valid provider key
 * such as `google_drive` fails the insert with a check violation (a 500).
 */
export function sourceConnectorSecretReference(tenantId: string, providerKey: string, sequence: number): string {
  const suffix = `-${sequence}`;
  const slug = providerKey.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64 - suffix.length);
  return `projects/corvis-uat/secrets/corvis-src-${tenantId}-${slug}${suffix}`;
}

/**
 * Placeholder `SecretStore`.
 *
 * Corvis has not yet wired a managed secret store (GCP Secret Manager, per
 * docs/SOURCE_CONNECTORS.md "Credential storage") for customer
 * source-connector credentials; see the doc's "Initial implementation
 * sequence" step 3. This keeps the exact tenant/provider-scoped reference
 * shape the library (and its tests) already depend on, so route code never
 * special-cases the absence of a real backing store, but it holds nothing
 * durably: secret material lives only in this process's memory and is lost
 * on restart. It must be replaced by a real managed-secret adapter before
 * any connector goes live with a real customer credential.
 */
class InMemorySourceConnectorSecretStore implements SecretStore {
  private readonly secrets = new Map<string, SecretPayload>();
  private counter = 0;

  async write(tenantId: string, providerKey: string, secret: SecretPayload): Promise<string> {
    const reference = sourceConnectorSecretReference(tenantId, providerKey, ++this.counter);
    this.secrets.set(reference, secret);
    return reference;
  }

  async read(secretReference: string): Promise<SecretPayload> {
    const secret = this.secrets.get(secretReference);
    if (!secret) throw new Error("secret_reference_not_found");
    return secret;
  }

  async revoke(secretReference: string): Promise<void> {
    this.secrets.delete(secretReference);
  }
}

let secretStoreSingleton: SecretStore | undefined;

/**
 * The `SecretStore` wired for the `/api/v1/source-connections` routes. See
 * `InMemorySourceConnectorSecretStore`'s doc comment for its current
 * (placeholder) limits.
 */
export function sourceConnectorSecretStore(): SecretStore {
  if (!secretStoreSingleton) secretStoreSingleton = new InMemorySourceConnectorSecretStore();
  return secretStoreSingleton;
}

let driversSingleton: Map<string, ConnectorDriver> | undefined;

/**
 * Registered connector drivers, keyed by `provider_key`. Empty until a real
 * connector is certified end to end (docs/SOURCE_CONNECTORS.md, "Initial
 * implementation sequence" step 4); `testSourceConnection` fails closed with
 * `unregistered_provider` for any connection whose provider has no
 * registered driver, which is the correct behavior while the catalog is
 * empty rather than a bug to work around here.
 */
export function sourceConnectorDrivers(): Map<string, ConnectorDriver> {
  if (!driversSingleton) driversSingleton = new Map();
  return driversSingleton;
}
