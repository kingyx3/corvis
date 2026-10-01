import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { IDEMPOTENCY_KEY_SWEEP_LIMIT, IdempotencyKeyReuseError, InvalidIdempotencyKeyError, MAX_IDEMPOTENCY_KEY_LENGTH, sweepExpiredIdempotencyKeys, withIdempotency } from "./idempotency.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "oidc|user-1",
    tenantId: "tenant-a",
    workspaceId: "workspace-1",
    roles: ["admin"],
    entitlements: { workspaceIds: ["workspace-1"], sourceDocumentAccessAllowed: true },
    authMethod: "oidc",
    sessionId: "session-1",
    ...overrides,
  };
}

/**
 * Mirrors the real `corvis_control.idempotency_key` primary key
 * `(tenant_id, scope, idempotency_key)`: a second INSERT for a key already
 * present returns no row (the "on conflict ... do nothing" branch), just
 * like the real unique-constraint race lib/server/idempotency.ts documents.
 */
class FakeIdempotencyDb implements PostgresSqlApi {
  readonly calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  private readonly rows = new Map<string, PostgresRow>();

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    const text = sql.trim();
    if (text.startsWith("select response_status")) {
      const [tenantId, scope, key] = parameters;
      const row = this.rows.get(`${String(tenantId)}:${String(scope)}:${String(key)}`);
      return row ? [row] : [];
    }
    if (text.startsWith("insert into corvis_control.idempotency_key")) {
      const [tenantId, scope, key, requestHash, status, body] = parameters;
      const rowKey = `${String(tenantId)}:${String(scope)}:${String(key)}`;
      if (this.rows.has(rowKey)) return [];
      const row: PostgresRow = { response_status: status, response_body: body, request_hash: requestHash };
      this.rows.set(rowKey, row);
      return [row];
    }
    throw new Error(`FakeIdempotencyDb: unexpected SQL: ${sql}`);
  }

  async execute(): Promise<void> {
    throw new Error("withIdempotency must never call execute()");
  }

  async health(): Promise<boolean> { return true; }
}

test("a first call executes fn and persists its result", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const outcome = await withIdempotency(identity(), "exports.create", "key-1", async () => {
    calls += 1;
    return { status: 202, body: { exportId: "export-1" } };
  }, db);

  assert.equal(calls, 1);
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.status, 202);
  assert.deepEqual(outcome.body, { exportId: "export-1" });
  assert.ok(db.calls.some((call) => call.sql.trim().startsWith("insert into corvis_control.idempotency_key")));
});

test("a replayed call with the same key returns the stored result without calling fn again", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { status: 202, body: { exportId: `export-${calls}` } };
  };

  const first = await withIdempotency(identity(), "exports.create", "key-1", fn, db);
  const second = await withIdempotency(identity(), "exports.create", "key-1", fn, db);

  assert.equal(calls, 1, "fn must not run a second time for a replayed key");
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.status, first.status);
  assert.deepEqual(second.body, first.body);
});

test("different client keys are independent", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => { calls += 1; return { status: 202, body: { n: calls } }; };

  const a = await withIdempotency(identity(), "exports.create", "key-a", fn, db);
  const b = await withIdempotency(identity(), "exports.create", "key-b", fn, db);

  assert.equal(calls, 2);
  assert.notDeepEqual(a.body, b.body);
});

test("different scopes are independent even when the client key is identical", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => { calls += 1; return { status: 202, body: { n: calls } }; };

  const exportsOutcome = await withIdempotency(identity(), "exports.create", "same-key", fn, db);
  const reconciliationOutcome = await withIdempotency(identity(), "reconciliation_exceptions.resolve", "same-key", fn, db);

  assert.equal(calls, 2, "a scope collision must not be treated as a replay");
  assert.equal(exportsOutcome.replayed, false);
  assert.equal(reconciliationOutcome.replayed, false);
});

test("different tenants are independent even for the same subject and client key", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => { calls += 1; return { status: 202, body: { n: calls } }; };

  await withIdempotency(identity({ tenantId: "tenant-a" }), "exports.create", "same-key", fn, db);
  await withIdempotency(identity({ tenantId: "tenant-b" }), "exports.create", "same-key", fn, db);

  assert.equal(calls, 2, "one tenant's key must never be satisfied from another tenant's record");
});

test("different subjects within the same tenant are independent even for the same client key", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => { calls += 1; return { status: 202, body: { n: calls } }; };

  await withIdempotency(identity({ subject: "oidc|user-1" }), "exports.create", "same-key", fn, db);
  await withIdempotency(identity({ subject: "oidc|user-2" }), "exports.create", "same-key", fn, db);

  assert.equal(calls, 2);
});

