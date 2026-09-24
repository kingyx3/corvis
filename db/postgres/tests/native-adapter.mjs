import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../lib/server/postgres-native.ts';
const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CI connection required');
const db = new NativePostgresSqlApi(dsn);
try {
  assert.equal(await db.health(), true);
  const quoted = "tenant'; drop schema corvis_control cascade; --";
  assert.deepEqual(await db.query('select $1::text as value', [quoted]), [{ value: quoted }]);
  const dates = await db.query("select '2026-09-19T00:00:00Z'::timestamptz as instant");
  assert.equal(typeof dates[0].instant, 'string');
  await db.execute('begin; create table native_adapter_commit(id integer); insert into native_adapter_commit values (1); commit;');
  assert.deepEqual(await db.query('select * from native_adapter_commit'), [{ id: 1 }]);
  await assert.rejects(db.execute('begin; create table native_adapter_rollback(id integer); select 1/0; commit;'), /Postgres query failed/);
  assert.deepEqual(await db.query("select to_regclass('native_adapter_rollback') as relation"), [{ relation: null }]);
  assert.equal(await db.health(), true, 'failed transactions must not poison reused connections');
  const calls = await Promise.all(Array.from({ length: 12 }, (_, value) => db.query('select $1::int as value', [value])));
  assert.equal(calls.length, 12);

  // transaction() commits a mutation and its "audit" write together, and
  // rolls the mutation back too when the callback throws after it (standing
  // in for a failing audit insert) -- nothing from that attempt is visible.
  await db.execute('create table native_adapter_txn (id text primary key, kind text not null)');
  await db.transaction(async (tx) => {
    await tx.execute("insert into native_adapter_txn (id, kind) values ('row-1', 'mutation')");
    await tx.execute("insert into native_adapter_txn (id, kind) values ('row-1-audit', 'audit')");
  });
  assert.deepEqual(
    (await db.query('select kind from native_adapter_txn order by kind')).map((row) => row.kind),
    ['audit', 'mutation'],
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute("insert into native_adapter_txn (id, kind) values ('row-2', 'mutation')");
      throw new Error('audit insert failed');
    }),
    /audit insert failed/,
  );
  assert.deepEqual(await db.query("select id from native_adapter_txn where id='row-2'"), []);
  assert.equal(await db.health(), true, 'a rolled-back transaction must not poison reused connections');

  console.log('Native Postgres parameterization, timestamp, transaction, rollback, concurrent-query and transaction() commit/rollback checks passed');
} finally { await db.close(); }
