import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is
// needed: route modules use the Next.js "@/..." path alias that plain
// `node --test` cannot resolve on its own.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";

const { POST: initiatePost } = await import("@/app/api/v1/uploads/initiate/route");
const { POST: recoverPost } = await import("@/app/api/v1/jobs/[jobId]/recover/route");

function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://corvis.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corvis-demo-tenant": "tenant-alpha",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": "demo-admin",
      "x-corvis-demo-roles": "admin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

test("POST /uploads/initiate answers malformed bodies with 400 instead of a 500", async () => {
  const nullBody = await initiatePost(request("/api/v1/uploads/initiate", null));
  assert.equal(nullBody.status, 400);
  assert.equal(await errorOf(nullBody), "invalid_upload_request");

  const objectKey = await initiatePost(request("/api/v1/uploads/initiate", {
    fileName: "report.pdf", contentType: "application/pdf", sizeBytes: 1024, idempotencyKey: { nested: true },
  }));
  assert.equal(objectKey.status, 400);
  assert.equal(await errorOf(objectKey), "invalid_upload_request");

  const arrayName = await initiatePost(request("/api/v1/uploads/initiate", {
    fileName: ["report.pdf"], contentType: "application/pdf", sizeBytes: 1024,
  }));
  assert.equal(arrayName.status, 400);
  assert.equal(await errorOf(arrayName), "invalid_upload_request");
});

test("POST /jobs/{jobId}/recover rejects non-string command fields with 400 instead of a 500", async () => {
  const context = { params: Promise.resolve({ jobId: "registered:33333333-3333-4333-8333-333333333333" }) };
  for (const body of [
    null,
    { expectedVersion: 2, reasonCode: 42 },
    { expectedVersion: 2, reasonCode: "operator_recovery", note: 7 },
  ]) {
    const response = await recoverPost(request("/api/v1/jobs/x/recover", body, { "idempotency-key": "recover-1" }), context);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(await errorOf(response), "invalid_processing_recovery_command");
  }
});

test("POST /jobs/{jobId}/recover maps a reused idempotency key to 409, not 500", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("app/api/v1/jobs/[jobId]/recover/route.ts", "utf8"));
  assert.match(source, /result\.reason === "idempotency_conflict"[\s\S]*?status: 409/);
});
