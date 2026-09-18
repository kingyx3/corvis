import test from "node:test";
import assert from "node:assert/strict";
import { getServerConfig } from "./config.ts";

test("production rejects demo mode", () => {
  assert.throws(() => getServerConfig({ NODE_ENV: "production", CORVIS_DEMO_MODE: "true" } as NodeJS.ProcessEnv));
});

test("production requires enterprise bindings", () => {
  assert.throws(() => getServerConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv), /Missing production configuration/);
});

test("fully configured production environment is accepted", () => {
  const config = getServerConfig({
    NODE_ENV: "production",
    CORVIS_AUTH_ISSUER: "https://idp.example.com",
    CORVIS_AUTH_AUDIENCE: "corvis",
    CORVIS_SNOWFLAKE_DSN: "snowflake://account",
    CORVIS_OBJECT_STORE_BUCKET: "corvis-prod",
    CORVIS_SEARCH_ENDPOINT: "https://search.example.com",
  } as NodeJS.ProcessEnv);
  assert.equal(config.demoMode, false);
  assert.equal(config.environment, "production");
});
