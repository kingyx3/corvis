import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { listAuditRecords } from "./audit-query.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

class FakeDb implements PostgresSqlApi {
  sql = "";
  parameters: PostgresPrimitive[] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.sql = sql;
    this.parameters = parameters;
    return [{
      audit_event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      occurred_at: "2026-09-22T00:00:00.000Z",
      workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actor_subject: "user-1",
      action: "feature_flag.update",
      target_type: "feature_flag",
      target_id: "exports.parquet_delivery",
      outcome: "success",
      correlation_id: "corr-1",
      metadata: { should: "not leak" },
    }];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

function identity(): RequestIdentity {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    subject: "admin-1",
    sessionId: "session-1",
    roles: ["tenant_admin"],
    entitlements: {
      fundIds: [],
      documentIds: [],
      sourceDocumentAccessAllowed: false,
      internalAnalyticsAllowed: false,
      modelTrainingAllowed: false,
      redistributionAllowed: false,
    },
  };
}

test("audit query is tenant-scoped, bounded and omits raw metadata", async () => {
  const db = new FakeDb();
  const rows = await listAuditRecords(identity(), {
    limit: 999,
    action: "feature_flag.update",
    actor: "user-1",
    targetType: "feature_flag",
    outcome: "success",
  }, db);

  assert.match(db.sql, /where tenant_id=\$1/);
  assert.equal(db.parameters[0], identity().tenantId);
  assert.equal(db.parameters[7], 200);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]!).sort(), [
    "action", "actorSubject", "correlationId", "id", "occurredAt", "outcome",
    "targetId", "targetType", "workspaceId",
  ].sort());
  assert.equal("metadata" in rows[0]!, false);
});

test("audit query rejects invalid time filters", async () => {
  await assert.rejects(() => listAuditRecords(identity(), { after: "not-a-date" }, new FakeDb()), /invalid_after/);
});
