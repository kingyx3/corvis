import { randomInt } from "node:crypto";
import { getServerConfig } from "./config.ts";
import type { ConnectorDriver, SecretPayload, SecretStore, SecretWriteOptions } from "./source-connectors.ts";

/**
 * Placeholder project id used only by the in-memory/local store, which never
 * talks to a real GCP project. It is a syntactically valid GCP project id
 * (`[a-z0-9][a-z0-9-]{4,28}[a-z0-9]`, matching the migration 018 check
 * constraint) so local/dev/test references have the same shape as production
 * ones without implying a specific real project.
 */
const LOCAL_PLACEHOLDER_PROJECT_ID = "corvis-local-dev";

/**
 * Builds a secret resource name that satisfies the
 * `source_connection_secret_reference_tenant_scoped` check in migration 018:
 * after the tenant id the suffix may only use `[a-z0-9-]` and at most 64
 * characters. Provider keys legitimately contain `_` and may be 64 characters
 * long, so they are slugged and truncated here; otherwise a valid provider key
 * such as `google_drive` fails the insert with a check violation (a 500).
 *
 * `projectId` must be the real GCP project the secret is (or will be) stored
 * in; every one of Corvis's `dev`/`uat`/`prod` environments has its own
 * project (see docs/operations/GITHUB_ENVIRONMENTS.md, `GCP_PROJECT_ID`), so this can
 * never be hardcoded to one of them. Callers that have no real project
 * (the in-memory/local store) pass `LOCAL_PLACEHOLDER_PROJECT_ID`.
 */
export function sourceConnectorSecretReference(
  tenantId: string,
  providerKey: string,
  sequence: number,
  projectId: string = LOCAL_PLACEHOLDER_PROJECT_ID,
): string {
  const suffix = `-${sequence}`;
  const slug = providerKey.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64 - suffix.length);
  return `projects/${projectId}/secrets/corvis-src-${tenantId}-${slug}${suffix}`;
}

/** A number unique enough to disambiguate concurrent/cross-process secret writes for the same tenant+provider. */
function uniqueSequence(): number {
  return Date.now() * 1000 + randomInt(0, 1000);
}

/**
 * Placeholder `SecretStore`.
 *
 * Used only when no real managed secret store is configured (see
 * `sourceConnectorSecretStore` below): local development and the test suite,
 * neither of which has (or should need) a real GCP project. It keeps the
 * exact tenant/provider-scoped reference shape the library (and its tests)
 * already depend on, so route code never special-cases the absence of a real
 * backing store, but it holds nothing durably: secret material lives only in
 * this process's memory and is lost on restart. It must never be selected
 * once a connector goes live with a real customer credential — see
 * `GcpSecretManagerSecretStore` for that path.
 */
class InMemorySourceConnectorSecretStore implements SecretStore {
  private readonly secrets = new Map<string, { secret: SecretPayload; expiresAt?: number }>();
  private counter = 0;

  async write(tenantId: string, providerKey: string, secret: SecretPayload, options: SecretWriteOptions = {}): Promise<string> {
    const reference = sourceConnectorSecretReference(tenantId, providerKey, ++this.counter);
    // A secret written with a lifetime stops existing when it is up, as it does in Secret Manager; the sweep below reclaims it.
    this.secrets.set(reference, { secret, ...(options.ttlSeconds ? { expiresAt: Date.now() + options.ttlSeconds * 1000 } : {}) });
    return reference;
  }

  async read(secretReference: string): Promise<SecretPayload> {
    const stored = this.secrets.get(secretReference);
    if (!stored || (stored.expiresAt !== undefined && stored.expiresAt <= Date.now())) throw new Error("secret_reference_not_found");
    return stored.secret;
  }

  async revoke(secretReference: string): Promise<void> {
    this.secrets.delete(secretReference);
  }

  async sweepExpired(now: number = Date.now()): Promise<number> {
    let removed = 0;
    for (const [reference, stored] of this.secrets) {
      if (stored.expiresAt !== undefined && stored.expiresAt <= now) { this.secrets.delete(reference); removed += 1; }
    }
    return removed;
  }
}

type TokenResponse = { access_token?: string; expires_in?: number };

