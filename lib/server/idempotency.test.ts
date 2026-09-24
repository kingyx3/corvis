import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { InvalidIdempotencyKeyError, MAX_IDEMPOTENCY_KEY_LENGTH, withIdempotency } from "./idempotency.ts";
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
      const [tenantId, scope, key, , status, body] = parameters;
      const rowKey = `${String(tenantId)}:${String(scope)}:${String(key)}`;
      if (this.rows.has(rowKey)) return [];
      const row: PostgresRow = { response_status: status, response_body: body };
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
