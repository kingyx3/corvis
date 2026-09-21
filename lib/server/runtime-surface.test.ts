import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRuntimeSurface, runtimeSurfaceAllows } from "./runtime-surface.ts";

test("production runtime surface derives from the Cloud Run service name", () => {
  assert.equal(resolveRuntimeSurface(undefined, { nodeEnv: "production", serviceName: "corvis-api-uat" }), "api");
  assert.equal(resolveRuntimeSurface(undefined, { nodeEnv: "production", serviceName: "corvis-worker-prod" }), "worker");
  assert.equal(resolveRuntimeSurface(undefined, { nodeEnv: "production", serviceName: "corvis-admin-uat" }), "admin");
  assert.equal(resolveRuntimeSurface(undefined, { nodeEnv: "production", serviceName: "corvis-customer-prod" }), "customer");
});

test("production runtime surface fails closed when service identity is unknown", () => {
  assert.equal(resolveRuntimeSurface(undefined, { nodeEnv: "production", demoMode: "false" }), "disabled");
  assert.equal(resolveRuntimeSurface("unexpected", { nodeEnv: "production", serviceName: "other-service" }), "disabled");
  assert.equal(runtimeSurfaceAllows("disabled", "/api/v1/health"), true);
  assert.equal(runtimeSurfaceAllows("disabled", "/api/v1/funds"), false);
});

test("explicit surface overrides deterministic service-name derivation", () => {
  assert.equal(resolveRuntimeSurface("admin", { nodeEnv: "production", serviceName: "corvis-api-uat" }), "admin");
});

test("local and explicit demo mode retain the combined developer surface", () => {
  assert.equal(resolveRuntimeSurface(undefined, { nodeEnv: "development" }), "combined");
  assert.equal(resolveRuntimeSurface(undefined, { nodeEnv: "production", demoMode: "true" }), "combined");
});

test("api runtime cannot serve browser pages or internal worker endpoints", () => {
  assert.equal(runtimeSurfaceAllows("api", "/api/v1/funds"), true);
  assert.equal(runtimeSurfaceAllows("api", "/api/v1/admin/readiness"), true);
  assert.equal(runtimeSurfaceAllows("api", "/api/internal/delivery"), false);
  assert.equal(runtimeSurfaceAllows("api", "/"), false);
  assert.equal(runtimeSurfaceAllows("api", "/admin"), false);
});

test("worker runtime exposes only internal endpoints plus health", () => {
  assert.equal(runtimeSurfaceAllows("worker", "/api/internal/delivery"), true);
  assert.equal(runtimeSurfaceAllows("worker", "/api/internal/processing-stage"), true);
  assert.equal(runtimeSurfaceAllows("worker", "/api/v1/health"), true);
  assert.equal(runtimeSurfaceAllows("worker", "/api/v1/funds"), false);
  assert.equal(runtimeSurfaceAllows("worker", "/"), false);
});

test("admin and customer contracts are mutually isolated", () => {
  assert.equal(runtimeSurfaceAllows("admin", "/admin"), true);
  assert.equal(runtimeSurfaceAllows("admin", "/api/v1/admin/feature-flags"), true);
  assert.equal(runtimeSurfaceAllows("admin", "/api/v1/funds"), false);
  assert.equal(runtimeSurfaceAllows("admin", "/workspace"), false);

  assert.equal(runtimeSurfaceAllows("customer", "/"), true);
  assert.equal(runtimeSurfaceAllows("customer", "/workspace"), true);
  assert.equal(runtimeSurfaceAllows("customer", "/_next/static/chunk.js"), true);
  assert.equal(runtimeSurfaceAllows("customer", "/admin"), false);
  assert.equal(runtimeSurfaceAllows("customer", "/api/v1/admin/readiness"), false);
  assert.equal(runtimeSurfaceAllows("customer", "/api/v1/funds"), false);
});
