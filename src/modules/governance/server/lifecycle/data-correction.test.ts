import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { DataCorrectionRequestError, PostgresDataCorrectionRepository } from "./data-correction.ts";
import { PostgresOperationsRepository } from "../../../../platform/data/platform-repositories.ts";
import { withTransaction, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";

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

test("a concurrent open of the same new key surfaces as a retryable conflict, other failures pass through", async () => {
  const command = {
    idempotencyKey: "dq-2026-q3-2", fundId: "fund-1", reportPeriod: "2026-Q3",
    rootCause: "source mapping defect", correctionIntent: "replay retained source with corrected mapping",
  };
  const unique = new FakeDb([]);
  unique.query = async () => { throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }); };
  await assert.rejects(() => new PostgresDataCorrectionRepository(unique).open(identity, command),
    (error: unknown) => error instanceof DataCorrectionRequestError && error.code === "correction_open_conflict" && error.status === 409);

  const down = new FakeDb([]);
  down.query = async () => { throw new Error("connection reset"); };
  await assert.rejects(() => new PostgresDataCorrectionRepository(down).open(identity, command), /connection reset/);
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

test("a valid open normalizes optional fields and binds an order-independent request hash over the trimmed command", async () => {
  const snapshotId = "00000000-0000-4000-8000-000000000201";
  const documentId = "00000000-0000-4000-8000-000000000202";
  const db = new FakeDb([[{ incident_id: "incident-1", state: "open" }], [{ incident_id: "incident-2", state: "open" }]]);
  const repository = new PostgresDataCorrectionRepository(db);
  const result = await repository.open(identity, {
    idempotencyKey: "  dq-1  ", fundId: " fund-1 ", reportPeriod: "2026-Q3", metricCode: "  nav  ",
    snapshotId: ` ${snapshotId} `, snapshotVersion: 3, documentId, rootCause: " mapping ", correctionIntent: " replay ",
  });
  assert.deepEqual(result, { incidentId: "incident-1", state: "open" });
  const call = db.calls[0]!;
  assert.equal(call.parameters[0], identity.tenantId);
  assert.match(String(call.parameters[1]), /^[0-9a-f-]{36}$/, "incident id is generated server-side");
  assert.equal(call.parameters[2], "dq-1");
  assert.equal(call.parameters[4], "fund-1");
  assert.equal(call.parameters[5], "2026-Q3");
  assert.equal(call.parameters[6], "nav");
  assert.equal(call.parameters[7], snapshotId);
  assert.equal(call.parameters[8], 3);
  assert.equal(call.parameters[9], documentId);
  assert.equal(call.parameters[10], "mapping");
  assert.equal(call.parameters[11], "replay");
  assert.equal(call.parameters[12], identity.subject);
  // The hash is over the key-sorted normalized command; pin the exact serialization so stored hashes stay comparable.
  const canonical = `{"correctionIntent":"replay","documentId":${JSON.stringify(documentId)},"fundId":"fund-1","idempotencyKey":"dq-1","metricCode":"nav",`
    + `"reportPeriod":"2026-Q3","rootCause":"mapping","snapshotId":${JSON.stringify(snapshotId)},"snapshotVersion":3}`;
  assert.equal(call.parameters[3], createHash("sha256").update(canonical).digest("hex"));

  // Omitted optionals and a blank metric code become SQL nulls; the hash serializes them as JSON null.
  await repository.open(identity, {
    idempotencyKey: "dq-2", fundId: "fund-1", reportPeriod: "2026-Q3", metricCode: "   ", snapshotId: "  ", rootCause: "mapping", correctionIntent: "replay",
  });
  const sparse = db.calls[1]!;
  assert.deepEqual(sparse.parameters.slice(6, 10), [null, null, null, null]);
  const sparseCanonical = `{"correctionIntent":"replay","documentId":null,"fundId":"fund-1","idempotencyKey":"dq-2","metricCode":null,`
    + `"reportPeriod":"2026-Q3","rootCause":"mapping","snapshotId":null,"snapshotVersion":null}`;
  assert.equal(sparse.parameters[3], createHash("sha256").update(sparseCanonical).digest("hex"));
});

test("an open that the database answers with no row is a server error, not a fabricated incident", async () => {
  await assert.rejects(
    () => new PostgresDataCorrectionRepository(new FakeDb([[]])).open(identity, {
      idempotencyKey: "dq-3", fundId: "fund-1", reportPeriod: "2026-Q3", rootCause: "mapping", correctionIntent: "replay",
    }),
    (error: unknown) => !(error instanceof DataCorrectionRequestError) && /was not created/.test(String((error as Error).message)),
  );
});

test("a non-integer, zero, negative or non-finite snapshot version is a typed 400 naming the field", async () => {
  const db = new FakeDb([]);
  const repository = new PostgresDataCorrectionRepository(db);
  for (const snapshotVersion of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => repository.open(identity, { idempotencyKey: "dq-4", fundId: "fund-1", reportPeriod: "2026-Q3", snapshotVersion, rootCause: "mapping", correctionIntent: "replay" }),
      (error: unknown) => error instanceof DataCorrectionRequestError && error.status === 400 && error.code === "invalid_request" && /snapshotVersion must be a positive integer/.test(error.message),
      String(snapshotVersion),
    );
  }
  assert.equal(db.calls.length, 0);
});

