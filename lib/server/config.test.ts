import assert from "node:assert/strict";
import test from "node:test";
import { getServerConfig } from "./config.ts";

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    CORVIS_AUTH_ISSUER: "https://idp.example.com",
    CORVIS_AUTH_AUDIENCE: "corvis",
    CORVIS_DATABASE_DSN: "postgresql://corvis:secret@db.example.com:5432/postgres?sslmode=require",
    CORVIS_DATABASE_PROVIDER: "gcp-cloud-sql",
    CORVIS_OBJECT_STORE_BUCKET: "corvis-prod",
  };
}

test("configuration retains safe local defaults", () => {
  const config = getServerConfig({ NODE_ENV: "test" });
  assert.equal(config.environment, "test");
  assert.equal(config.demoMode, false);
  assert.equal(config.databaseProvider, "unknown");
  assert.equal(config.gcsChunkSizeBytes, 8 * 1024 * 1024);
  assert.equal(config.researchTimeoutMs, 30_000);
  assert.equal(config.rateLimitRequestsPerMinute, 600);
  assert.deepEqual(config.uploadAllowedOrigins, []);
});

test("boolean and positive-integer settings cover accepted and fail-closed edge values", () => {
  const config = getServerConfig({
    NODE_ENV: "test",
    CORVIS_DEMO_MODE: "1",
    CORVIS_RESEARCH_TIMEOUT_MS: "-1",
    CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE: "0",
  });
  assert.equal(config.demoMode, true);
  assert.equal(config.researchTimeoutMs, 30_000);
  assert.equal(config.rateLimitRequestsPerMinute, 600);
});

test("database binding is provider-neutral while the legacy Postgres env remains compatible", () => {
  const current = getServerConfig({
    NODE_ENV: "test",
    CORVIS_DATABASE_DSN: "postgresql://new.example/postgres",
    CORVIS_DATABASE_PROVIDER: "gcp-cloud-sql",
  });
  assert.equal(current.databaseDsn, "postgresql://new.example/postgres");
  assert.equal(current.postgresDsn, current.databaseDsn);
  assert.equal(current.databaseProvider, "gcp-cloud-sql");

  const legacy = getServerConfig({ NODE_ENV: "test", CORVIS_POSTGRES_DSN: "postgresql://legacy.example/postgres" });
  assert.equal(legacy.databaseDsn, "postgresql://legacy.example/postgres");
  assert.equal(legacy.postgresDsn, legacy.databaseDsn);
});

test("database provider values are normalized and unknown providers fail closed", () => {
  for (const provider of ["supabase", "gcp-cloud-sql", "aws-rds", "azure-postgresql", "self-hosted", "unknown"] as const) {
    assert.equal(
      getServerConfig({ NODE_ENV: "test", CORVIS_DATABASE_PROVIDER: `  ${provider.toUpperCase()}  ` }).databaseProvider,
      provider,
    );
  }
  assert.equal(
    getServerConfig({ NODE_ENV: "test", CORVIS_DATABASE_PROVIDER: "unexpected-provider" }).databaseProvider,
    "unknown",
  );
  assert.equal(
    getServerConfig({ NODE_ENV: "test", CORVIS_DATABASE_PROVIDER: "   " }).databaseProvider,
    "unknown",
  );
});

test("public app URL accepts secure origins and localhost only", () => {
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: " https://app.example.com/path?q=1 " }).publicAppUrl, "https://app.example.com");
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "http://localhost:3000/path" }).publicAppUrl, "http://localhost:3000");
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "http://example.com" }).publicAppUrl, undefined);
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "ftp://example.com/resource" }).publicAppUrl, undefined);
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "not a url" }).publicAppUrl, undefined);
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "   " }).publicAppUrl, undefined);
});

test("OIDC discovery is the default and explicit JWKS remains optional", () => {
  const config = getServerConfig({
    NODE_ENV: "test",
    CORVIS_AUTH_ISSUER: "https://idp.example.com",
    CORVIS_AUTH_AUDIENCE: "corvis",
    CORVIS_AUTH_JWKS_URL: "https://idp.example.com/jwks",
  });
  assert.equal(config.authIssuer, "https://idp.example.com");
  assert.equal(config.authAudience, "corvis");
  assert.equal(config.authJwksUrl, "https://idp.example.com/jwks");
});

