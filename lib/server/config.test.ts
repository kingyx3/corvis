import test from "node:test";
import assert from "node:assert/strict";
import { getServerConfig } from "./config.ts";

test("production rejects demo mode", () => {
  assert.throws(() => getServerConfig({ NODE_ENV: "production", CORVIS_DEMO_MODE: "true" } as NodeJS.ProcessEnv));
});

test("production requires enterprise bindings", () => {
  assert.throws(() => getServerConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv), /Missing production configuration/);
});

test("GCS resumable chunk size must be a multiple of 256 KiB", () => {
  assert.throws(() => getServerConfig({ NODE_ENV: "test", CORVIS_GCS_CHUNK_SIZE_BYTES: "1000000" } as NodeJS.ProcessEnv), /multiple of 256 KiB/);
});

test("fully configured production environment is accepted", () => {
  const config = getServerConfig({
    NODE_ENV: "production",
    CORVIS_AUTH_ISSUER: "https://idp.example.com",
    CORVIS_AUTH_AUDIENCE: "corvis",
    CORVIS_TRUSTED_AUTH_PROXY_SECRET: "test-only-secret",
    CORVIS_SNOWFLAKE_SQL_API_URL: "https://account.snowflakecomputing.com",
    CORVIS_SNOWFLAKE_OAUTH_TOKEN: "test-token",
    CORVIS_SNOWFLAKE_DATABASE: "CORVIS",
    CORVIS_SNOWFLAKE_WAREHOUSE: "CORVIS_APP",
    CORVIS_SNOWFLAKE_ROLE: "CORVIS_APP_ROLE",
    CORVIS_OBJECT_STORE_BUCKET: "corvis-prod",
    CORVIS_UPLOAD_ALLOWED_ORIGINS: "https://customer.example.com,https://admin.example.com",
    CORVIS_GCS_CHUNK_SIZE_BYTES: String(8 * 1024 * 1024),
    CORVIS_SEARCH_ENDPOINT: "https://search.example.com",
    CORVIS_AI_ENDPOINT: "https://ai.example.com",
    CORVIS_OBSERVABILITY_ENDPOINT: "https://telemetry.example.com/events",
    CORVIS_WEBHOOK_SIGNING_SECRET: "webhook-test-secret",
    CORVIS_DATA_LIFECYCLE_ENDPOINT: "https://lifecycle.example.com",
    CORVIS_EXPORT_DELIVERY_ENDPOINT: "https://delivery.example.com",
    CORVIS_WORKER_SECRET: "worker-secret",
  } as NodeJS.ProcessEnv);
  assert.equal(config.demoMode, false);
  assert.equal(config.environment, "production");
  assert.equal(config.trustedAuthProxySecret, "test-only-secret");
  assert.equal(config.snowflakeDatabase, "CORVIS");
  assert.equal(config.objectStoreBucket, "corvis-prod");
  assert.deepEqual(config.uploadAllowedOrigins, ["https://customer.example.com", "https://admin.example.com"]);
  assert.equal(config.gcsChunkSizeBytes, 8 * 1024 * 1024);
  assert.equal(config.observabilityEndpoint, "https://telemetry.example.com/events");
  assert.equal(config.dataLifecycleEndpoint, "https://lifecycle.example.com");
});
