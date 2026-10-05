export type ServerConfig = {
  environment: "development" | "test" | "production";
  demoMode: boolean;
  authIssuer?: string;
  authAudience?: string;
  authJwksUrl?: string;
  trustedAuthProxySecret?: string;

  /** Provider-neutral primary database binding. PostgreSQL is the current dialect. */
  databaseDsn?: string;
  databaseProvider: "supabase" | "gcp-cloud-sql" | "aws-rds" | "azure-postgresql" | "self-hosted" | "unknown";

  objectStoreBucket?: string;
  gcpAccessToken?: string;
  gcsChunkSizeBytes: number;
  uploadAllowedOrigins: string[];
  gcsMalwareMetadataKey: string;
  gcsMalwareCleanValue: string;
  gcsMalwareThreatValue: string;

  searchEndpoint?: string;
  searchApiToken?: string;
  aiEndpoint?: string;
  aiApiToken?: string;
  researchTimeoutMs: number;

  observabilityEndpoint?: string;
  observabilityToken?: string;
  // Per-tenant/per-service-account request budget enforced on src/app/api/v1
  // routes, layered underneath Cloudflare's edge rate limiting rather than
  // replacing it. Requests share a fixed one-minute window per identity.
  rateLimitRequestsPerMinute: number;
  dataLifecycleEndpoint?: string;
  dataLifecycleToken?: string;
  exportArtifactTtlSeconds: number;
  // Non-production compatibility only. Production internal calls use Google
  // workload OIDC instead of a shared secret.
  workerSecret?: string;
  // Identifies the Corvis-operated internal tenant whose administrators may
  // provision brand-new client tenants (see src/modules/identity-access/server/tenant-provisioning.ts).
  // Unset by default: cross-tenant tenant creation is disabled until an
  // operator deliberately designates their internal operations tenant.
  operationsTenantId?: string;
  // Email notifications (#258). Delivery stays off until a reviewed provider
  // adapter is selected here; preferences and the outbox work regardless.
  emailProvider?: string;
  emailFromAddress?: string;
  // Public origin of the customer app, used only to build links in emails.
  publicAppUrl?: string;
};

function truthy(value?: string) { return value === "1" || value === "true"; }
function positiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function csv(value?: string): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

const DATABASE_PROVIDERS = new Set<ServerConfig["databaseProvider"]>([
  "supabase",
  "gcp-cloud-sql",
  "aws-rds",
  "azure-postgresql",
  "self-hosted",
  "unknown",
]);
function databaseProvider(value?: string): ServerConfig["databaseProvider"] {
  const normalized = value?.trim().toLowerCase() as ServerConfig["databaseProvider"] | undefined;
  return normalized && DATABASE_PROVIDERS.has(normalized) ? normalized : "unknown";
}

/** Accepts only an https origin (or http://localhost for development); anything else is treated as unset. */
function publicOrigin(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return undefined;
    return url.origin;
  } catch { return undefined; }
}

/**
 * Fails closed: only an unset NODE_ENV or exactly "development"/"test" is treated as non-production.
 * Any other value ("Production", "staging", a typo) gets production behavior, so it can never
 * select the in-memory rate limiter, the shared-secret worker path or skip production checks.
 */
function resolveEnvironment(nodeEnv?: string): ServerConfig["environment"] {
  if (!nodeEnv) return "development";
  return nodeEnv === "development" || nodeEnv === "test" ? nodeEnv : "production";
}

/**
 * True unless NODE_ENV is unset or exactly "development"/"test" (see {@link resolveEnvironment}).
 * Use this instead of `NODE_ENV === "production"` so "Production", "staging" or a typo fail closed.
 * This module has no imports, so it is safe to use from the proxy and from server components.
 */
