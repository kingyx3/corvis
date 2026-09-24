import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { DeletionExecutionError } from "./data-lifecycle.ts";
import {
  createDeletionRequest,
  DEAD_LETTER_BACKLOG_AGE_SECONDS_MAX,
  DEAD_LETTER_RATE_MAX,
  evaluateQueueSaturation,
  generateControlEvidence,
} from "./operations.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { withTransaction, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

const TENANT = "00000000-0000-0000-0000-0000000000c1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000c2";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "oidc|admin-1",
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    roles: ["admin"],
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true, redistributionAllowed: true, modelTrainingAllowed: true },
    authMethod: "oidc",
    sessionId: "session-1",
    ...overrides,
  };
}

// Fake db whose query() answers the single fixed counts row this test configures,
// and whose execute() just records calls. Matches this file's FakeDb convention
// (explicit field assignment, never constructor parameter-property shorthand).
class FakeDb implements PostgresSqlApi {
  countsRow: PostgresRow;
  executeCalls: { sql: string; parameters: PostgresPrimitive[] }[] = [];

  constructor(countsRow: PostgresRow) {
    this.countsRow = countsRow;
  }

  async query(): Promise<PostgresRow[]> {
    return [this.countsRow];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.executeCalls.push({ sql, parameters });
  }

  async health(): Promise<boolean> { return true; }
}

const readyReadiness = async () => ({ identity: "configured", postgres: "configured" } as const);

test("evaluateQueueSaturation reports 'none' for a healthy, job-free tenant", () => {
  const signal = evaluateQueueSaturation({ deadLetterJobs: 0, totalJobs: 0, oldestDeadLetterAgeSeconds: null });
  assert.equal(signal.severity, "none");
  assert.deepEqual(signal.reasons, []);
  assert.equal(signal.deadLetterRate, 0);
});

test("evaluateQueueSaturation breaches when the dead-letter rate exceeds ops/slos.yaml's threshold", () => {
  // 5/100 = 0.05, well over the 0.005 SLO max.
  const signal = evaluateQueueSaturation({ deadLetterJobs: 5, totalJobs: 100, oldestDeadLetterAgeSeconds: null });
  assert.equal(signal.severity, "breach");
  assert.ok(signal.reasons.some((reason) => reason.includes("dead-letter rate")));
});

test("evaluateQueueSaturation warns once the rate passes halfway to the SLO max without yet breaching it", () => {
  // Halfway threshold is DEAD_LETTER_RATE_MAX / 2 = 0.0025; pick a rate just above that
  // and comfortably below the full 0.005 max.
  const signal = evaluateQueueSaturation({ deadLetterJobs: 3, totalJobs: 1000, oldestDeadLetterAgeSeconds: null });
  assert.equal(signal.severity, "warning");
});

test("evaluateQueueSaturation fires the sustained-backlog signal on an old dead-lettered job even when the rate is low", () => {
  // Rate is 1/1000 = 0.001, comfortably under the 0.005 SLO max, but the oldest
  // dead-lettered job has been stuck for longer than the 15-minute alert window.
  const signal = evaluateQueueSaturation({
    deadLetterJobs: 1,
    totalJobs: 1000,
    oldestDeadLetterAgeSeconds: DEAD_LETTER_BACKLOG_AGE_SECONDS_MAX + 60,
  });
  assert.equal(signal.severity, "breach");
  assert.ok(signal.reasons.some((reason) => reason.includes("oldest dead-lettered job")));
});

test("evaluateQueueSaturation does not breach right at the thresholds themselves, only once they are exceeded", () => {
  // Sitting exactly on both thresholds (a rate exactly at the SLO max, and a backlog
  // age exactly at the 15-minute alert window) must not yet count as a breach: both
  // comparisons are strict, matching ops/slos.yaml's "exceeds"/">" semantics.
  const atThreshold = evaluateQueueSaturation({
    deadLetterJobs: 5,
    totalJobs: 1000,
    oldestDeadLetterAgeSeconds: DEAD_LETTER_BACKLOG_AGE_SECONDS_MAX,
  });
  assert.equal(atThreshold.deadLetterRate, DEAD_LETTER_RATE_MAX);
  assert.notEqual(atThreshold.severity, "breach");
});

