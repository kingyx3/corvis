import assert from "node:assert/strict";
import test from "node:test";
import { checkBrowserRequest } from "./request-security.ts";

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
