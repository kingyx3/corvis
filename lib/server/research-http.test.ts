import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

// Route modules use the Next.js "@/..." alias; see lib/server/source-connections-routes.test.ts.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";

const postgresStatements: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== process.env.CORVIS_POSTGRES_DSN) return originalFetch(input, init);
  const { sql } = JSON.parse(String(init?.body ?? "{}")) as { sql: string };
  postgresStatements.push(sql);
  return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { POST: researchPost } = await import("@/app/api/v1/research/route");
const { POST: researchStreamPost } = await import("@/app/api/v1/research/stream/route");
const { GET: sourceReferenceGet } = await import("@/app/api/v1/source-references/[sourceReferenceId]/route");

const demoHeaders = {
  "content-type": "application/json",
  "x-corvis-demo-tenant": "tenant-alpha",
  "x-corvis-demo-workspace": "workspace-1",
  "x-corvis-demo-subject": "demo-user",
  "x-corvis-demo-roles": "admin",
};

test("Ask Corvis execution failures have stable structured HTTP mappings", async () => {
  const source = await readFile("lib/server/http.ts", "utf8");
  assert.match(source, /error instanceof ResearchTimeoutError[\s\S]*error: error\.code[\s\S]*status: 504/);
  assert.match(source, /error instanceof ResearchCancelledError[\s\S]*error: error\.code[\s\S]*status: 499/);
  assert.match(source, /error instanceof ResearchProviderError[\s\S]*error: error\.code[\s\S]*status: 502/);
  assert.match(source, /research\.provider_error/);
  assert.equal(source.includes("error.provider, correlationId"), false, "provider identity must not be returned in the client error payload");
});

test("research endpoints answer malformed or mistyped bodies with 400 invalid_question, never 500", async () => {
  const bodies = ["{not json", "null", "[]", JSON.stringify({ question: 42 }), JSON.stringify({ question: { text: "q" } }), JSON.stringify({ question: "  " })];
  for (const handler of [researchPost, researchStreamPost]) {
    for (const body of bodies) {
      const response = await handler(new Request("https://corvis.test/api/v1/research", { method: "POST", headers: demoHeaders, body }));
      assert.equal(response.status, 400, `body ${body}`);
      assert.equal((await response.json() as { error: string }).error, "invalid_question");
    }
  }
});

test("research endpoint still answers a well-formed question", async () => {
  const response = await researchPost(new Request("https://corvis.test/api/v1/research", {
    method: "POST", headers: demoHeaders, body: JSON.stringify({ question: "What was revenue?" }),
  }));
  assert.equal(response.status, 200);
});

test("source reference lookup answers a non-uuid id with 404 without reaching the uuid cast in SQL", async () => {
  postgresStatements.length = 0;
  const response = await sourceReferenceGet(
    new Request("https://corvis.test/api/v1/source-references/not-a-uuid", { headers: demoHeaders }),
    { params: Promise.resolve({ sourceReferenceId: "not-a-uuid" }) },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json() as { error: string }).error, "source_reference_not_found");
  assert.equal(postgresStatements.some((sql) => sql.includes("corvis_serving.source_references")), false);
});
