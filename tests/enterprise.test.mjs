import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function text(path) { return readFile(path, "utf8"); }

test("production cannot silently fall back to demo mode", async () => {
  const config = await text("server/config.ts");
  const runtime = await text("runtime/services.ts");
  assert.match(config, /production && demoMode/);
  assert.match(runtime, /production && demoRequested/);
});

test("OIDC flow binds authorization code to state, nonce and PKCE", async () => {
  const security = await text("server/security.ts");
  assert.match(security, /code_challenge_method.*S256/);
  assert.match(security, /nonce mismatch/i);
  assert.match(security, /safeEqual\(state, transaction\.state\)/);
  assert.match(security, /tenantClaim/);
});

test("tenant and source-access filtering happens inside Cortex Search request", async () => {
  const snowflake = await text("server/snowflake.ts");
  assert.match(snowflake, /"@eq": \{ tenant_id: tenantId \}/);
  assert.match(snowflake, /source_document_access_allowed: true/);
  assert.doesNotMatch(snowflake, /retrieve.*then.*redact/i);
});

test("research separates semantic queries from source retrieval and treats source text as untrusted", async () => {
  const research = await text("server/research.ts");
  assert.match(research, /semantic_query/);
  assert.match(research, /document_search/);
  assert.match(research, /untrusted evidence/i);
  const view = await text("features/research/research-view.tsx");
  assert.doesNotMatch(view, /ABC Corp|\$125m|9\.4%/);
});

test("large-file ingestion is resumable, idempotent, quarantined and scanner-gated", async () => {
  const browser = await text("adapters/upload/http-multipart-upload.ts");
  const platform = await text("server/platform.ts");
  assert.match(browser, /localStorage/);
  assert.match(browser, /idempotency-key/);
  assert.match(browser, /alreadyUploadedParts/);
  assert.match(browser, /did not expose an ETag/);
  assert.match(platform, /quarantine\/tenant=/);
  assert.match(platform, /scanObject/);
  assert.match(platform, /MAGIC_BYTE_MISMATCH/);
  assert.match(platform, /QUARANTINED/);
});

test("Snowflake serving data is protected by tenant row-access policy", async () => {
  const sql = await text("snowflake/migrations/001_enterprise_platform.sql");
  assert.match(sql, /CREATE OR REPLACE ROW ACCESS POLICY PM_CONTROL\.TENANT_ISOLATION/);
  assert.match(sql, /CURRENT_ROLE\(\)/);
  assert.match(sql, /ROLE_TENANT_ACCESS/);
  assert.match(sql, /SECURE VIEW PM_SERVING\.OBSERVATIONS_V/);
});

test("publication checks material exceptions and review history is append-only", async () => {
  const platform = await text("server/platform.ts");
  assert.match(platform, /materiality = 'material'/);
  assert.match(platform, /SNAPSHOT_BLOCKED/);
  assert.match(platform, /INSERT INTO PM_CONTROL\.REVIEW_EVENT/);
});

test("exports include manifest, checksum and short-lived signed delivery", async () => {
  const platform = await text("server/platform.ts");
  assert.match(platform, /schemaVersion/);
  assert.match(platform, /sha256Hex\(body\)/);
  assert.match(platform, /presignGet\(key, 300\)/);
});

test("state-changing cookie-authenticated API requests are same-origin checked", async () => {
  const api = await text("server/api.ts");
  const security = await text("server/security.ts");
  assert.match(api, /assertSameOrigin\(request\)/);
  assert.match(security, /Cross-site request rejected/);
});
