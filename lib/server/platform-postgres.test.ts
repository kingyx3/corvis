import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { PostgresProductionPlatform } from "./platform.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };

class FakeDb implements PostgresSqlApi {
  calls: Call[] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("from corvis_facts.observation o")) {
      return [{ observation_id: parameters[1], version: 2, review_state: "review_required", value_number: 100, risk_tier: "normal" }];
    }
    if (sql.includes("apply_review_decision")) return [{ new_version: 3, next_state: "approved" }];
    if (sql.includes("corvis_serving.documents")) return [{
      document_id: "00000000-0000-0000-0000-000000000101",
      display_name: "Q2 report.pdf", fund_name: "Fund A", report_period: "2026 Q2",
      document_type: "Quarterly report", page_count: 20, size_bytes: 1024,
      status: "review", quality: "high", observation_count: 10, created_at: "2026-07-01T00:00:00Z",
    }];
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }
}

const identity: RequestIdentity = {
  subject: "oidc|reviewer-1",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["reviewer"],
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-a"],
    documentIds: ["00000000-0000-0000-0000-000000000101"],
    sourceDocumentIds: ["00000000-0000-0000-0000-000000000101"],
    sourceDocumentAccessAllowed: true,
    redistributionAllowed: true,
  },
  authMethod: "oidc",
  sessionId: "session-1",
};

test("production platform source contains no direct Snowflake persistence", async () => {
  const source = await readFile("lib/server/platform.ts", "utf8");
  assert.equal(source.includes("@/lib/server/snowflake"), false);
  assert.equal(source.includes("./snowflake"), false);
  assert.equal(source.includes("SnowflakeProductionPlatform"), false);
  assert.match(source, /PostgresProductionPlatform/);
});

test("workspace reads use the Postgres serving contract and explicit document allowlist", async () => {
  const db = new FakeDb();
  const result = await new PostgresProductionPlatform(db).listDocuments(identity);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "Q2 report.pdf");
  assert.match(db.calls[0]?.sql ?? "", /corvis_serving\.documents/);
  assert.match(db.calls[0]?.sql ?? "", /document_id::text in/);
  assert.equal(db.calls[0]?.parameters[0], identity.tenantId);
  assert.equal(db.calls[0]?.parameters[1], JSON.stringify(identity.entitlements.documentIds));
});

test("empty resource allowlists fail closed before a broad Postgres read", async () => {
  const db = new FakeDb();
  const noResources: RequestIdentity = { ...identity, entitlements: { ...identity.entitlements, fundIds: [], documentIds: [] } };
  assert.deepEqual(await new PostgresProductionPlatform(db).listDocuments(noResources), []);
  assert.deepEqual(await new PostgresProductionPlatform(db).listObservations(noResources), []);
  assert.deepEqual(await new PostgresProductionPlatform(db).listSnapshots(noResources), []);
  assert.equal(db.calls.length, 0);
});

test("review preflight is constrained by authoritative fund and document allowlists", async () => {
  const db = new FakeDb();
  const result = await new PostgresProductionPlatform(db).review(identity, {
    observationId: "00000000-0000-0000-0000-000000000201",
    decision: "approve",
    reasonCode: "verified",
    expectedVersion: 2,
  });
  assert.equal(result.accepted, true);
  assert.match(db.calls[0]?.sql ?? "", /o\.fund_id in/);
  assert.match(db.calls[0]?.sql ?? "", /r\.document_id::text in/);
  assert.match(db.calls[1]?.sql ?? "", /apply_review_decision/);
  assert.equal(db.calls.some((call) => /set\s+value_/i.test(call.sql)), false);
});

test("exports require the independent authoritative redistribution right", async () => {
  const db = new FakeDb();
  const denied: RequestIdentity = { ...identity, entitlements: { ...identity.entitlements, redistributionAllowed: false } };
  await assert.rejects(
    new PostgresProductionPlatform(db).export(denied, "csv"),
    (error: unknown) => error instanceof AuthorizationError && error.requiredPermission === "data_rights:redistribution",
  );
  assert.equal(db.calls.length, 0);
});
