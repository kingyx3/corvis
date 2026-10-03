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