test("generateControlEvidence carries a 'none' queueSaturation and stays 'pass' when readiness is configured and no jobs are dead-lettered", async () => {
  const db = new FakeDb({ audit_events: 2, dead_letter_jobs: 0, total_jobs: 0, oldest_dead_letter_age_seconds: null });
  const evidence = await generateControlEvidence(identity(), { db, readiness: readyReadiness });
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.payload.queueSaturation.severity, "none");
});

test("generateControlEvidence's result reflects a queue-saturation breach even when readiness is fully configured", async () => {
  const db = new FakeDb({ audit_events: 2, dead_letter_jobs: 50, total_jobs: 100, oldest_dead_letter_age_seconds: null });
  const evidence = await generateControlEvidence(identity(), { db, readiness: readyReadiness });
  assert.equal(evidence.payload.queueSaturation.severity, "breach");
  assert.equal(evidence.result, "attention_required");
});

test("generateControlEvidence surfaces a sustained-backlog breach from the oldest dead-lettered job's age alone", async () => {
  const db = new FakeDb({
    audit_events: 2,
    dead_letter_jobs: 1,
    total_jobs: 10000,
    oldest_dead_letter_age_seconds: DEAD_LETTER_BACKLOG_AGE_SECONDS_MAX + 300,
  });
  const evidence = await generateControlEvidence(identity(), { db, readiness: readyReadiness });
  assert.equal(evidence.payload.queueSaturation.severity, "breach");
  assert.equal(evidence.result, "attention_required");
});

test("generateControlEvidence degrades safely when the counts row omits the new saturation columns", async () => {
  const db = new FakeDb({ audit_events: 2 });
  const evidence = await generateControlEvidence(identity(), { db, readiness: readyReadiness });
  assert.equal(evidence.payload.queueSaturation.severity, "none");
  assert.equal(evidence.payload.queueSaturation.oldestDeadLetterAgeSeconds, null);
  assert.equal(evidence.result, "pass");
});

test("createDeletionRequest refuses a scope that could never execute and stores the normalized scope", async () => {
  const db = new FakeDb({});
  await assert.rejects(
    () => createDeletionRequest(identity(), { documentIds: ["doc-1"] }, "customer offboarding", db),
    (error: unknown) => error instanceof DeletionExecutionError && error.code === "deletion_scope_missing_data_classes",
  );
  await assert.rejects(() => createDeletionRequest(identity(), "everything", "customer offboarding", db), DeletionExecutionError);
  assert.equal(db.executeCalls.length, 0, "an invalid scope must never be persisted");

  await createDeletionRequest(identity(), { dataClasses: ["financials", "financials"], unexpected: "x" }, "customer offboarding", db);
  assert.equal(db.executeCalls.length, 1);
  assert.deepEqual(JSON.parse(String(db.executeCalls[0].parameters[3])), { dataClasses: ["financials"], documentIds: [], fundIds: [], subjectIds: [] });
});

/**
 * Real (in-memory) transaction semantics: `transaction()` snapshots the
 * control-evidence rows, deletion-request rows and audit log before running
 * the callback and restores that snapshot if it throws, mirroring
 * NativePostgresSqlApi.transaction's begin/rollback. Used to prove
 * app/api/v1/admin/control-evidence/route.ts and
 * app/api/v1/admin/deletion-requests/route.ts wrap their mutation and its
 * audit event in one transaction.
 */
class TransactionalFakeDb implements PostgresSqlApi {
  countsRow: PostgresRow;
  controlEvidenceRows: PostgresRow[] = [];
  deletionRequestRows: PostgresRow[] = [];
  auditRows: PostgresRow[] = [];

  constructor(countsRow: PostgresRow = {}) { this.countsRow = countsRow; }