test("production requires only authoritative cross-cutting auth, database and object-store roots", () => {
  assert.doesNotThrow(() => getServerConfig(productionEnvironment()));

  for (const required of [
    "CORVIS_AUTH_ISSUER",
    "CORVIS_AUTH_AUDIENCE",
    "CORVIS_DATABASE_DSN",
    "CORVIS_OBJECT_STORE_BUCKET",
  ]) {
    const env = productionEnvironment();
    delete env[required];
    assert.throws(
      () => getServerConfig(env),
      (error: unknown) => error instanceof Error && error.message.includes(required),
      `${required} should remain a production startup requirement`,
    );
  }
});

test("production accepts legacy CORVIS_POSTGRES_DSN during migration", () => {
  const env = productionEnvironment();
  const dsn = env.CORVIS_DATABASE_DSN;
  delete env.CORVIS_DATABASE_DSN;
  env.CORVIS_POSTGRES_DSN = dsn;
  assert.doesNotThrow(() => getServerConfig(env));
});

test("production requires a native PostgreSQL DSN because the HTTPS transport cannot run transactions", () => {
  for (const dsn of ["https://postgres.example.com/sql", "http://postgres.example.com/sql", "not-a-url"]) {
    assert.throws(
      () => getServerConfig({ ...productionEnvironment(), CORVIS_DATABASE_DSN: dsn }),
      /native postgres/,
      dsn,
    );
  }
  for (const dsn of ["postgres://u:p@db.example.com/postgres", "postgresql://u:p@db.example.com/postgres?sslmode=require"]) {
    assert.doesNotThrow(() => getServerConfig({ ...productionEnvironment(), CORVIS_DATABASE_DSN: dsn }));
  }
  assert.doesNotThrow(() => getServerConfig({ NODE_ENV: "test", CORVIS_DATABASE_DSN: "https://fake-postgres.test/sql" }));
});

test("optional capability bindings do not make unrelated production paths unstartable", () => {
  const config = getServerConfig(productionEnvironment());
  assert.equal(config.searchEndpoint, undefined);
  assert.equal(config.aiEndpoint, undefined);
  assert.equal(config.observabilityEndpoint, undefined);
  assert.equal(config.dataLifecycleEndpoint, undefined);
  assert.equal(config.workerSecret, undefined);
  assert.deepEqual(config.uploadAllowedOrigins, []);
});

test("optional bindings and delivery settings preserve explicit configured values", () => {
  const config = getServerConfig({
    NODE_ENV: "test",
    CORVIS_MALWARE_SCAN_METADATA_KEY: "scan-status",
    CORVIS_MALWARE_CLEAN_VALUE: "passed",
    CORVIS_MALWARE_THREAT_VALUE: "blocked",
    CORVIS_SEARCH_ENDPOINT: "https://search.example.test",
    CORVIS_SEARCH_API_TOKEN: "search-token",
    CORVIS_AI_ENDPOINT: "https://ai.example.test",
    CORVIS_AI_API_TOKEN: "ai-token",
    CORVIS_OBSERVABILITY_ENDPOINT: "https://otel.example.test",
    CORVIS_OBSERVABILITY_TOKEN: "otel-token",
    CORVIS_DATA_LIFECYCLE_ENDPOINT: "https://lifecycle.example.test",
    CORVIS_DATA_LIFECYCLE_TOKEN: "lifecycle-token",
    CORVIS_EXPORT_ARTIFACT_TTL_SECONDS: "3600",
    CORVIS_WORKER_SECRET: "worker-secret",
    CORVIS_OPERATIONS_TENANT_ID: "tenant-ops",
    CORVIS_EMAIL_PROVIDER: "  reviewed-provider  ",
    CORVIS_EMAIL_FROM: "  ops@example.test  ",
    CORVIS_PUBLIC_APP_URL: "https://app.example.test/path",
  });
  assert.equal(config.gcsMalwareMetadataKey, "scan-status");
  assert.equal(config.gcsMalwareCleanValue, "passed");
  assert.equal(config.gcsMalwareThreatValue, "blocked");
  assert.equal(config.searchEndpoint, "https://search.example.test");
  assert.equal(config.searchApiToken, "search-token");
  assert.equal(config.aiEndpoint, "https://ai.example.test");
  assert.equal(config.aiApiToken, "ai-token");
  assert.equal(config.observabilityEndpoint, "https://otel.example.test");
  assert.equal(config.observabilityToken, "otel-token");
  assert.equal(config.dataLifecycleEndpoint, "https://lifecycle.example.test");
  assert.equal(config.dataLifecycleToken, "lifecycle-token");
  assert.equal(config.exportArtifactTtlSeconds, 3600);
  assert.equal(config.workerSecret, "worker-secret");
  assert.equal(config.operationsTenantId, "tenant-ops");
  assert.equal(config.emailProvider, "reviewed-provider");
  assert.equal(config.emailFromAddress, "ops@example.test");
  assert.equal(config.publicAppUrl, "https://app.example.test");

  const blankEmail = getServerConfig({ NODE_ENV: "test", CORVIS_EMAIL_PROVIDER: "   ", CORVIS_EMAIL_FROM: "   " });
  assert.equal(blankEmail.emailProvider, "disabled");
  assert.equal(blankEmail.emailFromAddress, undefined);
});

