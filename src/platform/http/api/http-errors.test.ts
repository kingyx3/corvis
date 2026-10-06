import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// http.ts imports route-facing modules through the Next.js "@/..." alias.
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const { apiError } = await import("@/platform/http/api/http");
const { PublicationGateError } = await import("@/platform/data/platform");
const { DeletionExecutionError, LegalHoldError } = await import("@/modules/governance/server/lifecycle/data-lifecycle");
const { ResearchCancelledError, ResearchProviderError, ResearchTimeoutError } = await import("@/modules/research/server/research");

test("domain failures keep their own status and stable code, and an unknown failure is an opaque 500", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "info", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const cases: Array<[unknown, number, Record<string, unknown>]> = [
    [new PublicationGateError(["open correction"]), 409, { error: "publication_blocked", reasons: ["open correction"] }],
    [new LegalHoldError([]), 409, { error: "deletion_blocked_by_legal_hold", holds: [] }],
    [new DeletionExecutionError("deletion_not_ready"), 422, { error: "deletion_not_ready" }],
    [new ResearchTimeoutError(), 504, { error: "research_timeout" }],
    [new ResearchCancelledError(), 499, { error: "research_cancelled" }],
    [new ResearchProviderError("ai", 503), 502, { error: "research_provider_error" }],
    [new ResearchProviderError("search"), 502, { error: "research_provider_error" }],
    [new SyntaxError("Unexpected end of JSON input"), 400, { error: "invalid_json" }],
    [new Error("database exploded"), 500, { error: "internal_error" }],
    ["thrown string", 500, { error: "internal_error" }],
  ];
  for (const [error, status, body] of cases) {
    const response = apiError(error, "corr-domain");
    assert.equal(response.status, status, String(error));
    assert.deepEqual(await response.json(), { ...body, correlationId: "corr-domain" });
  }
});
