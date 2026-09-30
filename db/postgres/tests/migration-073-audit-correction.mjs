// Real-Postgres acceptance for migration 073: it appends a correcting audit row only for a paused, event-less
// webhook subscription whose pause is attributed to an actor other than migration 064 AND that migration 069
// mislabelled; it is idempotent and never touches other subscriptions. Runs the migration file itself inside one
// transaction that is always rolled back (audit_event is append-only). Run after the full migration chain:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/migration-073-audit-correction.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativePostgresSqlApi } from '../../../lib/server/postgres-native.ts';

const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const tenantId = 'c7300000-0000-4000-8000-000000000001';
const ids = { userPaused: 'c7300000-0000-4000-8000-0000000000a1', migrationPaused: 'c7300000-0000-4000-8000-0000000000a2', unlabelled: 'c7300000-0000-4000-8000-0000000000a3', active: 'c7300000-0000-4000-8000-0000000000a4' };
const ROLLBACK = Symbol('rollback');

// The migration is one begin;...commit; transaction; run its body inside the test's own transaction.
const sql = readFileSync(new URL('../migrations/073_correct_migration_069_audit_rows.sql', import.meta.url), 'utf8')
  .replace(/^(?:\s|--[^\n]*\n)*begin\s*;/i, '').replace(/commit\s*;\s*$/i, '');

const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'mig-073-ci','Migration 073 CI')`, [tenantId]);
    const subscription = (id, status, eventTypes, pausedBy) => tx.execute(
      `insert into corvis_control.webhook_subscription
         (tenant_id,webhook_id,endpoint_url,event_types,status,created_by,created_at,updated_at,paused_by,paused_at)
       values ($1,$2::uuid,'https://example.com/hook',$3::text[],$4,'ci',now(),now(),$5,case when $5::text is null then null else now() end)`,
      [tenantId, id, eventTypes, status, pausedBy]);
    await subscription(ids.userPaused, 'paused', '{}', 'alice');
    await subscription(ids.migrationPaused, 'paused', '{}', 'system:migration-064');
    await subscription(ids.unlabelled, 'paused', '{}', 'bob');
    await subscription(ids.active, 'active', '{SnapshotPublicationChanged}', null);
    // What 069 wrote: a "paused_by_migration" row for the first, second and fourth (it never looked at paused_by).
    for (const id of [ids.userPaused, ids.migrationPaused]) {
      await tx.execute(`insert into corvis_control.audit_event (tenant_id,actor_subject,action,target_type,target_id,outcome,correlation_id)
        values ($1,'system:migration-064','webhook_subscription.paused_by_migration','webhook_subscription',$2,'success','migration-069')`, [tenantId, id]);
    }

    const corrections = async () => (await tx.query(
      `select target_id, metadata->>'pausedBy' as paused_by from corvis_control.audit_event
        where tenant_id=$1 and action='webhook_subscription.paused_by_migration.corrected' order by target_id`, [tenantId]));

    await tx.execute(sql);
    assert.deepEqual((await corrections()).map((row) => [row.target_id, row.paused_by]), [[ids.userPaused, 'alice']],
      'only the user-paused subscription that 069 mislabelled is corrected');
    const original = await tx.query(`select count(*)::int as n from corvis_control.audit_event where tenant_id=$1 and action='webhook_subscription.paused_by_migration'`, [tenantId]);
    assert.equal(original[0].n, 2, 'the append-only original rows are untouched');

    await tx.execute(sql);
    assert.equal((await corrections()).length, 1, 'running the migration again corrects nothing twice');
    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('migration 073 audit correction acceptance passed');
} finally {
  await db.close?.();
}
