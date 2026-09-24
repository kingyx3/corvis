import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is
// needed: route modules use the Next.js "@/..." path alias.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";

const { POST: reviewPost } = await import("@/app/api/v1/review/route");
const { POST: publishPost } = await import("@/app/api/v1/snapshots/publish/route");
const { GET: exceptionsGet } = await import("@/app/api/v1/reconciliation-exceptions/route");

function request(path: string, body: unknown, method = "POST"): Request {
  return new Request(`https://corvis.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-corvis-demo-tenant": "tenant-review-routes",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": "demo-user",
      "x-corvis-demo-roles": "admin",
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

const validReview = { observationId: "obs-1", decision: "approve", reasonCode: "SOURCE_VERIFIED", expectedVersion: 1 };
const validPublish = { snapshotId: "snap-1", action: "publish", expectedVersion: 1 };

test("POST /review accepts a valid command", async () => {
  const response = await reviewPost(request("/api/v1/review", validReview));
  assert.equal(response.status, 202);
});

test("POST /review answers 400 (not 500) for null/array bodies, wrong field types and out-of-range versions", async () => {
  const bodies: unknown[] = [
    null,
    [],
    { ...validReview, observationId: 12 },
    { ...validReview, reasonCode: { code: "x" } },
    { ...validReview, expectedVersion: 0 },
    { ...validReview, expectedVersion: 2 ** 31 },
    { ...validReview, correctedValue: 5 },
  ];
  for (const body of bodies) {
    const response = await reviewPost(request("/api/v1/review", body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("POST /review rejects a correction without a corrected value as 400 instead of failing inside persistence", async () => {
  const response = await reviewPost(request("/api/v1/review", { ...validReview, decision: "correct" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, "corrected_value_required");
});

test("POST /snapshots/publish answers 400 (not 500) for null/array bodies, wrong field types and out-of-range versions", async () => {
  const bodies: unknown[] = [
    null,
    [],
    { ...validPublish, snapshotId: ["snap-1"] },
    { ...validPublish, expectedVersion: -1 },
    { ...validPublish, expectedVersion: 2 ** 31 },
    { ...validPublish, reason: { text: "why" } },
  ];
  for (const body of bodies) {
    const response = await publishPost(request("/api/v1/snapshots/publish", body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await publishPost(request("/api/v1/snapshots/publish", validPublish))).status, 202);
});

test("GET /reconciliation-exceptions rejects a snapshot version beyond the integer column range", async () => {
  const response = await exceptionsGet(request(`/api/v1/reconciliation-exceptions?snapshotId=snap-1&snapshotVersion=${2 ** 31}`, undefined, "GET"));
  assert.equal(response.status, 400);
});
