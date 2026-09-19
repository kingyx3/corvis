import assert from "node:assert/strict";
import test from "node:test";
import { apiError } from "./http.ts";
import { ResearchCancelledError, ResearchProviderError, ResearchTimeoutError } from "./research.ts";

async function payload(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test("research timeout maps to a stable 504 response", async () => {
  const response = apiError(new ResearchTimeoutError(), "cid-timeout");
  assert.equal(response.status, 504);
  assert.deepEqual(await payload(response), { error: "research_timeout", correlationId: "cid-timeout" });
});

test("research cancellation maps to a stable 499 response", async () => {
  const response = apiError(new ResearchCancelledError(), "cid-cancel");
  assert.equal(response.status, 499);
  assert.deepEqual(await payload(response), { error: "research_cancelled", correlationId: "cid-cancel" });
});

test("research provider failure maps to a stable 502 response without leaking provider details", async () => {
  const response = apiError(new ResearchProviderError("ai", 503), "cid-provider");
  assert.equal(response.status, 502);
  assert.deepEqual(await payload(response), { error: "research_provider_error", correlationId: "cid-provider" });
});
