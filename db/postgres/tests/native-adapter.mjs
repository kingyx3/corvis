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
  console.log('Native Postgres parameterization, timestamp, transaction, rollback and concurrent-query checks passed');
} finally { await db.close(); }
