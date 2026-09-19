import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Ask Corvis execution failures have stable structured HTTP mappings", async () => {
  const source = await readFile("lib/server/http.ts", "utf8");
  assert.match(source, /error instanceof ResearchTimeoutError[\s\S]*error: error\.code[\s\S]*status: 504/);
  assert.match(source, /error instanceof ResearchCancelledError[\s\S]*error: error\.code[\s\S]*status: 499/);
  assert.match(source, /error instanceof ResearchProviderError[\s\S]*error: error\.code[\s\S]*status: 502/);
  assert.match(source, /research\.provider_error/);
  assert.equal(source.includes("error.provider, correlationId"), false, "provider identity must not be returned in the client error payload");
});
