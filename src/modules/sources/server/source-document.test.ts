import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { originalSourceDocument } from "./source-document.ts";
const tenant = "00000000-0000-0000-0000-000000000010", document = "00000000-0000-0000-0000-000000000020";
const identity: RequestIdentity = { subject: "user", authMethod: "oidc", tenantId: tenant, workspaceId: tenant, roles: ["analyst"], sessionId: "session", entitlements: { workspaceIds: [tenant], fundIds: [], documentIds: [document], sourceDocumentIds: [document], sourceDocumentAccessAllowed: true, redistributionAllowed: false } };
function deps(overrides = {}) {
  const calls: unknown[] = []; const row = { document_id: document, object_uri: `gs://bucket/tenant=${tenant}/document=${document}/artifact=a/original/report.pdf`, storage_generation: "42", media_type: "application/pdf", display_name: "Report.pdf", sha256: "checksum", ...overrides };
  const db = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [row]; } } as unknown as PostgresSqlApi;
  const store = { bucket: "bucket", getObjectStream: async (key: string, generation?: string) => { calls.push({ key, generation }); return { body: new ReadableStream<Uint8Array>() }; } };
  return { calls, db, store, audit: async () => {} };
}
test("original reads are tenant-bound, clean/released, audited, and pinned to the referenced generation", async () => {
  const d = deps(); const result = await originalSourceDocument(identity, document, d); assert.equal(result?.contentType, "application/pdf");
  assert.match(JSON.stringify(d.calls[0]), /malware_scan_status='clean'/); assert.match(JSON.stringify(d.calls[0]), /quarantine_status='released'/);
  assert.deepEqual(d.calls[1], { key: `tenant=${tenant}/document=${document}/artifact=a/original/report.pdf`, generation: "42" });
});
test("revoked source rights fail before provider IO", async () => {
  const d = deps(); await assert.rejects(originalSourceDocument({ ...identity, entitlements: { ...identity.entitlements, sourceDocumentIds: [] } }, document, d)); assert.equal(d.calls.length, 1);
});
test("cross-tenant object paths and missing immutable generations fail closed", async () => {
  for (const row of [{ object_uri: "gs://bucket/tenant=other/document=other/report.pdf" }, { storage_generation: null }]) { const d = deps(row); await assert.rejects(originalSourceDocument(identity, document, d), /invalid_source_object/); assert.equal(d.calls.length, 1); }
});
