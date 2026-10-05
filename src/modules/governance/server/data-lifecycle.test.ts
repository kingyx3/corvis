import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  DeletionExecutionError,
  LegalHoldError,
  evidenceHash,
  executeDeletionRequest,
  listDeletionExecutionEvidence,
  parseDeletionScope,
} from "./data-lifecycle.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";

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
    if (sql.startsWith("update corvis_control.deletion_request set\n      state='executing'")) {
      // Mirrors the compare-and-swap predicate: state and attempt count must still match what was read.
      if (this.request.state !== parameters[4] || Number(this.request.execution_attempts) !== parameters[5]) return [];
      this.request = { ...this.request, state: "executing", execution_attempts: parameters[3] };
      return [{ deletion_request_id: parameters[2] }];
    }
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

test("parseDeletionScope refuses a malformed selector instead of widening the deletion to the whole data class", () => {
  const invalidSelector = (error: unknown) => error instanceof DeletionExecutionError && error.code === "deletion_scope_invalid_selector";
  for (const key of ["documentIds", "fundIds", "subjectIds"]) {
    for (const bad of ["doc-1", 7, null, { id: "u1" }, [7], ["  "], ["doc-1", null], [""]]) {
      assert.throws(() => parseDeletionScope({ dataClasses: ["financials"], [key]: bad }), invalidSelector, `${key}=${JSON.stringify(bad)}`);
    }
  }
  // Omitted selectors stay "no restriction within the classes"; an explicit empty list is the same.
  assert.deepEqual(parseDeletionScope({ dataClasses: ["financials"] }), { dataClasses: ["financials"], documentIds: [], fundIds: [], subjectIds: [] });
  assert.deepEqual(parseDeletionScope({ dataClasses: ["financials"], fundIds: [] }).fundIds, []);
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

test("a successful adapter reply with no usable body (204, empty 200, JSON null) still completes the request", async () => {
  const replies: Array<[string, () => Response]> = [
    ["204", () => new Response(null, { status: 204 })],
    ["empty 200", () => new Response("", { status: 200 })],
    ["JSON null", () => new Response("null", { status: 200 })],
    ["non-JSON 200", () => new Response("ok", { status: 200 })],
  ];
  for (const [label, reply] of replies) {
    await withAdapter(async () => {
      const db = new FakeDb(baseRequest());
      let calls = 0;
      const result = await executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: (async () => { calls += 1; return reply(); }) as typeof fetch });
      assert.equal(calls, 1, label);
      assert.equal(result.state, "completed", label);
      assert.equal(result.evidence.adapterStatus, "completed", label);
      assert.deepEqual(db.evidenceRows.map((row) => row.outcome), ["completed"], label);
      assert.equal(db.request.state, "completed", label);
    });
  }
});

test("a bookkeeping failure after the adapter succeeded is not recorded as an adapter failure", async (t) => {
  t.mock.method(console, "error", () => undefined);
  await withAdapter(async () => {
    const db = new FakeDb(baseRequest());
    const execute = db.execute.bind(db);
    db.execute = async (sql, parameters) => {
      if (sql.includes("state='completed'")) throw new Error("connection reset while completing");
      return execute(sql, parameters);
    };
    let calls = 0;
    await assert.rejects(
      () => executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: (async () => { calls += 1; return new Response("{}", { status: 200 }); }) as typeof fetch }),
      /connection reset while completing/,
    );
    assert.equal(calls, 1);
    assert.equal(db.calls.some((call) => call.sql.includes("state='retryable'")), false, "the deleted scope must not be marked retryable");
    assert.equal(db.evidenceRows.some((row) => row.outcome === "failed"), false, "no adapter-failed evidence for a successful deletion");
    assert.equal(db.request.state, "executing", "left for lease-expiry reclaim, which re-sends the idempotent deletion");
  });
});

test("a malformed request id is rejected as not found before reaching the uuid cast", async () => {
  const db = new FakeDb(baseRequest());
  await assert.rejects(
    () => executeDeletionRequest(identity(), "not-a-uuid", { db }),
    (error: unknown) => error instanceof DeletionExecutionError && error.code === "deletion_request_not_found",
  );
  assert.equal(db.calls.length, 0);
});

test("the requester cannot approve and execute their own deletion request", async () => {
  const db = new FakeDb(baseRequest({ requested_by: "oidc|admin-1" }));
  await assert.rejects(
    () => executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => { throw new Error("must not call the adapter"); } }),
    (error: unknown) => error instanceof DeletionExecutionError && error.code === "deletion_requires_independent_approver",
  );
  assert.equal(db.request.state, "requested", "a refused self-approval must not move the request");
  assert.equal(db.evidenceRows.length, 0);
});