/** Upper bound for any Secret Manager control-plane call so a stalled provider cannot pin a request. */
export const SECRET_MANAGER_REQUEST_TIMEOUT_MS = 20_000;
const METADATA_TOKEN_TIMEOUT_MS = 5_000;

/** The secret id inside a reference built by `sourceConnectorSecretReference`, which always carries the `/secrets/` segment. */
function secretIdFromReference(reference: string): string {
  const marker = "/secrets/";
  return reference.slice(reference.indexOf(marker) + marker.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * GCP Secret Manager-backed `SecretStore`. Talks to the Secret Manager v1
 * REST API directly with a workload-identity access token fetched from the
 * metadata server, the same shape as `GcsControlClient` (src/lib/server/gcs.ts)
 * and `GcpProcessingTransportAdapter` (src/lib/server/processing-transport.ts):
 * no `@google-cloud/*` client dependency, and every outbound call is bounded
 * by an `AbortSignal.timeout`.
 *
 * Never logs or throws with raw secret payload bytes; errors carry only the
 * HTTP status and the secret resource name.
 */
export class GcpSecretManagerSecretStore implements SecretStore {
  private readonly projectId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cachedToken?: { value: string; expiresAt: number };

  constructor(projectId: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    if (!projectId.trim()) throw new Error("GCP Secret Manager adapter requires a project id");
    this.projectId = projectId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? SECRET_MANAGER_REQUEST_TIMEOUT_MS;
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt - Date.now() > 60_000) return this.cachedToken.value;
    const response = await this.fetchImpl(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, cache: "no-store", signal: AbortSignal.timeout(METADATA_TOKEN_TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error(`GCP workload identity token request failed (${response.status})`);
    const body = await response.json() as TokenResponse;
    if (!body.access_token) throw new Error("GCP workload identity did not return an access token");
    this.cachedToken = { value: body.access_token, expiresAt: Date.now() + Math.max(60, body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  private async authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return this.fetchImpl(url, { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(this.timeoutMs) });
  }

  async write(tenantId: string, providerKey: string, secret: SecretPayload, options: SecretWriteOptions = {}): Promise<string> {
    const reference = sourceConnectorSecretReference(tenantId, providerKey, uniqueSequence(), this.projectId);
    const secretId = secretIdFromReference(reference);
    const createUrl = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/secrets?secretId=${encodeURIComponent(secretId)}`;
    const createResponse = await this.authorizedFetch(createUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replication: { automatic: {} }, ...(options.ttlSeconds ? { ttl: `${Math.ceil(options.ttlSeconds)}s` } : {}) }),
    });
    if (!createResponse.ok) {
      throw new Error(`GCP Secret Manager secret creation failed (${createResponse.status}) for ${reference}`);
    }
    try {
      const payloadData = Buffer.from(JSON.stringify(secret), "utf8").toString("base64");
      const versionResponse = await this.authorizedFetch(`https://secretmanager.googleapis.com/v1/${reference}:addVersion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { data: payloadData } }),
      });
      if (!versionResponse.ok) {
        throw new Error(`GCP Secret Manager secret version add failed (${versionResponse.status}) for ${reference}`);
      }
    } catch (error) {
      // A secret with no usable version must never outlive this failed
      // write as an orphaned, empty-but-billable resource.
      await this.deleteSecret(reference).catch(() => undefined);
      throw error;
    }
    return reference;
  }

  /**
   * Every caller is expected to have already scoped `secretReference` to its own tenant (`belongsToTenant` in
   * source-oauth.ts, the connection-ownership check in source-connectors.ts); this is defense in depth against a
   * reference that reaches here unscoped or carrying stray characters (a `#` fragment, a `/..` segment) that would
   * make the literal string look right while the URL it is spliced into resolves somewhere else.
   */
  private assertWellFormedReference(secretReference: string): void {
    if (!new RegExp(`^projects/${escapeRegExp(this.projectId)}/secrets/[A-Za-z0-9_-]+$`).test(secretReference)) {
      throw new Error("secret_reference_malformed");
    }
  }

  async read(secretReference: string): Promise<SecretPayload> {
    this.assertWellFormedReference(secretReference);
    const response = await this.authorizedFetch(`https://secretmanager.googleapis.com/v1/${secretReference}/versions/latest:access`);
    if (response.status === 404) throw new Error("secret_reference_not_found");
    if (!response.ok) throw new Error(`GCP Secret Manager secret access failed (${response.status}) for ${secretReference}`);
    const body = await response.json() as { payload?: { data?: string } };
    const data = body.payload?.data;
    if (!data) throw new Error(`GCP Secret Manager secret access returned no payload for ${secretReference}`);
    try {
      return JSON.parse(Buffer.from(data, "base64").toString("utf8")) as SecretPayload;
    } catch {
      // Deliberately omit the decoded bytes: this error must never carry raw secret material.
      throw new Error(`GCP Secret Manager secret payload for ${secretReference} was not valid JSON`);
    }
  }

  async revoke(secretReference: string): Promise<void> {
    await this.deleteSecret(secretReference);
  }

  private async deleteSecret(secretReference: string): Promise<void> {
    this.assertWellFormedReference(secretReference);
    const response = await this.authorizedFetch(`https://secretmanager.googleapis.com/v1/${secretReference}`, { method: "DELETE" });
    // A secret that is already gone is exactly the post-revoke state callers
    // want, so a 404 here is success, not an error to surface.
    if (!response.ok && response.status !== 404) {
      throw new Error(`GCP Secret Manager secret deletion failed (${response.status}) for ${secretReference}`);
    }
  }
}

/**
 * The process-wide store is kept on `globalThis`, not in a module variable: `next dev` re-evaluates server modules
 * whenever another route is compiled, which would otherwise drop the placeholder store's contents (a pending OAuth
 * attempt) between the request that started a flow and the one that finishes it. Production keeps one instance anyway.
 */
const sharedStores = globalThis as typeof globalThis & { secretStore?: SecretStore };

/**
 * The `SecretStore` wired for the `/api/v1/source-connections` routes.
 *
 * Selects `GcpSecretManagerSecretStore` when `CORVIS_GCP_PROJECT_ID` is
 * configured (mirroring how `platform()` in src/lib/server/platform.ts picks a
 * real vs. demo adapter from config rather than from `NODE_ENV`), and falls
 * back to the in-memory placeholder otherwise. In `production`, a missing
 * project id fails closed instead of silently keeping customer credentials
 * in memory only -- see `InMemorySourceConnectorSecretStore`'s doc comment.
 */
export function selectSourceConnectorSecretStore(projectId: string | undefined, environment: string): SecretStore {
  if (projectId) return new GcpSecretManagerSecretStore(projectId);
  if (environment === "production") throw new Error("CORVIS_GCP_PROJECT_ID is required to select a source-connector SecretStore in production");
  return new InMemorySourceConnectorSecretStore();
}

export function sourceConnectorSecretStore(): SecretStore {
  if (!sharedStores.secretStore) sharedStores.secretStore = selectSourceConnectorSecretStore(process.env.CORVIS_GCP_PROJECT_ID?.trim(), getServerConfig().environment);
  return sharedStores.secretStore;
}

/**
 * The operator sweep for pending OAuth attempts (and any other short-lived secret) on a store that has no expiry of its
 * own. It only ever touches a store this process already holds, so it never selects (or, in production without a
 * configured project, fails to select) one just to sweep it; Secret Manager deletes its own expired secrets and has
 * nothing to sweep.
 */
export async function sweepExpiredSourceSecrets(now?: number): Promise<{ removed: number }> {
  const store = sharedStores.secretStore;
  return { removed: store?.sweepExpired ? await store.sweepExpired(now) : 0 };
}

/** The driver registry is kept on `globalThis` for the same reason as the store above: `next dev` re-evaluates this module and would drop a registered provider's driver. */
const sharedDrivers = globalThis as typeof globalThis & { sourceConnectorDrivers?: Map<string, ConnectorDriver> };

/**
 * Registered connector drivers, keyed by `provider_key`. Empty until a real
 * connector is certified end to end (docs/features/SOURCE_CONNECTORS.md, "Initial
 * implementation sequence" step 4); `testSourceConnection` fails closed with
 * `unregistered_provider` for any connection whose provider has no
 * registered driver, which is the correct behavior while the catalog is
 * empty rather than a bug to work around here.
 */
export function sourceConnectorDrivers(): Map<string, ConnectorDriver> {
  if (!sharedDrivers.sourceConnectorDrivers) sharedDrivers.sourceConnectorDrivers = new Map();
  return sharedDrivers.sourceConnectorDrivers;
}