test("a thrown error from fn is never cached: the same key can be retried and it runs fn again", async () => {
  const db = new FakeIdempotencyDb();
  let attempt = 0;
  const fn = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("transient failure");
    return { status: 202, body: { attempt } };
  };

  await assert.rejects(
    withIdempotency(identity(), "exports.create", "retry-key", fn, db),
    /transient failure/,
  );
  assert.equal(attempt, 1);

  const outcome = await withIdempotency(identity(), "exports.create", "retry-key", fn, db);
  assert.equal(attempt, 2, "the failed first attempt must not have poisoned the key");
  assert.equal(outcome.replayed, false);
  assert.deepEqual(outcome.body, { attempt: 2 });

  // And a third, truly-repeated call now replays the successful second attempt.
  const replay = await withIdempotency(identity(), "exports.create", "retry-key", fn, db);
  assert.equal(attempt, 2);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, { attempt: 2 });
});

test("no client key skips the dedup path entirely: fn always runs and Postgres is never touched", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => { calls += 1; return { status: 202, body: { n: calls } }; };

  const first = await withIdempotency(identity(), "exports.create", undefined, fn, db);
  const second = await withIdempotency(identity(), "exports.create", undefined, fn, db);

  assert.equal(calls, 2, "a missing key must behave exactly as it did before idempotency existed");
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, false);
  assert.equal(db.calls.length, 0);
});

test("different workspaces of the same subject are independent even for the same client key", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => { calls += 1; return { status: 202, body: { exportId: `export-${calls}` } }; };

  const a = await withIdempotency(identity({ workspaceId: "workspace-1" }), "exports.create", "same-key", fn, db);
  const b = await withIdempotency(identity({ workspaceId: "workspace-2" }), "exports.create", "same-key", fn, db);
  assert.equal(calls, 2, "a workspace-1 export must never be replayed as a workspace-2 export");
  assert.equal(b.replayed, false);
  assert.notDeepEqual(a.body, b.body);
});

test("a subject containing a colon cannot collide with another subject's key namespace", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => { calls += 1; return { status: 202, body: { exportId: `export-${calls}` } }; };

  await withIdempotency(identity({ subject: "user" }), "exports.create", "a:b", fn, db);
  const other = await withIdempotency(identity({ subject: "user:a" }), "exports.create", "b", fn, db);
  assert.equal(calls, 2);
  assert.equal(other.replayed, false);
});

