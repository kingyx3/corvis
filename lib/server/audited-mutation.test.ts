import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent } from "../../core/enterprise.ts";
import { runAuditedMutation } from "./audited-mutation.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

class TransactionDb implements PostgresSqlApi {
  mutated = false;
  auditRows = 0;
  failAudit = false;
  async query(): Promise<PostgresRow[]> { return []; }
  async execute(sql: string, _parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("audit_event")) {
      if (this.failAudit) throw new Error("audit insert failed");
      this.auditRows += 1;
    }
  }
  async health(): Promise<boolean> { return true; }
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    const beforeMutation = this.mutated;
    const beforeAudit = this.auditRows;
    try { return await fn(this); }
    catch (error) {
      this.mutated = beforeMutation;
      this.auditRows = beforeAudit;
      throw error;
    }
  }
}

const event: AuditEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  occurredAt: new Date().toISOString(),
  tenantId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  actorSubject: "idp|admin",
  sessionId: "session-1",
  action: "test.mutate",
  targetType: "test",
  outcome: "success",
  correlationId: "corr-1",
};

test("required audit failure rolls the business mutation back", async () => {
  const db = new TransactionDb();
  db.failAudit = true;
  await assert.rejects(runAuditedMutation({
    db,
    demoMode: false,
    mutate: async () => { db.mutated = true; return { ok: true }; },
    audit: () => event,
  }), /audit insert failed/);
  assert.equal(db.mutated, false);
  assert.equal(db.auditRows, 0);
});

test("business mutation and audit commit together on success", async () => {
  const db = new TransactionDb();
  const result = await runAuditedMutation({
    db,
    demoMode: false,
    mutate: async () => { db.mutated = true; return { ok: true }; },
    audit: () => event,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(db.mutated, true);
  assert.equal(db.auditRows, 1);
});
