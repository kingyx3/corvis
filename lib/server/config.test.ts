import assert from "node:assert/strict";
import test from "node:test";
import { getServerConfig } from "./config.ts";

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    CORVIS_AUTH_ISSUER: "https://idp.example.com",
    CORVIS_AUTH_AUDIENCE: "corvis",
    CORVIS_POSTGRES_DSN: "postgresql://corvis:secret@db.example.com:5432/postgres?sslmode=require",
    CORVIS_OBJECT_STORE_BUCKET: "corvis-prod",
  };
}

test("configuration retains safe local defaults", () => {
  const config = getServerConfig({ NODE_ENV: "test" });
  assert.equal(config.environment, "test");
  assert.equal(config.demoMode, false);
  assert.equal(config.gcsChunkSizeBytes, 8 * 1024 * 1024);
  assert.equal(config.researchTimeoutMs, 30_000);
  assert.equal(config.rateLimitRequestsPerMinute, 600);
  assert.deepEqual(config.uploadAllowedOrigins, []);
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

test("production requires only authoritative cross-cutting auth, Postgres and object-store roots", () => {
  assert.doesNotThrow(() => getServerConfig(productionEnvironment()));

  for (const required of [
    "CORVIS_AUTH_ISSUER",
    "CORVIS_AUTH_AUDIENCE",
    "CORVIS_POSTGRES_DSN",
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