test("non-string and oversized client keys are rejected before reaching Postgres", async () => {
  const db = new FakeIdempotencyDb();
  const fn = async () => ({ status: 202, body: {} });
  for (const key of [42 as unknown as string, { a: 1 } as unknown as string, "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)]) {
    await assert.rejects(withIdempotency(identity(), "exports.create", key, fn, db), InvalidIdempotencyKeyError);
  }
  assert.equal(db.calls.length, 0);
  const ok = await withIdempotency(identity(), "exports.create", "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH), fn, db);
  assert.equal(ok.replayed, false);
});

test("sweepExpiredIdempotencyKeys issues one bounded, tenant-agnostic delete on expires_at", async () => {
  const calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  const rows = [{ tenant_id: "tenant-a" }, { tenant_id: "tenant-b" }];
  const db: PostgresSqlApi = {
    query: async (sql: string, parameters: PostgresPrimitive[] = []) => { calls.push({ sql, parameters }); return rows as unknown as PostgresRow[]; },
    execute: async () => { throw new Error("sweepExpiredIdempotencyKeys must delete via query(), not execute()"); },
    health: async () => true,
  };

  const count = await sweepExpiredIdempotencyKeys(db, 500);
  assert.equal(count, 2);

  const [call] = calls;
  assert.ok(call);
  assert.match(call.sql, /delete from corvis_control\.idempotency_key/);
  assert.match(call.sql, /where expires_at <= now\(\)/);
  assert.match(call.sql, /limit \$1/);
  assert.doesNotMatch(call.sql, /tenant_id\s*=/, "the sweep must be tenant-agnostic, matching the export/webhook reclaim sweeps");
  assert.deepEqual(call.parameters, [500]);
});

test("sweepExpiredIdempotencyKeys defaults to a bounded limit", async () => {
  const calls: PostgresPrimitive[][] = [];
  const db: PostgresSqlApi = {
    query: async (_sql: string, parameters: PostgresPrimitive[] = []) => { calls.push(parameters); return []; },
    execute: async () => {},
    health: async () => true,
  };
  await sweepExpiredIdempotencyKeys(db);
  assert.deepEqual(calls[0], [IDEMPOTENCY_KEY_SWEEP_LIMIT]);
});

test("reusing a key with a different request payload is refused instead of replaying the first response", async () => {
  const db = new FakeIdempotencyDb();
  let calls = 0;
  const fn = async () => ({ status: 202, body: { exportId: `export-${++calls}` } });

  const first = await withIdempotency(identity(), "exports.create", "key-1", fn, db, { format: "csv", scope: { a: 1 } });
  const replay = await withIdempotency(identity(), "exports.create", "key-1", fn, db, { scope: { a: 1 }, format: "csv" });
  assert.equal(replay.replayed, true, "key order must not change the fingerprint");
  assert.deepEqual(replay.body, first.body);

  await assert.rejects(
    withIdempotency(identity(), "exports.create", "key-1", fn, db, { format: "xlsx", scope: { a: 1 } }),
    IdempotencyKeyReuseError,
  );
  assert.equal(calls, 1, "a refused reuse must not execute the handler");
});

test("a record stored before payload binding still replays when a fingerprint is supplied", async () => {
  const db = new FakeIdempotencyDb();
  const fn = async () => ({ status: 202, body: { exportId: "export-1" } });
  await withIdempotency(identity(), "exports.create", "key-1", fn, db);
  const replay = await withIdempotency(identity(), "exports.create", "key-1", fn, db, { format: "csv" });
  assert.equal(replay.replayed, true);
});

/**
 * Models a transactional transport (the native Postgres client): writes made
 * through the handle `transaction()` passes to its callback are staged and only
 * become visible in `committed*` if the callback resolves; a throw discards
 * them, like `rollback`. The handle itself has no `transaction` method, as with
 * the real native client, so nested `withTransaction` calls join it. `log`
 * records the order of events so tests can assert what shared which transaction.
 */
class FakeTransactionalDb implements PostgresSqlApi {
  readonly log: string[] = [];
  readonly committedRecords = new Map<string, PostgresRow>();
  readonly committedMutations: string[] = [];
  failRecordInsert = false;
  /** Runs inside the next transaction right before the record insert, to model another request committing first. */
  beforeRecordInsert?: () => void;
  private transactions = 0;

  private handle(label: string, staged?: { records: Map<string, PostgresRow>; mutations: string[] }): PostgresSqlApi {
    const records = staged?.records ?? this.committedRecords;
    const mutations = staged?.mutations ?? this.committedMutations;
    return {
      query: async (sql: string, parameters: PostgresPrimitive[] = []) => {
        const text = sql.trim();
        const [tenantId, scope, key] = parameters;
        const rowKey = `${String(tenantId)}:${String(scope)}:${String(key)}`;
        if (text.startsWith("select response_status")) {
          this.log.push(`select@${label}`);
          const row = staged?.records.get(rowKey) ?? this.committedRecords.get(rowKey);
          return row ? [row] : [];
        }
        if (text.startsWith("insert into corvis_control.idempotency_key")) {
          this.log.push(`insert@${label}`);
          this.beforeRecordInsert?.();
          if (this.failRecordInsert) throw new Error("record insert failed");
          if (this.committedRecords.has(rowKey) || staged?.records.has(rowKey)) return [];
          const row: PostgresRow = { response_status: parameters[4], response_body: parameters[5], request_hash: parameters[3] };
          records.set(rowKey, row);
          return [row];
        }
        throw new Error(`FakeTransactionalDb: unexpected SQL: ${sql}`);
      },
      execute: async (sql: string) => { this.log.push(`${sql}@${label}`); mutations.push(sql); },
      health: async () => true,
    };
  }

  async query(sql: string, parameters?: PostgresPrimitive[]): Promise<PostgresRow[]> { return this.handle("db").query(sql, parameters); }
  async execute(sql: string): Promise<void> { return this.handle("db").execute(sql); }
  async health(): Promise<boolean> { return true; }

  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    const label = `tx${++this.transactions}`;
    const staged = { records: new Map<string, PostgresRow>(), mutations: [] as string[] };
    this.log.push(`begin@${label}`);
    try {
      const result = await fn(this.handle(label, staged));
      for (const [key, row] of staged.records) this.committedRecords.set(key, row);
      this.committedMutations.push(...staged.mutations);
      this.log.push(`commit@${label}`);
      return result;
    } catch (error) {
      this.log.push(`rollback@${label}`);
      throw error;
    }
  }
}

const winnerRowKey = `tenant-a:exports.create:${JSON.stringify(["oidc|user-1", "workspace-1", "key-1"])}`;

test("the record insert shares one transaction with the mutation and commits with it", async () => {
  const db = new FakeTransactionalDb();
  const outcome = await withIdempotency(identity(), "exports.create", "key-1", async (tx) => {
    await tx!.execute("mutation");
    return { status: 202, body: { exportId: "export-1" } };
  }, db);

  assert.equal(outcome.replayed, false);
  assert.deepEqual(db.log, ["select@db", "begin@tx1", "mutation@tx1", "insert@tx1", "commit@tx1"]);
  assert.deepEqual(db.committedMutations, ["mutation"]);
  assert.equal(db.committedRecords.size, 1);
});

test("a failed record insert rolls the mutation back, so a retry with the same key re-runs cleanly", async () => {
  const db = new FakeTransactionalDb();
  let runs = 0;
  const fn = async (tx?: PostgresSqlApi) => {
    runs += 1;
    await tx!.execute(`mutation-${runs}`);
    return { status: 202, body: { runs } };
  };

  db.failRecordInsert = true;
  await assert.rejects(withIdempotency(identity(), "exports.create", "key-1", fn, db), /record insert failed/);
  assert.deepEqual(db.committedMutations, [], "nothing may commit when the record could not be stored");
  assert.equal(db.committedRecords.size, 0);
  assert.equal(db.log.at(-1), "rollback@tx1");

  db.failRecordInsert = false;
  const retry = await withIdempotency(identity(), "exports.create", "key-1", fn, db);
  assert.equal(retry.replayed, false);
  assert.deepEqual(retry.body, { runs: 2 });
  assert.deepEqual(db.committedMutations, ["mutation-2"], "exactly one mutation is committed, by the retry");

  const replay = await withIdempotency(identity(), "exports.create", "key-1", fn, db);
  assert.equal(replay.replayed, true);
  assert.equal(runs, 2);
});

test("a throwing fn rolls back and records nothing", async () => {
  const db = new FakeTransactionalDb();
  await assert.rejects(withIdempotency(identity(), "exports.create", "key-1", async (tx) => {
    await tx!.execute("mutation");
    throw new Error("domain failure");
  }, db), /domain failure/);
  assert.deepEqual(db.committedMutations, []);
  assert.equal(db.committedRecords.size, 0);
  assert.ok(!db.log.some((entry) => entry.startsWith("insert")), "a failed result is never recorded");
});

test("a replay returns the stored result without opening a transaction or re-running fn", async () => {
  const db = new FakeTransactionalDb();
  let runs = 0;
  const fn = async (tx?: PostgresSqlApi) => { runs += 1; await tx!.execute("mutation"); return { status: 202, body: { runs } }; };
  const first = await withIdempotency(identity(), "exports.create", "key-1", fn, db);
  db.log.length = 0;

  const replay = await withIdempotency(identity(), "exports.create", "key-1", fn, db);
  assert.equal(runs, 1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(db.log, ["select@db"], "replay is one lookup on the plain connection");
  assert.deepEqual(db.committedMutations, ["mutation"]);
});

test("a request that loses the insert race rolls its mutation back and returns the winner's stored response", async () => {
  const db = new FakeTransactionalDb();
  // Another request with the same key commits between our lookup and our insert.
  db.beforeRecordInsert = () => {
    db.beforeRecordInsert = undefined;
    db.committedRecords.set(winnerRowKey, { response_status: 202, response_body: JSON.stringify({ exportId: "winner" }) });
    db.committedMutations.push("winner-mutation");
  };

  const loser = await withIdempotency(identity(), "exports.create", "key-1", async (tx) => {
    await tx!.execute("loser-mutation");
    return { status: 202, body: { exportId: "loser" } };
  }, db);

  assert.equal(loser.replayed, true);
  assert.deepEqual(loser.body, { exportId: "winner" });
  assert.deepEqual(db.committedMutations, ["winner-mutation"], "the loser's mutation must not commit alongside the winner's");
  assert.ok(db.log.includes("rollback@tx1"));
});

test("losing the insert race with a different payload is still refused as key reuse", async () => {
  const db = new FakeTransactionalDb();
  db.beforeRecordInsert = () => {
    db.beforeRecordInsert = undefined;
    // The winner stored a hash of a different fingerprint.
    db.committedRecords.set(winnerRowKey, { response_status: 202, response_body: "{}", request_hash: "different-hash" });
  };
  await assert.rejects(
    withIdempotency(identity(), "exports.create", "key-1", async () => ({ status: 202, body: {} }), db, { format: "csv" }),
    IdempotencyKeyReuseError,
  );
});

test("without a key fn receives no transaction handle and Postgres is never touched", async () => {
  const db = new FakeTransactionalDb();
  let received: PostgresSqlApi | undefined | "unset" = "unset";
  await withIdempotency(identity(), "exports.create", undefined, async (tx) => { received = tx; return { status: 202, body: {} }; }, db);
  assert.equal(received, undefined);
  assert.deepEqual(db.log, []);
});

test("on a transport without transactions fn still runs and the record is written on the same connection", async () => {
  const db = new FakeIdempotencyDb();
  let received: PostgresSqlApi | undefined;
  const outcome = await withIdempotency(identity(), "exports.create", "key-1", async (tx) => { received = tx; return { status: 202, body: { ok: true } }; }, db);
  assert.equal(received, db, "the HTTP fallback hands fn the plain connection, as before");
  assert.equal(outcome.replayed, false);
  assert.ok(db.calls.some((call) => call.sql.trim().startsWith("insert into corvis_control.idempotency_key")));
});
