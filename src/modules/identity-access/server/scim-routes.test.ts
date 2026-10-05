import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Route modules use the Next.js "@/..." path alias that plain `node --test`
// cannot resolve on its own (see upload-job-routes.test.ts).
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "3";
// Nothing listens here: a request that reaches the database fails fast with a connection error.
process.env.CORVIS_POSTGRES_DSN = "postgres://scim:dummy@127.0.0.1:1/db?sslmode=disable";

const { GET } = await import("@/app/api/v1/scim/v2/Users/route");
const { resetScimRateLimiters } = await import("@/modules/identity-access/server/scim");

const tenant = "11111111-1111-4111-8111-111111111111";
const token = "t".repeat(43);

function request(headers: Record<string, string>): Request {
  return new Request("https://corvis.test/api/v1/scim/v2/Users", { headers: { "x-corvis-tenant": tenant, ...headers } });
}

test("the SCIM route throttles callers before the database and returns Retry-After", { concurrency: false }, async () => {
  resetScimRateLimiters();
  const statuses: number[] = [];
  let limited: Response | undefined;
  for (let i = 0; i < 5; i += 1) {
    const response = await GET(request({ authorization: "Bearer not-a-scim-token", "x-forwarded-for": "203.0.113.5" }));
    statuses.push(response.status);
    if (response.status === 429) limited ??= response;
  }
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  assert.ok(Number(limited!.headers.get("retry-after")) >= 1);
  const body = await limited!.json() as { schemas: string[]; status: string };
  assert.equal(body.status, "429");
  assert.deepEqual(body.schemas, ["urn:ietf:params:scim:api:messages:2.0:Error"]);
});

test("a gateway-shaped SCIM request uses X-Forwarded-Authorization and a database outage is a retryable 503", { concurrency: false }, async () => {
  resetScimRateLimiters();
  const response = await GET(request({
    authorization: "Bearer gateway.service-account.token",
    "x-forwarded-authorization": `Bearer ${token}`,
    "x-forwarded-for": "198.51.100.20",
  }));
  // Reaching the database (rather than failing the token shape check with 401) proves the forwarded header was used.
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
});