test("concurrent executions claim the request once and only one reaches the adapter", async () => {
  const previous = process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
  process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = "https://lifecycle.example.test";
  try {
    const db = new FakeDb(baseRequest());
    // Both callers read the request in its original executable state before either claims it.
    const original = db.query.bind(db);
    const snapshot = { ...db.request };
    db.query = async (sql: string, parameters: PostgresPrimitive[] = []) =>
      sql.startsWith("select scope, state") ? [snapshot] : original(sql, parameters);
    let adapterCalls = 0;
    const fetchImpl = (async () => { adapterCalls += 1; return new Response(JSON.stringify({ evidence: {} }), { status: 200 }); }) as typeof fetch;
    const results = await Promise.allSettled([
      executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl }),
      executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl }),
    ]);
    assert.equal(adapterCalls, 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof DeletionExecutionError && rejected.reason.code === "deletion_request_not_executable");
  } finally {
    if (previous === undefined) delete process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
    else process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = previous;
  }
});

test("the lifecycle adapter call is bounded by a timeout signal", async () => {
  const previous = process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
  process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = "https://lifecycle.example.test";
  try {
    const db = new FakeDb(baseRequest());
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(JSON.stringify({ evidence: {} }), { status: 200 });
    }) as typeof fetch;
    await executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl });
    assert.ok(signal instanceof AbortSignal, "adapter fetch must carry an abort signal");
  } finally {
    if (previous === undefined) delete process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
    else process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = previous;
  }
});

async function withAdapter<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
  process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = "https://lifecycle.example.test";
  try { return await run(); } finally {
    if (previous === undefined) delete process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT;
    else process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = previous;
  }
}

test("an executing request whose lease expired is reclaimed, keeps the ledger gap-free and reuses the stable idempotency key", async () => {
  await withAdapter(async () => {
    const db = new FakeDb(baseRequest({ state: "executing", execution_attempts: 1, lease_expired: true, requested_by: "oidc|requester" }));
    let idempotencyKey: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      idempotencyKey = (init?.headers as Record<string, string>)["idempotency-key"];
      return new Response(JSON.stringify({ evidence: { rowsDeleted: 2 } }), { status: 200 });
    }) as typeof fetch;
    const result = await executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl });
    assert.equal(result.attempt, 2);
    assert.equal(idempotencyKey, `${TENANT}:${REQUEST_ID}`);
    assert.deepEqual(db.evidenceRows.map((row) => [row.attempt, row.outcome]), [[1, "failed"], [2, "completed"]]);
    const claim = db.calls.find((call) => call.sql.includes("state='executing'") && call.sql.includes("make_interval"))!;
    assert.match(claim.sql, /\(state<>'executing' or coalesce\(execution_lease_expires_at/);
  });
});

test("an executing request with a live lease is not claimable", async () => {
  await withAdapter(async () => {
    const db = new FakeDb(baseRequest({ state: "executing", execution_attempts: 1, lease_expired: false, requested_by: "oidc|requester" }));
    await assert.rejects(
      () => executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => { throw new Error("must not call the adapter"); } }),
      (error: unknown) => error instanceof DeletionExecutionError && error.code === "deletion_request_not_executable",
    );
    assert.equal(db.evidenceRows.length, 0);
  });
});

test("reclaiming keeps four-eyes and legal-hold behaviour", async () => {
  await withAdapter(async () => {
    const own = new FakeDb(baseRequest({ state: "executing", execution_attempts: 1, lease_expired: true, requested_by: "oidc|admin-1" }));
    await assert.rejects(
      () => executeDeletionRequest(identity(), REQUEST_ID, { db: own, fetchImpl: async () => { throw new Error("no"); } }),
      (error: unknown) => error instanceof DeletionExecutionError && error.code === "deletion_requires_independent_approver",
    );
    const held = new FakeDb(baseRequest({ state: "executing", execution_attempts: 1, lease_expired: true, requested_by: "oidc|requester" }));
    held.legalHolds = [{ source: "legal_hold", data_class: "financials", reference: "matter-1" }];
    await assert.rejects(
      () => executeDeletionRequest(identity(), REQUEST_ID, { db: held, fetchImpl: async () => { throw new Error("no"); } }),
      (error: unknown) => error instanceof LegalHoldError,
    );
  });
});

test("persisted last_error is redacted and bounded", async () => {
  await withAdapter(async () => {
    const db = new FakeDb(baseRequest());
    await assert.rejects(() => executeDeletionRequest(identity(), REQUEST_ID, {
      db, fetchImpl: (async () => { throw new Error("adapter down Bearer ya29.abcdefghijklmnop https://a.example/x?sig=zzz"); }) as typeof fetch,
    }));
    const failUpdate = db.calls.find((call) => call.sql.includes("state='retryable'"))!;
    const stored = String(failUpdate.parameters[0]);
    assert.equal(/ya29|zzz/.test(stored), false);
    assert.match(stored, /^Error: adapter down/);
  });
});

