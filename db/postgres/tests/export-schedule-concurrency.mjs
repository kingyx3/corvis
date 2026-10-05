// Real-Postgres concurrency acceptance for scheduled exports (F4, #260): two workers ticking at the same moment must never
// run one trigger twice. Unlike the rolled-back export-schedules.mjs this needs committed data (a row lock only means
// something across separate connections), so it uses its own tenant and removes every row it wrote at the end. Run after the
// full migration chain on a disposable database as a role that may disable triggers (the CI role is a superuser):
//   CORVIS_DATABASE_DSN=postgres://... node db/postgres/tests/export-schedule-concurrency.mjs
import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../src/platform/database/postgres-native.ts';
import { PostgresExportScheduleBackend, processDueExportSchedules } from '../../../src/modules/delivery/server/schedules/export-schedule.ts';

const dsn = process.env.CORVIS_DATABASE_DSN;
assert.ok(dsn, 'CORVIS_DATABASE_DSN is required');
console.info = () => undefined;

const tenantId = 'f4c00000-0000-4000-8000-000000000001';
const workspaceId = 'f4c00000-0000-4000-8000-000000000002';
const userId = 'f4c00000-0000-4000-8000-0000000000a1';
const snapshotId = 'f4c00000-0000-4000-8000-0000000000b1';
const SCHEDULES = 6;

const identity = {
  subject: 'concurrent-owner', tenantId, workspaceId, roles: ['analyst'], authMethod: 'oidc', sessionId: 'session-concurrent', isTenantAdmin: false,
  entitlements: { workspaceIds: [workspaceId], fundIds: ['fund-c'], documentIds: [], sourceDocumentAccessAllowed: false, redistributionAllowed: true },
};

const setup = new NativePostgresSqlApi(dsn);
const workerA = new NativePostgresSqlApi(dsn);
const workerB = new NativePostgresSqlApi(dsn);

async function cleanup() {
  await setup.transaction(async (tx) => {
    // Replica mode skips the append-only and FK triggers: this removes only this test's own tenant.
    await tx.execute(`set local session_replication_role = replica`);
    for (const table of ['corvis_control.export_schedule_run', 'corvis_control.export_schedule', 'corvis_control.outbox_event', 'corvis_serving.export_job', 'corvis_control.audit_event',
      'corvis_consolidated.fund_period_snapshot', 'corvis_control.resource_entitlement', 'corvis_control.data_rights', 'corvis_control.membership', 'corvis_control.identity_subject', 'corvis_control.workspace']) {
      await tx.execute(`delete from ${table} where tenant_id=$1`, [tenantId]);
    }
    await tx.execute(`delete from corvis_control.tenant where tenant_id=$1`, [tenantId]);
  });
}

try {
  await cleanup();
  await setup.transaction(async (tx) => {
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f4-concurrency','F4 Concurrency')`, [tenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Workspace')`, [workspaceId, tenantId]);
    await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc','concurrent-owner')`, [tenantId, userId]);
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'analyst')`, [tenantId, workspaceId, userId]);
    await tx.execute(`insert into corvis_control.resource_entitlement (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission) values ($1,$2,$3,'fund','fund-c','read')`, [tenantId, workspaceId, userId]);
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible) values ($1,'fund','fund-c',true)`, [tenantId]);
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed) values ($1,'workspace',$2,true,true)`, [tenantId, workspaceId]);
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
      values ($1,$2,'fund-c','2026-Q1',1,'published','1','1',now() - interval '3 hours')`, [tenantId, snapshotId]);
  });

  const backend = new PostgresExportScheduleBackend(() => setup);
  for (let index = 0; index < SCHEDULES; index += 1) {
    await backend.create(identity, { idempotencyKey: `c-${index}`, label: `Concurrent ${index}`, scope: { snapshotId }, format: 'csv', trigger: 'monthly' });
  }
  await setup.execute(`update corvis_control.export_schedule set next_run_at = now() - interval '1 hour' where tenant_id=$1`, [tenantId]);

  const [a, b] = await Promise.all([processDueExportSchedules(25, {}, workerA), processDueExportSchedules(25, {}, workerB)]);
  assert.equal(a.errors + b.errors, 0, 'a worker that loses the race is not an error');
  assert.equal(a.requested + b.requested, SCHEDULES, 'every trigger ran exactly once across both workers');
  assert.equal(a.failed + b.failed, 0);

  const [{ runs, distinct_runs: distinctRuns }] = await setup.query(`select count(*)::int as runs, count(distinct (schedule_id, trigger_key))::int as distinct_runs from corvis_control.export_schedule_run where tenant_id=$1`, [tenantId]);
  assert.deepEqual([runs, distinctRuns], [SCHEDULES, SCHEDULES], 'one run per schedule and trigger');
  const [{ jobs, distinct_jobs: distinctJobs }] = await setup.query(`select count(*)::int as jobs, count(distinct export_id)::int as distinct_jobs from corvis_serving.export_job where tenant_id=$1`, [tenantId]);
  assert.deepEqual([jobs, distinctJobs], [SCHEDULES, SCHEDULES], 'one governed export job per run: no duplicate export');
  const [{ events }] = await setup.query(`select count(*)::int as events from corvis_control.outbox_event where tenant_id=$1 and event_type='ExportRequested'`, [tenantId]);
  assert.equal(events, SCHEDULES);

  // Racing again after everything was handled changes nothing.
  const again = await Promise.all([processDueExportSchedules(25, {}, workerA), processDueExportSchedules(25, {}, workerB)]);
  assert.deepEqual(again.map((summary) => summary.requested + summary.failed), [0, 0]);
  console.log(`scheduled exports concurrency: two workers, ${SCHEDULES} due triggers, exactly ${SCHEDULES} runs and ${SCHEDULES} export jobs`);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await Promise.all([setup.close(), workerA.close(), workerB.close()]);
}
