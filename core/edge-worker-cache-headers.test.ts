import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type Worker = { fetch(request: Request, env: Record<string, string>): Promise<Response> };

const IMMUTABLE = "public, max-age=31536000, immutable";
const env = {
  PUBLIC_HOSTNAME: "app.example.test",
  API_GATEWAY_HOST: "api-gw.example.test",
  API_GATEWAY_API_KEY: "api-key",
  CUSTOMER_GATEWAY_HOST: "customer-gw.example.test",
  CUSTOMER_GATEWAY_API_KEY: "customer-key",
  ADMIN_GATEWAY_HOST: "admin-gw.example.test",
  ADMIN_GATEWAY_API_KEY: "admin-key",
};

const workers: Array<{ name: string; path: string; uiPath: string; apiPath: string; frame: boolean }> = [
  {
    name: "customer",
    path: "infra/terraform/modules/cloudflare-customer-edge/customer-proxy.mjs",
    uiPath: "/dashboard",
    apiPath: "/api/v1/health",
    frame: false,
  },
  {
    name: "admin",
    path: "infra/terraform/modules/cloudflare-admin-edge/admin-proxy.mjs",
    uiPath: "/admin/readiness",
    apiPath: "/api/v1/admin/jobs",
    frame: true,
  },
];

async function callWorker(
  workerPath: string,
  pathname: string,
  origin: { status?: number; headers?: Record<string, string> },
): Promise<Response> {
  const worker = (await import(pathToFileURL(join(process.cwd(), workerPath)).href)).default as Worker;
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("body", { status: origin.status ?? 200, headers: origin.headers })) as typeof fetch;
  try {
    return await worker.fetch(new Request(`https://${env.PUBLIC_HOSTNAME}${pathname}`), env);
  } finally {
    globalThis.fetch = original;
  }
}

for (const worker of workers) {
  test(`${worker.name} edge passes through origin cache headers for /_next/static/ only`, async () => {
    const response = await callWorker(worker.path, "/_next/static/chunks/app-abc123.js", {
      headers: { "cache-control": IMMUTABLE, etag: '"abc"' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), IMMUTABLE);
    assert.equal(response.headers.get("etag"), '"abc"');
    // Security headers still apply to cacheable static responses.
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-corvis-edge-proxy"), "cloudflare-worker");
    assert.ok(response.headers.get("referrer-policy"));
    if (worker.frame) assert.equal(response.headers.get("x-frame-options"), "DENY");
  });

  test(`${worker.name} edge keeps private, no-store for everything else`, async () => {
    // The origin claims immutable caching, but only /_next/static/ may keep it.
    for (const pathname of [worker.uiPath, "/_next/image", "/_next/data/build/page.json", "/favicon.ico", worker.apiPath]) {
      const response = await callWorker(worker.path, pathname, { headers: { "cache-control": IMMUTABLE } });
      assert.equal(response.headers.get("cache-control"), "private, no-store", pathname);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", pathname);
    }
  });

  test(`${worker.name} edge does not cache static-path errors, cookies or unmarked responses`, async () => {
    const staticPath = "/_next/static/chunks/app-abc123.js";
    const notFound = await callWorker(worker.path, staticPath, { status: 404, headers: { "cache-control": IMMUTABLE } });
    assert.equal(notFound.headers.get("cache-control"), "private, no-store");

    const cookie = await callWorker(worker.path, staticPath, {
      headers: { "cache-control": IMMUTABLE, "set-cookie": "sid=1; Path=/" },
    });
    assert.equal(cookie.headers.get("cache-control"), "private, no-store");

    const unmarked = await callWorker(worker.path, staticPath, {});
    assert.equal(unmarked.headers.get("cache-control"), "private, no-store");

    const privateOrigin = await callWorker(worker.path, staticPath, { headers: { "cache-control": "private, max-age=60" } });
    assert.equal(privateOrigin.headers.get("cache-control"), "private, no-store");
  });

  test(`${worker.name} edge does not let traversal-style paths borrow the static exception`, async () => {
    const response = await callWorker(worker.path, "/_next/static/../../admin/x", {
      headers: { "cache-control": IMMUTABLE },
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  });
}
