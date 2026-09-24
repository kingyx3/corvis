import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// http.ts imports route-facing modules through the Next.js "@/..." alias.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const { apiError, correlationId } = await import("@/lib/server/http");
const { InvalidIdempotencyKeyError } = await import("@/lib/server/idempotency");

function withCorrelation(value: string): Request {
  return new Request("https://corvis.test/api/v1/me", { headers: { "x-correlation-id": value } });
}

test("correlationId echoes a bounded log-safe client id", () => {
  assert.equal(correlationId(withCorrelation("corr-1.a:b_C")), "corr-1.a:b_C");
});

test("correlationId replaces oversized or unsafe client ids instead of reflecting them", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const value of ["x".repeat(129), "evil id with spaces", "<script>", "a\"b"]) {
    assert.match(correlationId(withCorrelation(value)), uuid);
  }
  assert.match(correlationId(new Request("https://corvis.test/")), uuid);
});

test("a malformed JSON request body is a 400 invalid_json, not a 500", async () => {
  const request = new Request("https://corvis.test/api/v1/exports", { method: "POST", body: "{not json" });
  const error = await request.json().then(() => undefined, (reason: unknown) => reason);
  const response = apiError(error, "corr-json");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json", correlationId: "corr-json" });
  // Unrelated failures still fall through to the opaque 500.
  const internal = apiError(new Error("boom select * from secret"), "corr-2");
  assert.equal(internal.status, 500);
  assert.deepEqual(await internal.json(), { error: "internal_error", correlationId: "corr-2" });
});

test("an invalid idempotency key is a 400 with a stable code, not a 500", async () => {
  const response = apiError(new InvalidIdempotencyKeyError(), "corr-1");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_idempotency_key", correlationId: "corr-1" });
});
