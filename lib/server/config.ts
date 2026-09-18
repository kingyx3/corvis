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
  s3Region?: string;
  s3Endpoint?: string;
  s3KmsKeyId?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  s3PresignTtlSeconds?: number;
  malwareCleanTagKey?: string;
  malwareCleanTagValue?: string;
  malwareThreatTagValue?: string;

  searchEndpoint?: string;
  searchApiToken?: string;
  aiEndpoint?: string;
  aiApiToken?: string;

  observabilityEndpoint?: string;
  observabilityToken?: string;
  webhookSigningSecret?: string;
};

function truthy(value?: string) { return value === "1" || value === "true"; }
function positiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
    s3Region: env.CORVIS_S3_REGION,
    s3Endpoint: env.CORVIS_S3_ENDPOINT,
    s3KmsKeyId: env.CORVIS_S3_KMS_KEY_ID,
    awsAccessKeyId: env.CORVIS_AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: env.CORVIS_AWS_SECRET_ACCESS_KEY,
    awsSessionToken: env.CORVIS_AWS_SESSION_TOKEN,
    s3PresignTtlSeconds: positiveInteger(env.CORVIS_S3_PRESIGN_TTL_SECONDS) ?? 900,
    malwareCleanTagKey: env.CORVIS_MALWARE_SCAN_TAG_KEY ?? "GuardDutyMalwareScanStatus",
    malwareCleanTagValue: env.CORVIS_MALWARE_CLEAN_TAG_VALUE ?? "NO_THREATS_FOUND",
    malwareThreatTagValue: env.CORVIS_MALWARE_THREAT_TAG_VALUE ?? "THREATS_FOUND",
    searchEndpoint: env.CORVIS_SEARCH_ENDPOINT,
    searchApiToken: env.CORVIS_SEARCH_API_TOKEN,
    aiEndpoint: env.CORVIS_AI_ENDPOINT,
    aiApiToken: env.CORVIS_AI_API_TOKEN,
    observabilityEndpoint: env.CORVIS_OBSERVABILITY_ENDPOINT,
    observabilityToken: env.CORVIS_OBSERVABILITY_TOKEN,
    webhookSigningSecret: env.CORVIS_WEBHOOK_SIGNING_SECRET,
  };

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
      ["CORVIS_S3_REGION", config.s3Region],
      ["CORVIS_S3_KMS_KEY_ID", config.s3KmsKeyId],
      ["CORVIS_AWS_ACCESS_KEY_ID", config.awsAccessKeyId],
      ["CORVIS_AWS_SECRET_ACCESS_KEY", config.awsSecretAccessKey],
      ["CORVIS_SEARCH_ENDPOINT", config.searchEndpoint],
      ["CORVIS_AI_ENDPOINT", config.aiEndpoint],
      ["CORVIS_OBSERVABILITY_ENDPOINT", config.observabilityEndpoint],
      ["CORVIS_WEBHOOK_SIGNING_SECRET", config.webhookSigningSecret],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  }
  return config;
}
