import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { proxy } from "../../proxy.ts";

const ORIGIN = "https://app.corvis.example";

function call(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return proxy(new NextRequest(`${ORIGIN}${path}`, init));
}

test("a cross-site state-changing API request is rejected before reaching a route", async () => {
  const response = call("/api/v1/exports", {
    method: "POST",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "cross_origin_browser_request" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("CORS preflight to the API is rejected", async () => {
  const response = call("/api/v1/exports", {
    method: "OPTIONS",
    headers: { origin: "https://attacker.example", "access-control-request-method": "POST" },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "cors_preflight_not_supported" });
});

test("a same-origin API request passes through uncached and varies on origin metadata", () => {
  const response = call("/api/v1/funds", { headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("vary") ?? "", /Origin/);
});

test("pages are never cached, but content-hashed static assets keep Next's caching", () => {
  assert.equal(call("/").headers.get("cache-control"), "no-store");
  assert.equal(call("/_next/static/chunks/app.js").headers.get("cache-control"), null);
});