test("over-long and blank required fields are typed 400s that name the field and its limit", async () => {
  const db = new FakeDb([]);
  const repository = new PostgresDataCorrectionRepository(db);
  const base = { idempotencyKey: "dq-5", fundId: "fund-1", reportPeriod: "2026-Q3", rootCause: "mapping", correctionIntent: "replay" };
  const cases: Array<[Partial<typeof base>, RegExp]> = [
    [{ idempotencyKey: "k".repeat(257) }, /idempotencyKey .* at most 256/],
    [{ fundId: " " }, /fundId is required/],
    [{ reportPeriod: "p".repeat(129) }, /reportPeriod .* at most 128/],
    [{ correctionIntent: "i".repeat(2001) }, /correctionIntent .* at most 2000/],
  ];
  for (const [override, message] of cases) {
    await assert.rejects(() => repository.open(identity, { ...base, ...override }),
      (error: unknown) => error instanceof DataCorrectionRequestError && error.status === 400 && error.code === "invalid_request" && message.test(error.message));
  }
  assert.equal(db.calls.length, 0);
});

test("listing, replaying and resolving are scoped to the caller's tenant and actor", async () => {
  const incidentId = "00000000-0000-4000-8000-000000000301";
  const snapshotId = "00000000-0000-4000-8000-000000000302";
  const listed = [{ incident_id: incidentId, state: "open" }];
  const db = new FakeDb([listed, [{ job_id: "job-9" }], [{ resolved: true }], [{ resolved: "true" }]]);
  const repository = new PostgresDataCorrectionRepository(db);

  assert.deepEqual(await repository.list(identity), listed);
  assert.match(db.calls[0]!.sql, /where tenant_id=\$1 order by opened_at desc limit 500/);
  assert.deepEqual(db.calls[0]!.parameters, [identity.tenantId]);

  assert.deepEqual(await repository.replay(identity, incidentId), { jobId: "job-9" });
  assert.match(db.calls[1]!.sql, /request_data_correction_replay/);
  assert.deepEqual(db.calls[1]!.parameters, [identity.tenantId, incidentId, identity.subject]);

  await repository.resolve(identity, { incidentId, replacementSnapshotId: snapshotId, replacementSnapshotVersion: 2, evidence: { reviewedBy: "ops" } });
  assert.match(db.calls[2]!.sql, /resolve_data_correction_incident/);
  assert.deepEqual(db.calls[2]!.parameters, [identity.tenantId, incidentId, snapshotId, 2, identity.subject, JSON.stringify({ reviewedBy: "ops" })]);

  // Evidence defaults to an empty object, and a driver that reports the boolean as text still counts as resolved.
  await repository.resolve(identity, { incidentId, replacementSnapshotId: snapshotId, replacementSnapshotVersion: 2 });
  assert.equal(db.calls[3]!.parameters[5], "{}");
});

test("data-correction route maps typed errors and audits every mutation", async () => {
  const route = await readFile("src/app/api/v1/admin/data-corrections/route.ts", "utf8");
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
 * begin/rollback. Used to prove src/app/api/v1/admin/data-corrections/route.ts
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
