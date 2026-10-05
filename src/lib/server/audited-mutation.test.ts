import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, RequestIdentity } from "../../core/enterprise.ts";
import { runAuditedMutation } from "./audited-mutation.ts";
import { withIdempotency } from "./idempotency.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

class TransactionDb implements PostgresSqlApi {
  mutated = false;
  auditRows = 0;
  idempotencyRows = 0;
  transactions = 0;
  failAudit = false;
  async query(sql?: string): Promise<PostgresRow[]> {
    if (sql?.trim().startsWith("insert into corvis_control.idempotency_key")) {
      this.idempotencyRows += 1;
      return [{ response_status: 200, response_body: "{}", request_hash: "h" }];
    }
    return [];
  }
  async execute(sql: string): Promise<void> {
    if (sql.includes("audit_event")) {
      if (this.failAudit) throw new Error("audit insert failed");
      this.auditRows += 1;
    }
  }
  async health(): Promise<boolean> { return true; }
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    const beforeMutation = this.mutated;
    const beforeAudit = this.auditRows;
    const beforeIdempotency = this.idempotencyRows;
    this.transactions += 1;
    // Like the native client, the transaction handle has no `transaction` method, so nested callers join it.
    const tx: PostgresSqlApi = {
      query: (sql) => this.query(sql),
      execute: (sql) => this.execute(sql),
      health: () => this.health(),
    };
    try { return await fn(tx); }
    catch (error) {
      this.mutated = beforeMutation;
      this.auditRows = beforeAudit;
      this.idempotencyRows = beforeIdempotency;
      throw error;
    }
  }
}

class NonTransactionalDb implements PostgresSqlApi {
  mutated = false;
  async query(): Promise<PostgresRow[]> { return []; }
  async execute(): Promise<void> { /* no-op */ }
  async health(): Promise<boolean> { return true; }
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

test("strict root transports without native transactions fail before mutation", async () => {
  const db = new NonTransactionalDb();
  await assert.rejects(runAuditedMutation({
    db,
    demoMode: false,
    strictTransactions: true,
    mutate: async () => { db.mutated = true; return { ok: true }; },
    audit: () => event,
  }), /does not provide native transactions/);
  assert.equal(db.mutated, false);
});

test("joining an existing transaction requires its caller-supplied handle", async () => {
  await assert.rejects(runAuditedMutation({
    demoMode: false,
    joinExistingTransaction: true,
    mutate: async () => ({ ok: true }),
    audit: () => event,
  }), /requires a caller-supplied database handle/);
});

// The route shape: withIdempotency owns the transaction and runAuditedMutation joins it via `db: tx`.
const idempotencyIdentity = {
  subject: "idp|admin",
  tenantId: event.tenantId,
  workspaceId: event.workspaceId,
  roles: ["admin"],
  entitlements: { workspaceIds: [event.workspaceId], sourceDocumentAccessAllowed: true },
  authMethod: "oidc",
  sessionId: "session-1",
} as RequestIdentity;

function idempotentMutation(db: TransactionDb, key: string) {
  return withIdempotency(idempotencyIdentity, "test.mutate", key, async (tx) => ({
    status: 200,
    body: await runAuditedMutation({
      db: tx,
      joinExistingTransaction: Boolean(tx),
      demoMode: false,
      mutate: async () => { db.mutated = true; return { ok: true }; },
      audit: () => event,
    }),
  }), db);
}

test("the idempotency record joins the audited mutation's transaction instead of opening a second one", async () => {
  const db = new TransactionDb();
  const outcome = await idempotentMutation(db, "key-1");
  assert.deepEqual(outcome.body, { ok: true });
  assert.equal(db.transactions, 1, "mutation, audit and idempotency record must share one transaction");
  assert.deepEqual([db.mutated, db.auditRows, db.idempotencyRows], [true, 1, 1]);
});

test("a failed audit insert leaves neither the mutation nor an idempotency record behind", async () => {
  const db = new TransactionDb();
  db.failAudit = true;
  await assert.rejects(idempotentMutation(db, "key-1"), /audit insert failed/);
  assert.deepEqual([db.mutated, db.auditRows, db.idempotencyRows], [false, 0, 0]);
});
