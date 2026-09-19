import type { ConnectorDriver, SecretPayload, SecretStore } from "./source-connectors.ts";

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
    const reference = `projects/corvis-uat/secrets/corvis-src-${tenantId}-${providerKey}-${++this.counter}`;
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