test("production never permits demo mode", () => {
  assert.throws(
    () => getServerConfig({ ...productionEnvironment(), CORVIS_DEMO_MODE: "true" }),
    /CORVIS_DEMO_MODE must be disabled in production/,
  );
});

test("GCS resumable chunk size must be a positive 256 KiB multiple", () => {
  assert.throws(
    () => getServerConfig({ NODE_ENV: "test", CORVIS_GCS_CHUNK_SIZE_BYTES: "12345" }),
    /multiple of 256 KiB/,
  );
  assert.equal(
    getServerConfig({ NODE_ENV: "test", CORVIS_GCS_CHUNK_SIZE_BYTES: String(16 * 1024 * 1024) }).gcsChunkSizeBytes,
    16 * 1024 * 1024,
  );
});

test("comma-separated upload origins are normalized and empty entries removed", () => {
  const config = getServerConfig({
    NODE_ENV: "test",
    CORVIS_UPLOAD_ALLOWED_ORIGINS: " https://customer.example.com, ,https://admin.example.com ",
  });
  assert.deepEqual(config.uploadAllowedOrigins, ["https://customer.example.com", "https://admin.example.com"]);
});

test("bounded numeric configuration ignores invalid values and caps research timeout", () => {
  const config = getServerConfig({
    NODE_ENV: "test",
    CORVIS_RESEARCH_TIMEOUT_MS: "999999",
    CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE: "not-a-number",
  });
  assert.equal(config.researchTimeoutMs, 120_000);
  assert.equal(config.rateLimitRequestsPerMinute, 600);
});

const rawEnv = (env: Record<string, string | undefined>) => env as NodeJS.ProcessEnv;

test("only development, test and unset NODE_ENV are non-production; any other value fails closed to production", () => {
  assert.equal(getServerConfig(rawEnv({})).environment, "development");
  assert.equal(getServerConfig(rawEnv({ NODE_ENV: "" })).environment, "development");
  assert.equal(getServerConfig(rawEnv({ NODE_ENV: "development" })).environment, "development");
  assert.equal(getServerConfig({ NODE_ENV: "test" }).environment, "test");
  assert.equal(getServerConfig({ ...productionEnvironment(), NODE_ENV: "production" }).environment, "production");

  for (const nodeEnv of ["Production", "PRODUCTION", "staging", "prod", " production", "Development", "dev"]) {
    assert.throws(
      () => getServerConfig(rawEnv({ NODE_ENV: nodeEnv })),
      (error: unknown) => error instanceof Error && error.message.includes("Missing production configuration"),
      `NODE_ENV=${JSON.stringify(nodeEnv)} must be treated as production`,
    );
    assert.throws(() => getServerConfig(rawEnv({ ...productionEnvironment(), NODE_ENV: nodeEnv, CORVIS_DEMO_MODE: "true" })), /CORVIS_DEMO_MODE must be disabled in production/);
    assert.equal(getServerConfig(rawEnv({ ...productionEnvironment(), NODE_ENV: nodeEnv })).environment, "production");
  }
});