import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  DeletionExecutionError,
  LegalHoldError,
  evidenceHash,
  executeDeletionRequest,
  parseDeletionScope,
} from "./data-lifecycle.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const REQUEST_ID = "00000000-0000-0000-0000-0000000000c1";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "oidc|admin-1",
    tenantId: TENANT,
    workspaceId: "00000000-0000-0000-0000-0000000000b1",
    roles: ["admin"],
    entitlements: { workspaceIds: ["00000000-0000-0000-0000-0000000000b1"], sourceDocumentAccessAllowed: false },
    authMethod: "oidc",
    sessionId: "session-1",
    ...overrides,
  };
}

type Call = { sql: string; parameters: PostgresPrimitive[] };

class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  request: PostgresRow;
  coveredDataClasses: string[] = ["financials"];
  legalHolds: PostgresRow[] = [];
  evidenceRows: PostgresRow[] = [];

  constructor(request: PostgresRow) { this.request = request; }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    // Order matters: the legal-hold query also references retention_policy in
    // its first branch, so that more specific match must be checked first.
    if (sql.includes("union all")) return this.legalHolds;
    if (sql.includes("from corvis_control.deletion_request")) return [this.request];
    if (sql.includes("from corvis_control.retention_policy")) return this.coveredDataClasses.map((dataClass) => ({ data_class: dataClass }));
    if (sql.includes("from corvis_control.deletion_execution_evidence")) return this.evidenceRows;
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.calls.push({ sql, parameters });
    if (sql.includes("insert into corvis_control.deletion_execution_evidence")) {
      this.evidenceRows.push({
        attempt: parameters[2],
        outcome: parameters[3],
        evidence: parameters[4],
        evidence_hash: parameters[5],
        recorded_by: parameters[6],
      });
    }
    if (sql.startsWith("update corvis_control.deletion_request set\n      state='executing'")) {
      this.request = { ...this.request, state: "executing" };
    }
    if (sql.includes("state='completed'")) {
      this.request = { ...this.request, state: "completed" };
    }
  }
  async health() { return true; }
}

function baseRequest(overrides: Partial<PostgresRow> = {}): PostgresRow {
  return {
    scope: JSON.stringify({ dataClasses: ["financials"] }),
    state: "requested",
    execution_attempts: 0,
    completion_evidence: null,
    evidence_hash: null,
    ...overrides,
  };
}

test("parseDeletionScope rejects a scope with no data classes rather than treating it as delete-everything", () => {
  assert.throws(() => parseDeletionScope({}), DeletionExecutionError);
  assert.throws(() => parseDeletionScope({ dataClasses: [] }), DeletionExecutionError);
});

test("parseDeletionScope normalizes, dedupes and sorts identifier lists", () => {
  const scope = parseDeletionScope({ dataClasses: ["financials", "financials"], documentIds: ["b", "a"] });
  assert.deepEqual(scope.dataClasses, ["financials"]);
  assert.deepEqual(scope.documentIds, ["a", "b"]);
});

test("evidenceHash is deterministic for identical inputs and changes with any input", () => {
  const a = evidenceHash(TENANT, REQUEST_ID, 1, { x: 1 });
  const b = evidenceHash(TENANT, REQUEST_ID, 1, { x: 1 });
  const c = evidenceHash(TENANT, REQUEST_ID, 2, { x: 1 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("a request with no coverage in the retention policy is blocked, not executed", async () => {
  const db = new FakeDb(baseRequest());
  db.coveredDataClasses = [];
  await assert.rejects(
    () => executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => { throw new Error("must not call the adapter"); } }),
    (error: unknown) => error instanceof DeletionExecutionError && error.code === "deletion_blocked_retention_policy_missing",
  );
  assert.equal(db.evidenceRows.length, 1);
  assert.equal(db.evidenceRows[0].outcome, "blocked");
});

test("an active legal hold blocks execution and the adapter is never called", async () => {
  const db = new FakeDb(baseRequest());
  db.legalHolds = [{ source: "legal_hold", data_class: "financials", reference: "matter-1" }];
  let adapterCalled = false;
  await assert.rejects(
    () => executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => { adapterCalled = true; throw new Error("must not call the adapter"); } }),
    (error: unknown) => error instanceof LegalHoldError && error.holds.length === 1,
  );
  assert.equal(adapterCalled, false);
  assert.equal(db.evidenceRows.at(-1)?.outcome, "blocked");
});

test("a request in a non-executable state is rejected", async () => {
  const db = new FakeDb(baseRequest({ state: "completed", completion_evidence: JSON.stringify({ done: true }) }));
  const result = await executeDeletionRequest(identity(), REQUEST_ID, { db });
  assert.equal(result.replayed, true, "a completed request must replay, not throw");

  const db2 = new FakeDb(baseRequest({ state: "executing" }));
  await assert.rejects(
    () => executeDeletionRequest(identity(), REQUEST_ID, { db: db2 }),
    (error: unknown) => error instanceof DeletionExecutionError && error.code === "deletion_request_not_executable",
  );
});

test("when the adapter is not configured the request fails rather than silently completing", async () => {
  const previous = process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
  delete process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
  try {
    const db = new FakeDb(baseRequest());
    await assert.rejects(
      () => executeDeletionRequest(identity(), REQUEST_ID, { db }),
      (error: unknown) => error instanceof DeletionExecutionError && error.code === "data_lifecycle_adapter_not_configured",
    );
  } finally {
    if (previous === undefined) delete process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
    else process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = previous;
  }
});

test("a successful execution calls the adapter exactly once and records completed evidence", async () => {
  const previous = process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
  process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = "https://lifecycle.example.test";
  try {
    const db = new FakeDb(baseRequest());
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ evidence: { rowsDeleted: 4 } }), { status: 200 }); };
    const result = await executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: fetchImpl as typeof fetch });
    assert.equal(calls, 1);
    assert.equal(result.replayed, false);
    assert.equal(result.attempt, 1);
    assert.equal(db.evidenceRows.length, 1);
    assert.equal(db.evidenceRows[0].outcome, "completed");
  } finally {
    if (previous === undefined) delete process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
    else process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = previous;
  }
});

test("a completed request replays retained evidence and never calls the adapter again", async () => {
  const previous = process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
  process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = "https://lifecycle.example.test";
  try {
    const db = new FakeDb(baseRequest());
    await executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => new Response(JSON.stringify({ evidence: { rowsDeleted: 4 } }), { status: 200 }) });
    db.request = { ...db.request, state: "completed" };

    let calls = 0;
    const replay = await executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => { calls += 1; throw new Error("must not re-run"); } });
    assert.equal(calls, 0);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.evidence.rowsDeleted, 4);
  } finally {
    if (previous === undefined) delete process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
    else process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = previous;
  }
});

test("an adapter failure records failed evidence and leaves the request retryable, not completed", async () => {
  const previous = process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
  process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = "https://lifecycle.example.test";
  try {
    const db = new FakeDb(baseRequest());
    await assert.rejects(
      () => executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => new Response("nope", { status: 500 }) }),
      /Lifecycle adapter rejected deletion/,
    );
    assert.equal(db.evidenceRows.at(-1)?.outcome, "failed");
  } finally {
    if (previous === undefined) delete process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
    else process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = previous;
  }
});
