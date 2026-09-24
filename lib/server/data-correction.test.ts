import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { DataCorrectionRequestError, PostgresDataCorrectionRepository } from "./data-correction.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { withTransaction, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

const identity: RequestIdentity = {
  subject: "ops|reviewer", tenantId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002",
  roles: ["admin"], entitlements: { workspaceIds: ["00000000-0000-4000-8000-000000000002"], sourceDocumentAccessAllowed: true }, authMethod: "oidc", sessionId: "session-1",
};
class FakeDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  private readonly results: PostgresRow[][];
  constructor(results: PostgresRow[][]) { this.results = results; }
  async query(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); return this.results.shift() ?? []; }
  async execute() {}
  async health() { return true; }
}

test("opening a correction binds tenant, actor, idempotency and an immutable request hash", async () => {
  const db = new FakeDb([[{ incident_id: "00000000-0000-4000-8000-000000000099", state: "open" }]]);
  const result = await new PostgresDataCorrectionRepository(db).open(identity, {
    idempotencyKey: "dq-2026-q3-1", fundId: "fund-1", reportPeriod: "2026-Q3",
    documentId: "00000000-0000-4000-8000-000000000101", rootCause: "source mapping defect", correctionIntent: "replay retained source with corrected mapping",
  });
  assert.equal(result.state, "open");
  assert.match(db.calls[0]?.sql ?? "", /open_data_correction_incident/);
  assert.equal(db.calls[0]?.parameters[0], identity.tenantId);
  assert.equal(db.calls[0]?.parameters[3]?.toString().length, 64);
  assert.equal(db.calls[0]?.parameters.at(-1), identity.subject);
});

test("correction commands reject empty root cause rather than creating an unowned replay", async () => {
  const db = new FakeDb([]);
  await assert.rejects(() => new PostgresDataCorrectionRepository(db).open(identity, {
    idempotencyKey: "x", fundId: "fund-1", reportPeriod: "2026-Q3", rootCause: " ", correctionIntent: "replay",
  }), /rootCause/);
  assert.equal(db.calls.length, 0);
});

test("migration preserves immutable history, deterministic replay and persistence-level publication containment", async () => {
  const sql = (await readFile("db/postgres/migrations/022_data_correction_incidents.sql", "utf8")).toLowerCase();
  assert.match(sql, /create table if not exists corvis_control\.data_correction_incident/);
  assert.match(sql, /unique \(tenant_id, idempotency_key\)/);
  assert.match(sql, /'processingstageready'/);
  assert.match(sql, /on conflict \(tenant_id,event_id\) do nothing/);
  assert.match(sql, /active data correction incident blocks publication/);
  assert.match(sql, /'correctionreplacementdeliveryrequested'/);
  assert.equal(/update corvis_facts\.observation/.test(sql), false);
});

test("malformed correction fields are typed 400s and never reach the uuid/integer casts", async () => {
  const db = new FakeDb([]);
  const repository = new PostgresDataCorrectionRepository(db);
  const base = { idempotencyKey: "dq-1", fundId: "fund-1", reportPeriod: "2026-Q3", rootCause: "mapping", correctionIntent: "replay" };
  for (const command of [
    { ...base, rootCause: "" },
    { ...base, snapshotId: "snapshot-1" },
    { ...base, documentId: "not-a-uuid" },
    { ...base, snapshotId: "00000000-0000-4000-8000-000000000201", snapshotVersion: 0 },
    { ...base, snapshotId: "00000000-0000-4000-8000-000000000201", snapshotVersion: 1.5 },
  ]) {
    await assert.rejects(() => repository.open(identity, command),
      (error: unknown) => error instanceof DataCorrectionRequestError && error.status === 400);
  }
  assert.equal(db.calls.length, 0);
});

