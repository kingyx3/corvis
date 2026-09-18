export type CorvisEnvironment = "development" | "test" | "production";

export type RuntimeConfig = {
  environment: CorvisEnvironment;
  demoMode: boolean;
  publicBaseUrl: string;
  sessionSecret: string;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    tenantClaim: string;
    rolesClaim: string;
  };
  snowflake: {
    accountUrl: string;
    token: string;
    database: string;
    warehouse: string;
    adminRole: string;
    searchDatabase: string;
    searchSchema: string;
    searchService: string;
    model: string;
  };
  storage: {
    region: string;
    bucket: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    kmsKeyId?: string;
    partSize: number;
    presignTtlSeconds: number;
    maxFileBytes: number;
  };
  scanner: {
    url: string;
    token?: string;
  };
  internalWorkerToken: string;
  scimToken: string;
  retentionDays: {
    source: number;
    audit: number;
    exports: number;
  };
};

let cached: RuntimeConfig | undefined;

function value(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function numberValue(name: string, fallback: number): number {
  const raw = value(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid positive number in ${name}`);
  return parsed;
}

function required(name: string, production: boolean, fallback = ""): string {
  const raw = value(name, fallback);
  if (production && !raw) throw new Error(`Missing required production configuration: ${name}`);
  return raw;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export function getConfig(): RuntimeConfig {
  if (cached) return cached;

  const environment = (value("CORVIS_ENV", process.env.NODE_ENV || "development") as CorvisEnvironment);
  const production = environment === "production";
  const demoMode = value("CORVIS_DEMO_MODE", production ? "false" : "true") === "true";
  if (production && demoMode) throw new Error("CORVIS_DEMO_MODE cannot be enabled in production");

  const publicBaseUrl = normalizeBaseUrl(required("CORVIS_PUBLIC_BASE_URL", production, "http://localhost:3000"));
  const bucket = required("CORVIS_S3_BUCKET", production, "corvis-local");
  const region = required("CORVIS_S3_REGION", production, "us-east-1");
  const endpoint = normalizeBaseUrl(value("CORVIS_S3_ENDPOINT", `https://${bucket}.s3.${region}.amazonaws.com`));

  cached = {
    environment,
    demoMode,
    publicBaseUrl,
    sessionSecret: required("CORVIS_SESSION_SECRET", production, "development-only-change-me-development-only"),
    oidc: {
      issuer: normalizeBaseUrl(required("CORVIS_OIDC_ISSUER", production)),
      clientId: required("CORVIS_OIDC_CLIENT_ID", production),
      clientSecret: value("CORVIS_OIDC_CLIENT_SECRET") || undefined,
      redirectUri: required("CORVIS_OIDC_REDIRECT_URI", production, `${publicBaseUrl}/api/auth/callback`),
      tenantClaim: value("CORVIS_OIDC_TENANT_CLAIM", "tenant_id"),
      rolesClaim: value("CORVIS_OIDC_ROLES_CLAIM", "roles"),
    },
    snowflake: {
      accountUrl: normalizeBaseUrl(required("CORVIS_SNOWFLAKE_ACCOUNT_URL", production)),
      token: required("CORVIS_SNOWFLAKE_TOKEN", production),
      database: value("CORVIS_SNOWFLAKE_DATABASE", "CORVIS"),
      warehouse: value("CORVIS_SNOWFLAKE_WAREHOUSE", "CORVIS_SERVING_WH"),
      adminRole: value("CORVIS_SNOWFLAKE_ADMIN_ROLE", "CORVIS_PLATFORM_SERVICE"),
      searchDatabase: value("CORVIS_CORTEX_SEARCH_DATABASE", "CORVIS"),
      searchSchema: value("CORVIS_CORTEX_SEARCH_SCHEMA", "PM_SEMANTIC"),
      searchService: required("CORVIS_CORTEX_SEARCH_SERVICE", production, "DOCUMENT_SEARCH"),
      model: required("CORVIS_CORTEX_MODEL", production, "openai-gpt-5"),
    },
    storage: {
      region,
      bucket,
      endpoint,
      accessKeyId: required("CORVIS_S3_ACCESS_KEY_ID", production),
      secretAccessKey: required("CORVIS_S3_SECRET_ACCESS_KEY", production),
      sessionToken: value("CORVIS_S3_SESSION_TOKEN") || undefined,
      kmsKeyId: value("CORVIS_S3_KMS_KEY_ID") || undefined,
      partSize: numberValue("CORVIS_UPLOAD_PART_SIZE", 32 * 1024 * 1024),
      presignTtlSeconds: numberValue("CORVIS_PRESIGN_TTL_SECONDS", 900),
      maxFileBytes: numberValue("CORVIS_MAX_FILE_BYTES", 20 * 1024 * 1024 * 1024),
    },
    scanner: {
      url: required("CORVIS_SCANNER_URL", production),
      token: value("CORVIS_SCANNER_TOKEN") || undefined,
    },
    internalWorkerToken: required("CORVIS_INTERNAL_WORKER_TOKEN", production, "development-worker-token"),
    scimToken: required("CORVIS_SCIM_TOKEN", production, "development-scim-token"),
    retentionDays: {
      source: numberValue("CORVIS_SOURCE_RETENTION_DAYS", 2555),
      audit: numberValue("CORVIS_AUDIT_RETENTION_DAYS", 2555),
      exports: numberValue("CORVIS_EXPORT_RETENTION_DAYS", 7),
    },
  };

  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