test("the lifecycle adapter receives a bearer token only when one is configured", async () => {
  const previous = process.env.CORVIS_DATA_LIFECYCLE_TOKEN;
  const headersSeen: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    headersSeen.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ evidence: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    await withAdapter(async () => {
      delete process.env.CORVIS_DATA_LIFECYCLE_TOKEN;
      await executeDeletionRequest(identity(), REQUEST_ID, { db: new FakeDb(baseRequest()), fetchImpl });
      process.env.CORVIS_DATA_LIFECYCLE_TOKEN = "lifecycle-secret";
      await executeDeletionRequest(identity(), REQUEST_ID, { db: new FakeDb(baseRequest()), fetchImpl });
    });
  } finally {
    if (previous === undefined) delete process.env.CORVIS_DATA_LIFECYCLE_TOKEN;
    else process.env.CORVIS_DATA_LIFECYCLE_TOKEN = previous;
  }
  assert.equal(headersSeen.length, 2);
  assert.equal("authorization" in headersSeen[0], false);
  assert.equal(headersSeen[1].authorization, "Bearer lifecycle-secret");
  for (const headers of headersSeen) {
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["idempotency-key"], `${TENANT}:${REQUEST_ID}`);
  }
});

test("evidenceHash treats an absent evidence payload as JSON null, and binds tenant and request", () => {
  assert.equal(evidenceHash(TENANT, REQUEST_ID, 1, undefined), evidenceHash(TENANT, REQUEST_ID, 1, null));
  assert.notEqual(evidenceHash(TENANT, REQUEST_ID, 1, null), evidenceHash(TENANT, REQUEST_ID, 1, {}));
  assert.notEqual(evidenceHash(TENANT, REQUEST_ID, 1, null), evidenceHash("00000000-0000-0000-0000-0000000000a2", REQUEST_ID, 1, null));
  assert.match(evidenceHash(TENANT, REQUEST_ID, 1, null), /^[0-9a-f]{64}$/);
});

test("a blocking legal hold reports each hold's source, class and reference, normalizing driver value types", async () => {
  const db = new FakeDb(baseRequest());
  const heldAt = new Date("2026-03-01T00:00:00.000Z");
  db.legalHolds = [
    { source: "retention_policy", data_class: "financials", reference: "policy-v3" },
    { source: "legal_hold", data_class: "financials", reference: heldAt },
    { source: "anything-else", data_class: null, reference: null },
  ];
  await assert.rejects(
    () => executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => { throw new Error("must not call the adapter"); } }),
    (error: unknown) => {
      assert.ok(error instanceof LegalHoldError);
      assert.equal(error.code, "deletion_blocked_by_legal_hold");
      assert.deepEqual(error.holds, [
        { source: "retention_policy", dataClass: "financials", reference: "policy-v3" },
        { source: "legal_hold", dataClass: "financials", reference: "2026-03-01T00:00:00.000Z" },
        { source: "retention_policy", dataClass: "", reference: "" },
      ]);
      return true;
    },
  );
  const hold = db.calls.find((call) => call.sql.includes("union all"))!;
  assert.deepEqual(hold.parameters, [TENANT, JSON.stringify(["financials"])]);
  assert.equal(db.evidenceRows.at(-1)?.outcome, "blocked");
});

test("replaying a completed request with an unreadable attempt counter reports attempt 0 and recomputes the evidence hash", async () => {
  const db = new FakeDb(baseRequest({ state: "completed", execution_attempts: "not-a-number", completion_evidence: JSON.stringify({ rowsDeleted: 1 }) }));
  const result = await executeDeletionRequest(identity(), REQUEST_ID, { db, fetchImpl: async () => { throw new Error("must not re-run"); } });
  assert.equal(result.replayed, true);
  assert.equal(result.attempt, 0);
  assert.deepEqual(result.evidence, { rowsDeleted: 1 });
  assert.equal(result.evidenceHash, evidenceHash(TENANT, REQUEST_ID, 0, { rowsDeleted: 1 }));
});

test("listDeletionExecutionEvidence returns the tenant's evidence rows for one request in attempt order", async () => {
  const rows: PostgresRow[] = [
    { attempt: 1, outcome: "failed", evidence_hash: "h1", recorded_by: "oidc|admin-1" },
    { attempt: 2, outcome: "completed", evidence_hash: "h2", recorded_by: "oidc|admin-1" },
  ];
  const db = new FakeDb(baseRequest());
  db.evidenceRows = rows;
  const listed = await listDeletionExecutionEvidence(identity(), REQUEST_ID, db);
  assert.deepEqual(listed, rows);
  assert.equal(db.calls.length, 1);
  const [call] = db.calls;
  assert.deepEqual(call.parameters, [TENANT, REQUEST_ID]);
  assert.match(call.sql, /where tenant_id=\$1 and deletion_request_id=\$2::uuid/);
  assert.match(call.sql, /order by attempt\s*$/);
  assert.match(call.sql, /from corvis_control\.deletion_execution_evidence/);
});
