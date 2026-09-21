export type ServerConfig = {
  environment: "development" | "test" | "production";
  demoMode: boolean;
  authIssuer?: string;
  authAudience?: string;
  authJwksUrl?: string;
  trustedAuthProxySecret?: string;

  postgresDsn?: string;

  // Snowflake is an optional downstream analytics/sharing replica. These
  // bindings must not be required for the application to start.
  snowflakeDsn?: string;
  snowflakeSqlApiUrl?: string;
  snowflakeOauthToken?: string;
  snowflakeDatabase?: string;
  snowflakeWarehouse?: string;
  snowflakeRole?: string;

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
  // Per-tenant/per-service-account request budget enforced on app/api/v1
  // routes, layered underneath Cloudflare's edge rate limiting rather than
  // replacing it. Requests share a fixed one-minute window per identity.
  rateLimitRequestsPerMinute: number;
  dataLifecycleEndpoint?: string;
  dataLifecycleToken?: string;
  exportDeliveryEndpoint?: string;
  exportDeliveryToken?: string;
  // Non-production compatibility only. Production internal calls use Google
  // workload OIDC instead of a shared secret.
  workerSecret?: string;
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

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const environment = (env.NODE_ENV || "development") as ServerConfig["environment"];
  const demoMode = truthy(env.CORVIS_DEMO_MODE);
  const config: ServerConfig = {
    environment,
    demoMode,
    authIssuer: env.CORVIS_AUTH_ISSUER,
    authAudience: env.CORVIS_AUTH_AUDIENCE,
    authJwksUrl: env.CORVIS_AUTH_JWKS_URL,
    trustedAuthProxySecret: env.CORVIS_TRUSTED_AUTH_PROXY_SECRET,
    postgresDsn: env.CORVIS_POSTGRES_DSN,
    snowflakeDsn: env.CORVIS_SNOWFLAKE_DSN,
    snowflakeSqlApiUrl: env.CORVIS_SNOWFLAKE_SQL_API_URL,
    snowflakeOauthToken: env.CORVIS_SNOWFLAKE_OAUTH_TOKEN,
    snowflakeDatabase: env.CORVIS_SNOWFLAKE_DATABASE,
    snowflakeWarehouse: env.CORVIS_SNOWFLAKE_WAREHOUSE,
    snowflakeRole: env.CORVIS_SNOWFLAKE_ROLE,
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
    exportDeliveryEndpoint: env.CORVIS_EXPORT_DELIVERY_ENDPOINT,
    exportDeliveryToken: env.CORVIS_EXPORT_DELIVERY_TOKEN,
    workerSecret: env.CORVIS_WORKER_SECRET,
  };

  if (config.gcsChunkSizeBytes % (256 * 1024) !== 0) {
    throw new Error("CORVIS_GCS_CHUNK_SIZE_BYTES must be a multiple of 256 KiB");
  }

  if (environment === "production") {
    if (demoMode) throw new Error("CORVIS_DEMO_MODE must be disabled in production");
    // Startup requires only the authoritative core data/auth/storage bindings.
    // Optional capabilities (AI/search/observability/export/lifecycle) fail closed
    // at their own adapter boundaries and surface as missing readiness instead of
    // preventing unrelated customer workflows from starting.
    const missing = [
      ["CORVIS_AUTH_ISSUER", config.authIssuer],
      ["CORVIS_AUTH_AUDIENCE", config.authAudience],
      ["CORVIS_POSTGRES_DSN", config.postgresDsn],
      ["CORVIS_OBJECT_STORE_BUCKET", config.objectStoreBucket],
      ["CORVIS_UPLOAD_ALLOWED_ORIGINS", config.uploadAllowedOrigins.length ? "configured" : undefined],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  }
  return config;
}