  async query(): Promise<PostgresRow[]> { return [this.countsRow]; }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("insert into corvis_control.audit_event")) {
      this.auditRows.push({ action: parameters[5] });
      return;
    }
    if (sql.includes("insert into corvis_control.control_evidence")) {
      this.controlEvidenceRows.push({ evidence_id: parameters[1] });
      return;
    }
    if (sql.includes("insert into corvis_control.deletion_request")) {
      this.deletionRequestRows.push({ deletion_request_id: parameters[1] });
    }
  }

  async health(): Promise<boolean> { return true; }

  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    const controlEvidenceSnapshot = [...this.controlEvidenceRows];
    const deletionRequestSnapshot = [...this.deletionRequestRows];
    const auditSnapshot = [...this.auditRows];
    try {
      return await fn(this);
    } catch (error) {
      this.controlEvidenceRows = controlEvidenceSnapshot;
      this.deletionRequestRows = deletionRequestSnapshot;
      this.auditRows = auditSnapshot;
      throw error;
    }
  }
}

function auditEvent(action: string, targetType: string, targetId: string) {
  return {
    id: "event-1", occurredAt: new Date().toISOString(), tenantId: TENANT, workspaceId: WORKSPACE,
    actorSubject: "oidc|admin-1", sessionId: "session-1", action, targetType, targetId, outcome: "success" as const, correlationId: "corr-1",
  };
}

test("generateControlEvidence and its audit event commit together, and roll back together when the audit insert fails", async () => {
  const db = new TransactionalFakeDb({ audit_events: 2, dead_letter_jobs: 0, total_jobs: 0, oldest_dead_letter_age_seconds: null });
  await withTransaction(db, async (tx) => {
    const evidence = await generateControlEvidence(identity(), { db: tx, readiness: readyReadiness });
    await new PostgresOperationsRepository(tx).audit(auditEvent("control_evidence.generate", "control_evidence", evidence.evidenceId));
  });
  assert.equal(db.controlEvidenceRows.length, 1);
  assert.equal(db.auditRows.length, 1);

  const failing = new TransactionalFakeDb({ audit_events: 2, dead_letter_jobs: 0, total_jobs: 0, oldest_dead_letter_age_seconds: null });
  const originalExecute = failing.execute.bind(failing);
  failing.execute = async (sql: string, parameters: PostgresPrimitive[] = []) => {
    if (sql.includes("insert into corvis_control.audit_event")) throw new Error("audit insert failed");
    return originalExecute(sql, parameters);
  };
  await assert.rejects(
    withTransaction(failing, async (tx) => {
      const evidence = await generateControlEvidence(identity(), { db: tx, readiness: readyReadiness });
      await new PostgresOperationsRepository(tx).audit(auditEvent("control_evidence.generate", "control_evidence", evidence.evidenceId));
    }),
    /audit insert failed/,
  );
  // The generated evidence row must not be visible: a client that got a 500
  // must not see an evidence record with no audit trail for it.
  assert.equal(failing.controlEvidenceRows.length, 0);
});

test("createDeletionRequest and its audit event commit together, and roll back together when the audit insert fails", async () => {
  const db = new TransactionalFakeDb();
  await withTransaction(db, async (tx) => {
    const requestId = await createDeletionRequest(identity(), { dataClasses: ["financials"] }, "customer offboarding", tx);
    await new PostgresOperationsRepository(tx).audit(auditEvent("deletion_request.create", "deletion_request", requestId));
  });
  assert.equal(db.deletionRequestRows.length, 1);
  assert.equal(db.auditRows.length, 1);

  const failing = new TransactionalFakeDb();
  const originalExecute = failing.execute.bind(failing);
  failing.execute = async (sql: string, parameters: PostgresPrimitive[] = []) => {
    if (sql.includes("insert into corvis_control.audit_event")) throw new Error("audit insert failed");
    return originalExecute(sql, parameters);
  };
  await assert.rejects(
    withTransaction(failing, async (tx) => {
      const requestId = await createDeletionRequest(identity(), { dataClasses: ["financials"] }, "customer offboarding", tx);
      await new PostgresOperationsRepository(tx).audit(auditEvent("deletion_request.create", "deletion_request", requestId));
    }),
    /audit insert failed/,
  );
  // The deletion request must not be visible: a retry of the same request
  // must be free to create it again, not collide with a half-applied one.
  assert.equal(failing.deletionRequestRows.length, 0);
});