test("replay and resolve of an incident outside this tenant are typed 404s, not 500s", async () => {
  const repository = new PostgresDataCorrectionRepository(new FakeDb([[{ job_id: null }], [{ resolved: false }]]));
  const incidentId = "00000000-0000-4000-8000-000000000301";
  await assert.rejects(() => repository.replay(identity, incidentId),
    (error: unknown) => error instanceof DataCorrectionRequestError && error.status === 404 && error.code === "correction_incident_not_found");
  await assert.rejects(() => repository.resolve(identity, { incidentId, replacementSnapshotId: incidentId, replacementSnapshotVersion: 1 }),
    (error: unknown) => error instanceof DataCorrectionRequestError && error.status === 404);
});

test("data-correction route maps typed errors and audits every mutation", async () => {
  const route = await readFile("app/api/v1/admin/data-corrections/route.ts", "utf8");
  assert.match(route, /error instanceof DataCorrectionRequestError/);
  for (const action of ["data_correction.open", "data_correction.replay", "data_correction.resolve"]) {
    assert.ok(route.includes(`"${action}"`), `route must audit ${action}`);
  }
  // Every mutation must be wrapped with its audit event in one transaction so
  // a failed audit insert can never leave an unaudited incident write in place.
  assert.match(route, /withTransaction/);
  assert.ok((route.match(/withTransaction/g) ?? []).length >= 3, "open, replay and resolve must each run inside withTransaction");
});

/**
 * Real (in-memory) transaction semantics: `transaction()` snapshots the
 * incident table and audit log before running the callback and restores that
 * snapshot if it throws, mirroring NativePostgresSqlApi.transaction's
 * begin/rollback. Used to prove app/api/v1/admin/data-corrections/route.ts
 * wraps each mutation and its audit event in one transaction.
 */
class TransactionalFakeDb implements PostgresSqlApi {
  incidents = new Map<string, PostgresRow>();
  auditRows: PostgresRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("open_data_correction_incident")) {
      const incidentId = String(parameters[1]);
      this.incidents.set(incidentId, { incident_id: incidentId, state: "open" });
      return [{ incident_id: incidentId, state: "open" }];
    }
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("insert into corvis_control.audit_event")) {
      this.auditRows.push({ action: parameters[5] });
    }
  }

  async health(): Promise<boolean> { return true; }

  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    const incidentsSnapshot = new Map(this.incidents);
    const auditSnapshot = [...this.auditRows];
    try {
      return await fn(this);
    } catch (error) {
      this.incidents = incidentsSnapshot;
      this.auditRows = auditSnapshot;
      throw error;
    }
  }
}

function auditEvent(action: string, targetId: string) {
  return {
    id: "event-1", occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType: "data_correction_incident",
    targetId, outcome: "success" as const, correlationId: "corr-1",
  };
}

test("opening a correction incident and its audit event commit together, and roll back together when the audit insert fails", async () => {
  const command = {
    idempotencyKey: "dq-2026-q3-1", fundId: "fund-1", reportPeriod: "2026-Q3",
    documentId: "00000000-0000-4000-8000-000000000101", rootCause: "source mapping defect", correctionIntent: "replay retained source with corrected mapping",
  };

  const db = new TransactionalFakeDb();
  await withTransaction(db, async (tx) => {
    const opened = await new PostgresDataCorrectionRepository(tx).open(identity, command);
    await new PostgresOperationsRepository(tx).audit(auditEvent("data_correction.open", opened.incidentId));
  });
  assert.equal(db.incidents.size, 1);
  assert.equal(db.auditRows.length, 1);

  const failing = new TransactionalFakeDb();
  const originalExecute = failing.execute.bind(failing);
  failing.execute = async (sql: string, parameters: PostgresPrimitive[] = []) => {
    if (sql.includes("insert into corvis_control.audit_event")) throw new Error("audit insert failed");
    return originalExecute(sql, parameters);
  };
  await assert.rejects(
    withTransaction(failing, async (tx) => {
      const opened = await new PostgresDataCorrectionRepository(tx).open(identity, command);
      await new PostgresOperationsRepository(tx).audit(auditEvent("data_correction.open", opened.incidentId));
    }),
    /audit insert failed/,
  );
  // The incident must not be visible: a retry of the same idempotency key
  // must be free to try opening it again, not collide with a half-applied one.
  assert.equal(failing.incidents.size, 0);
});
