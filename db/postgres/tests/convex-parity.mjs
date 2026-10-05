// Parity of Corvis's PostgreSQL adapter with the Convex reference semantics in tools/convex-conformance/conformance.mjs:
// one winner for a concurrent compare-and-set, no lost updates under contention, and all-or-nothing transactions
// (inserts and updates both roll back). Uses a scratch table in the connected database and drops it afterwards, so it
// needs no Corvis migrations:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/convex-parity.mjs
import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../src/platform/database/postgres-native.ts';

const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');
const CONTENDERS = 16; // keep equal to tools/convex-conformance/conformance.mjs

const db = new NativePostgresSqlApi(dsn, { max: CONTENDERS });

async function reset(key) {
  await db.transaction(async (tx) => {
    await tx.execute('delete from convex_parity_event where key=$1', [key]);
    await tx.execute('delete from convex_parity_state where key=$1', [key]);
    await tx.execute('insert into convex_parity_state (key, version, counter) values ($1, 0, 0)', [key]);
  });
}
const summary = async (key) => {
  const [state] = await db.query('select version from convex_parity_state where key=$1', [key]);
  const [{ events }] = await db.query('select count(*)::int as events from convex_parity_event where key=$1', [key]);
  return { version: state.version, events };
};

try {
  await db.execute('drop table if exists convex_parity_event; drop table if exists convex_parity_state');
  await db.execute('create table convex_parity_state (key text primary key, version integer not null, counter integer not null)');
  await db.execute('create table convex_parity_event (id serial primary key, key text not null, kind text not null)');

  // 1. Concurrent compare-and-set: exactly one winner, exactly one event.
  await reset('race');
  const outcomes = await Promise.all(Array.from({ length: CONTENDERS }, () => db.transaction(async (tx) => {
    const won = await tx.query('update convex_parity_state set version=$2 where key=$1 and version=$3 returning version', ['race', 1, 0]);
    if (won.length === 0) return false;
    await tx.execute('insert into convex_parity_event (key, kind) values ($1, $2)', ['race', 'version:1']);
    return true;
  })));
  assert.equal(outcomes.filter(Boolean).length, 1, 'exactly one compare-and-set may win');
  assert.deepEqual(await summary('race'), { version: 1, events: 1 });

  // 2. No lost updates: read-modify-write inside transaction() with a row lock still ends at N.
  await reset('counter');
  await Promise.all(Array.from({ length: CONTENDERS }, () => db.transaction(async (tx) => {
    const [{ counter }] = await tx.query('select counter from convex_parity_state where key=$1 for update', ['counter']);
    await tx.execute('update convex_parity_state set counter=$2 where key=$1', ['counter', counter + 1]);
  })));
  const [{ counter }] = await db.query('select counter from convex_parity_state where key=$1', ['counter']);
  assert.equal(counter, CONTENDERS, 'concurrent increments lost an update');

  // 3. Failed transactions are atomic: neither inserts nor updates survive a throw.
  await reset('rollback');
  for (const mutate of [
    (tx) => tx.execute('insert into convex_parity_event (key, kind) values ($1, $2)', ['rollback', 'must-roll-back']),
    async (tx) => {
      await tx.execute('update convex_parity_state set version=999 where key=$1', ['rollback']);
      await tx.execute('insert into convex_parity_event (key, kind) values ($1, $2)', ['rollback', 'must-roll-back']);
    },
  ]) {
    await assert.rejects(db.transaction(async (tx) => {
      await mutate(tx);
      throw new Error('intentional conformance rollback');
    }), /intentional conformance rollback/);
  }
  assert.deepEqual(await summary('rollback'), { version: 0, events: 0 }, 'failed transaction left partial state');
  assert.equal(await db.health(), true, 'failed transactions must not poison the pool');

  console.log(`Postgres parity passed: ${CONTENDERS} contenders, one CAS winner, no lost updates, failed transactions rolled back.`);
} finally {
  await db.execute('drop table if exists convex_parity_event; drop table if exists convex_parity_state').catch((error) => console.error('cleanup failed', error));
  await db.close();
}
