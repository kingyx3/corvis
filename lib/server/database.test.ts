import assert from "node:assert/strict";
import test from "node:test";
import {
  POSTGRES_BASELINE_CAPABILITIES,
  requireTransaction,
  withOptionalTransaction,
  type DatabaseApi,
} from "./database.ts";

function fakeDb(transactional: boolean): DatabaseApi {
  const db: DatabaseApi = {
    async query() { return []; },
    async execute() {},
    async health() { return true; },
  };
  if (transactional) {
    db.transaction = async <T>(fn: (tx: DatabaseApi) => Promise<T>) => fn(db);
  }
  return db;
}

test("PostgreSQL portability baseline declares the capabilities Corvis relies on", () => {
  assert.deepEqual(POSTGRES_BASELINE_CAPABILITIES, {
    dialect: "postgresql",
    nativeTransactions: true,
    rowLevelSecurity: true,
    advisoryLocks: true,
    extensions: true,
    logicalReplication: true,
  });
});

test("strict transactional mutations fail closed on a transport without transactions", async () => {
  await assert.rejects(
    requireTransaction(fakeDb(false), async () => "never"),
    /does not provide native transactions/,
  );
});

test("strict transactional mutations execute through the provider transaction", async () => {
  assert.equal(await requireTransaction(fakeDb(true), async () => "committed"), "committed");
});

test("optional transaction helper preserves compatibility for read-only or legacy paths", async () => {
  assert.equal(await withOptionalTransaction(fakeDb(false), async () => "ok"), "ok");
});
