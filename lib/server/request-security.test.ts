import assert from "node:assert/strict";
import test from "node:test";
import { browserRequestPolicyFromEnv, checkBrowserRequest } from "./request-security.ts";

function request(method: string, headers: HeadersInit = {}) {
  return new Request("https://app.corvis.example/api/v1/exports", { method, headers });
}

test("same-origin state-changing browser requests are allowed", () => {
  assert.deepEqual(checkBrowserRequest(request("POST", {
    origin: "https://app.corvis.example",
    "sec-fetch-site": "same-origin",
  })), { allowed: true });
});

test("cross-origin state-changing browser requests are rejected", () => {
  assert.deepEqual(checkBrowserRequest(request("POST", {
    origin: "https://attacker.example",
    "sec-fetch-site": "cross-site",
  })), { allowed: false, code: "cross_origin_browser_request" });
});

test("cross-site fetch metadata is rejected even without an Origin header", () => {
  assert.deepEqual(checkBrowserRequest(request("DELETE", {
    "sec-fetch-site": "cross-site",
  })), { allowed: false, code: "cross_origin_browser_request" });
});

test("CORS preflight is rejected because the browser API is same-origin only", () => {
  assert.deepEqual(checkBrowserRequest(request("OPTIONS", {
    origin: "https://attacker.example",
    "access-control-request-method": "POST",
  })), { allowed: false, code: "cors_preflight_not_supported" });
});

test("opaque and malformed origins fail closed", () => {
  assert.deepEqual(checkBrowserRequest(request("POST", { origin: "null" })), { allowed: false, code: "invalid_origin" });
  assert.deepEqual(checkBrowserRequest(request("POST", { origin: "not a url" })), { allowed: false, code: "invalid_origin" });
});

test("safe cross-origin requests are not treated as CSRF mutations", () => {
  assert.deepEqual(checkBrowserRequest(request("GET", {
    origin: "https://attacker.example",
    "sec-fetch-site": "cross-site",
  })), { allowed: true });
});

test("non-browser state-changing clients remain eligible for normal authentication", () => {
  assert.deepEqual(checkBrowserRequest(request("POST")), { allowed: true });
});

test("deployed browser writes are accepted from configured public origins even when request.url is the bind address", () => {
  const policy = browserRequestPolicyFromEnv({
    NODE_ENV: "production",
    CORVIS_BROWSER_ALLOWED_ORIGINS: " https://app.corvis.example , https://admin.corvis.example/ ,not a url",
  });
  assert.deepEqual(policy, { production: true, allowedOrigins: ["https://app.corvis.example", "https://admin.corvis.example"] });
  const bound = (headers: HeadersInit, method = "POST") => new Request("http://0.0.0.0:3000/api/v1/uploads/initiate", { method, headers });
  for (const origin of ["https://app.corvis.example", "https://admin.corvis.example"]) {
    assert.deepEqual(checkBrowserRequest(bound({ origin, "sec-fetch-site": "same-site" }), policy), { allowed: true });
  }
  assert.deepEqual(checkBrowserRequest(bound({ origin: "https://attacker.example" }), policy), { allowed: false, code: "cross_origin_browser_request" });
  assert.deepEqual(checkBrowserRequest(bound({ origin: "https://app.corvis.example", "sec-fetch-site": "cross-site" }), policy), { allowed: false, code: "cross_origin_browser_request" });
  assert.deepEqual(checkBrowserRequest(bound({ origin: "null" }), policy), { allowed: false, code: "invalid_origin" });
  assert.deepEqual(checkBrowserRequest(bound({}), policy), { allowed: true });
  assert.deepEqual(checkBrowserRequest(bound({ origin: "https://app.corvis.example" }, "OPTIONS"), policy), { allowed: false, code: "cors_preflight_not_supported" });
});

test("production with an allow-list does not fall back to request.url same-origin matching", () => {
  const policy = { allowedOrigins: ["https://app.corvis.example"], production: true };
  const runApp = new Request("https://corvis-api-uat-xyz.a.run.app/api/v1/exports", { method: "POST", headers: { origin: "https://corvis-api-uat-xyz.a.run.app" } });
  assert.deepEqual(checkBrowserRequest(runApp, policy), { allowed: false, code: "cross_origin_browser_request" });
});

test("local and unconfigured runtimes keep the request.url same-origin fallback", () => {
  const local = new Request("http://localhost:3000/api/v1/exports", { method: "POST", headers: { origin: "http://localhost:3000" } });
  assert.deepEqual(checkBrowserRequest(local, { allowedOrigins: ["https://app.corvis.example"], production: false }), { allowed: true });
  assert.deepEqual(checkBrowserRequest(local, { allowedOrigins: [], production: true }), { allowed: true });
  assert.deepEqual(checkBrowserRequest(
    new Request("http://localhost:3000/api/v1/exports", { method: "POST", headers: { origin: "https://attacker.example" } }),
    { allowedOrigins: [], production: false },
  ), { allowed: false, code: "cross_origin_browser_request" });
});
