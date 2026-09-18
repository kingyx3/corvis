export type ServerConfig = {
  environment: "development" | "test" | "production";
  demoMode: boolean;
  authIssuer?: string;
  authAudience?: string;
  trustedAuthProxySecret?: string;

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

  observabilityEndpoint?: string;
  observabilityToken?: string;
  webhookSigningSecret?: string;
  dataLifecycleEndpoint?: string;
  dataLifecycleToken?: string;
  exportDeliveryEndpoint?: string;
  exportDeliveryToken?: string;
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
    trustedAuthProxySecret: env.CORVIS_TRUSTED_AUTH_PROXY_SECRET,
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
    observabilityEndpoint: env.CORVIS_OBSERVABILITY_ENDPOINT,
    observabilityToken: env.CORVIS_OBSERVABILITY_TOKEN,
    webhookSigningSecret: env.CORVIS_WEBHOOK_SIGNING_SECRET,
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
    const missing = [
      ["CORVIS_AUTH_ISSUER", config.authIssuer],
      ["CORVIS_AUTH_AUDIENCE", config.authAudience],
      ["CORVIS_TRUSTED_AUTH_PROXY_SECRET", config.trustedAuthProxySecret],
      ["CORVIS_SNOWFLAKE_SQL_API_URL", config.snowflakeSqlApiUrl],
      ["CORVIS_SNOWFLAKE_OAUTH_TOKEN", config.snowflakeOauthToken],
      ["CORVIS_SNOWFLAKE_DATABASE", config.snowflakeDatabase],
      ["CORVIS_SNOWFLAKE_WAREHOUSE", config.snowflakeWarehouse],
      ["CORVIS_SNOWFLAKE_ROLE", config.snowflakeRole],
      ["CORVIS_OBJECT_STORE_BUCKET", config.objectStoreBucket],
      ["CORVIS_UPLOAD_ALLOWED_ORIGINS", config.uploadAllowedOrigins.length ? "configured" : undefined],
      ["CORVIS_SEARCH_ENDPOINT", config.searchEndpoint],
      ["CORVIS_AI_ENDPOINT", config.aiEndpoint],
      ["CORVIS_OBSERVABILITY_ENDPOINT", config.observabilityEndpoint],
      ["CORVIS_WEBHOOK_SIGNING_SECRET", config.webhookSigningSecret],
      ["CORVIS_DATA_LIFECYCLE_ENDPOINT", config.dataLifecycleEndpoint],
      ["CORVIS_EXPORT_DELIVERY_ENDPOINT", config.exportDeliveryEndpoint],
      ["CORVIS_WORKER_SECRET", config.workerSecret],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  }
  return config;
}
