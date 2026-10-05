import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

const tenantId = "00000000-0000-0000-0000-000000000001";
const identity = { subject: "user-1", tenantId, workspaceId: "ws", roles: ["admin"], entitlements: { workspaceIds: ["ws"] }, authMethod: "oidc", sessionId: "s" } as unknown as RequestIdentity;
const manifest = {
  exportId: "00000000-0000-0000-0000-000000000501", tenantId, generatedAt: "2026-09-19T00:00:00.000Z",
  schemaVersion: "v1", taxonomyVersion: "v1", snapshotIds: ["00000000-0000-0000-0000-000000000601"],
  format: "csv" as const, rowCounts: { observations: 1, snapshots: 1 }, checksumSha256: "abc123",
};

/** Buffers writes made through the transaction handle and only "commits" them when the callback resolves. */
class TransactionalDb implements PostgresSqlApi {
  committed: string[] = [];
  transactions = 0;
  failOn: RegExp | undefined;
  private record(target: string[], sql: string): void {
    if (this.failOn?.test(sql)) throw new Error("simulated insert failure");
    target.push(sql);
  }
  async query(): Promise<PostgresRow[]> { return []; }
  async execute(sql: string): Promise<void> { this.record(this.committed, sql); }
  async health(): Promise<boolean> { return true; }
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const pending: string[] = [];
    const tx: PostgresSqlApi = {
      query: async () => [],
      execute: async (sql: string) => { this.record(pending, sql); },
      health: async () => true,
    };
    const result = await fn(tx);
    this.committed.push(...pending);
    return result;
  }
}

test("enqueueExport inserts the export job and its outbox event in one transaction", async () => {
  const db = new TransactionalDb();
  await new PostgresOperationsRepository(db).enqueueExport(identity, manifest);
  assert.equal(db.transactions, 1);
  assert.equal(db.committed.length, 2);
  assert.match(db.committed[0]!, /corvis_serving\.export_job/);
  assert.match(db.committed[1]!, /corvis_control\.outbox_event/);
});

test("a failed outbox insert leaves no queued export behind", async () => {
  const db = new TransactionalDb();
  db.failOn = /outbox_event/;
  await assert.rejects(new PostgresOperationsRepository(db).enqueueExport(identity, manifest), /simulated insert failure/);
  assert.deepEqual(db.committed, [], "the export_job row must roll back with the failed outbox insert");
});