export function isProductionEnvironment(nodeEnv?: string): boolean {
  return resolveEnvironment(nodeEnv) === "production";
}

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const environment = resolveEnvironment(env.NODE_ENV);
  const demoMode = truthy(env.CORVIS_DEMO_MODE);
  const exportArtifactTtlSeconds = Math.min(positiveInteger(env.CORVIS_EXPORT_ARTIFACT_TTL_SECONDS) ?? 24 * 60 * 60, 7 * 24 * 60 * 60);
  const databaseDsn = env.CORVIS_DATABASE_DSN;
  const config: ServerConfig = {
    environment,
    demoMode,
    authIssuer: env.CORVIS_AUTH_ISSUER,
    authAudience: env.CORVIS_AUTH_AUDIENCE,
    authJwksUrl: env.CORVIS_AUTH_JWKS_URL,
    trustedAuthProxySecret: env.CORVIS_TRUSTED_AUTH_PROXY_SECRET,
    databaseDsn,
    databaseProvider: databaseProvider(env.CORVIS_DATABASE_PROVIDER),
    objectStoreBucket: env.CORVIS_OBJECT_STORE_BUCKET,
    gcpAccessToken: env.CORVIS_GCP_ACCESS_TOKEN,
    gcsChunkSizeBytes: positiveInteger(env.CORVIS_GCS_CHUNK_SIZE_BYTES) ?? 8 * 1024 * 1024,
    uploadAllowedOrigins: csv(env.CORVIS_UPLOAD_ALLOWED_ORIGINS),
    gcsMalwareMetadataKey: env.CORVIS_MALWARE_SCAN_METADATA_KEY ?? "corvis-malware-status",
    gcsMalwareCleanValue: env.CORVIS_MALWARE_CLEAN_VALUE ?? "clean",
    gcsMalwareThreatValue: env.CORVIS_MALWARE_THREAT_VALUE ?? "threat",
    searchEndpoint: env.CORVIS_SEARCH_ENDPOINT,
    searchApiToken: env.CORVIS_SEARCH_API_TOKEN,
    aiEndpoint: env.CORVIS_AI_ENDPOINT,
    aiApiToken: env.CORVIS_AI_API_TOKEN,
    researchTimeoutMs: Math.min(positiveInteger(env.CORVIS_RESEARCH_TIMEOUT_MS) ?? 30_000, 120_000),
    observabilityEndpoint: env.CORVIS_OBSERVABILITY_ENDPOINT,
    observabilityToken: env.CORVIS_OBSERVABILITY_TOKEN,
    rateLimitRequestsPerMinute: positiveInteger(env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE) ?? 600,
    dataLifecycleEndpoint: env.CORVIS_DATA_LIFECYCLE_ENDPOINT,
    dataLifecycleToken: env.CORVIS_DATA_LIFECYCLE_TOKEN,
    exportArtifactTtlSeconds,
    workerSecret: env.CORVIS_WORKER_SECRET,
    operationsTenantId: env.CORVIS_OPERATIONS_TENANT_ID,
    emailProvider: (env.CORVIS_EMAIL_PROVIDER ?? "disabled").trim().toLowerCase() || "disabled",
    emailFromAddress: env.CORVIS_EMAIL_FROM?.trim() || undefined,
    publicAppUrl: publicOrigin(env.CORVIS_PUBLIC_APP_URL),
  };

  if (config.gcsChunkSizeBytes % (256 * 1024) !== 0) {
    throw new Error("CORVIS_GCS_CHUNK_SIZE_BYTES must be a multiple of 256 KiB");
  }

  if (environment === "production") {
    if (demoMode) throw new Error("CORVIS_DEMO_MODE must be disabled in production");
    // Startup requires only authoritative cross-cutting bindings. Optional
    // capability configuration fails closed at its own boundary.
    const missing = [
      ["CORVIS_AUTH_ISSUER", config.authIssuer],
      ["CORVIS_AUTH_AUDIENCE", config.authAudience],
      ["CORVIS_DATABASE_DSN", config.databaseDsn],
      ["CORVIS_OBJECT_STORE_BUCKET", config.objectStoreBucket],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
      // CORVIS_POSTGRES_DSN was renamed to CORVIS_DATABASE_DSN and is no longer read; say so instead of failing mysteriously.
      const renamed = missing.includes("CORVIS_DATABASE_DSN") && env.CORVIS_POSTGRES_DSN ? " (CORVIS_POSTGRES_DSN is no longer read; rename it to CORVIS_DATABASE_DSN)" : "";
      throw new Error(`Missing production configuration: ${missing.join(", ")}${renamed}`);
    }
    // The required-configuration guard above establishes this invariant before
    // the production transport check; keep the runtime branch aligned with it.
    const productionDatabaseDsn = config.databaseDsn as string;
    // Production mutations require a native PostgreSQL connection. The HTTPS
    // compatibility transport cannot guarantee transaction atomicity.
    if (!/^postgres(?:ql)?:\/\//i.test(productionDatabaseDsn)) {
      throw new Error("CORVIS_DATABASE_DSN must be a native postgres:// or postgresql:// URL in production");
    }
  }
  return config;
}
