// Real-Postgres acceptance for scheduled exports (F4, #260), through the application code: the backend and the worker in
// lib/server/export-schedule.ts drive the SQL functions of migration 085 and the *real* governed export request
// (createPhysicalExport) inside one transaction that is always rolled back. Covers what the pure-SQL test
// (export-schedules.sql) cannot: the owner's real re-authorization (membership, entitlements, contractual data rights),
// the export job a run hands to the existing export worker, idempotency across ticks, fail-closed refusals recorded as
// stable failed runs, the audit trail, the owner-only / Organization Admin views and the schedule label on delivery
// history. Run after the full migration chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/export-schedules.mjs
import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../lib/server/postgres-native.ts';
import { PostgresExportScheduleBackend, processDueExportSchedules, scheduleSessionId } from '../../../lib/server/export-schedule.ts';
import { listPhysicalExportStatuses } from '../../../lib/server/export-history.ts';

console.info = () => undefined;
const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const tenantId = 'f4000000-0000-4000-8000-000000000001';
const otherTenantId = 'f4000000-0000-4000-8000-000000000009';
const workspaceId = 'f4000000-0000-4000-8000-000000000002';
const owner = { userId: 'f4000000-0000-4000-8000-0000000000a1', subject: 'owner-subject' };
const colleague = { userId: 'f4000000-0000-4000-8000-0000000000a2', subject: 'colleague-subject' };
const boss = { userId: 'f4000000-0000-4000-8000-0000000000a3', subject: 'boss-subject' };
const leaver = { userId: 'f4000000-0000-4000-8000-0000000000a4', subject: 'leaver-subject' };
const snapshotA = 'f4000000-0000-4000-8000-0000000000b1';
const snapshotB = 'f4000000-0000-4000-8000-0000000000b2';
const snapshotC = 'f4000000-0000-4000-8000-0000000000b3';
const ROLLBACK = Symbol('rollback');

function identity(person, overrides = {}) {
  return {
    subject: person.subject, tenantId, workspaceId, roles: ['analyst'], authMethod: 'oidc', sessionId: `session-${person.subject}`, isTenantAdmin: false,
    entitlements: { workspaceIds: [workspaceId], fundIds: ['fund-x'], documentIds: [], sourceDocumentAccessAllowed: false, redistributionAllowed: true },
    ...overrides,
  };
}
const asBoss = identity(boss, { roles: ['admin'], isTenantAdmin: true });
const position = { positionFinancials: { fundId: 'fund-x', holdingId: 'holding-1', companyId: 'company-1', periodicity: 'quarterly' } };
const command = (key, overrides = {}) => ({ idempotencyKey: key, label: `Schedule ${key}`, scope: { snapshotId: snapshotA }, format: 'csv', trigger: 'monthly', ...overrides });
// A statement that raises aborts a Postgres transaction, so every expected refusal runs under its own savepoint.
async function refused(tx, run) {
  await tx.execute('savepoint probe');
  try {
    await run();
  } catch (error) {
    await tx.execute('rollback to savepoint probe');
    return error;
  }
  await tx.execute('release savepoint probe');
  assert.fail('expected the command to be refused');
}

const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    const backend = new PostgresExportScheduleBackend(() => tx);
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f4-ci','F4 CI'),($2,'f4-ci-other','F4 CI Other')`, [tenantId, otherTenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Growth Fund Workspace')`, [workspaceId, tenantId]);
    for (const person of [owner, colleague, boss, leaver]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenantId, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'analyst'),($1,$2,$4,'analyst'),($1,$2,$5,'tenant_admin'),($1,$2,$6,'analyst')`,
      [tenantId, workspaceId, owner.userId, colleague.userId, boss.userId, leaver.userId]);
    for (const person of [owner, colleague, leaver]) {
      await tx.execute(`insert into corvis_control.resource_entitlement (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission) values ($1,$2,$3,'fund','fund-x','read')`, [tenantId, workspaceId, person.userId]);
    }
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible) values ($1,'fund','fund-x',true)`, [tenantId]);
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed) values ($1,'workspace',$2,true,true)`, [tenantId, workspaceId]);
    // Snapshots published long enough ago to have settled; A and B are fund-x, C is another fund.
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
      values ($1,$2,'fund-x','2026-Q1',1,'published','1','1',now() - interval '3 hours'),($1,$3,'fund-x','2026-Q2',1,'published','1','1',now() - interval '2 hours'),
             ($1,$4,'fund-y','2026-Q2',1,'published','1','1',now() - interval '2 hours')`, [tenantId, snapshotA, snapshotB, snapshotC]);

    const count = async (sql, parameters = [tenantId]) => Number((await tx.query(sql, parameters))[0].n);
    const exportJobs = () => count(`select count(*)::int as n from corvis_serving.export_job where tenant_id=$1`);
    const runsOf = async (scheduleId) => (await tx.query(`select trigger_key,outcome,export_id,failure_reason from corvis_control.export_schedule_run where tenant_id=$1 and schedule_id=$2 order by created_at,trigger_key`, [tenantId, scheduleId])).map((row) => ({ ...row }));
    const audits = async (scheduleId) => (await tx.query(`select action,outcome,actor_subject from corvis_control.audit_event where tenant_id=$1 and target_id=$2 order by occurred_at,action`, [tenantId, scheduleId])).map((row) => [row.action, row.outcome, row.actor_subject]);
    const forceDue = (scheduleId) => tx.execute(`update corvis_control.export_schedule set next_run_at = now() - interval '1 hour' where tenant_id=$1 and schedule_id=$2`, [tenantId, scheduleId]);
    const tick = () => processDueExportSchedules(25, {}, tx);

    // ------------------------------------------------------------ saving a schedule
    const baseline = await exportJobs();
    const monthly = await backend.create(identity(owner), command('m-1'), tx);
    assert.equal(monthly.created, true);
    assert.deepEqual([monthly.item.status, monthly.item.trigger, monthly.item.ownedByMe, monthly.item.lastRun], ['active', 'monthly', true, null]);
    assert.ok(Date.parse(monthly.item.nextRunAt) > Date.now(), 'the first run is the next month start, not now');
    assert.equal((await backend.create(identity(owner), command('m-1'), tx)).created, false, 'a retry returns the original schedule');
    const reused = await refused(tx, () => backend.create(identity(owner), command('m-1', { label: 'Different' }), tx));
    assert.equal(reused.applicationError, 'idempotency key reused with different export schedule');
    assert.equal(await exportJobs(), baseline, 'saving a schedule exports nothing');
    assert.equal((await refused(tx, () => backend.create(identity(owner), command('m-x', { scope: { positionFinancials: { ...position.positionFinancials, fundId: 'fund-y' } } }), tx))).code, 'export_scope_not_entitled', 'a fund the owner is not entitled to cannot be scheduled');
    assert.equal((await refused(tx, () => backend.create(identity(owner), command('m-y', { scope: { snapshotId: snapshotC } }), tx))).code, 'export_scope_not_entitled', 'nor a snapshot of one');
    assert.equal((await refused(tx, () => backend.create(identity(owner, { entitlements: { workspaceIds: [workspaceId], fundIds: ['fund-x'], sourceDocumentAccessAllowed: false } }), command('m-z'), tx))).name, 'AuthorizationError', 'no redistribution rights, no schedule');

    // ------------------------------------------------------------ visibility
    assert.deepEqual((await backend.list(identity(owner), { scope: 'mine', limit: 10 }, tx)).items.map((item) => item.scheduleId), [monthly.item.scheduleId]);
    assert.equal((await backend.list(identity(colleague), { scope: 'mine', limit: 10 }, tx)).items.length, 0, 'a colleague sees nothing of it');
    const seenByBoss = (await backend.list(asBoss, { scope: 'all', limit: 10 }, tx)).items;
    assert.deepEqual(seenByBoss.map((item) => [item.scheduleId, item.ownedByMe, item.owner]), [[monthly.item.scheduleId, false, owner.subject]], 'an Organization Admin sees every schedule in the tenant');
    assert.equal((await backend.get(asBoss, monthly.item.scheduleId, tx)).owner, owner.subject);
    assert.equal((await refused(tx, () => backend.get(identity(colleague), monthly.item.scheduleId, tx))).code, 'export_schedule_not_found');
    assert.equal((await refused(tx, () => backend.get({ ...asBoss, tenantId: otherTenantId }, monthly.item.scheduleId, tx))).code, 'export_schedule_not_found', 'another tenant cannot read it');
    assert.equal((await refused(tx, () => backend.setStatus(asBoss, monthly.item.scheduleId, 'pause', tx))).code, 'export_schedule_not_found', 'only the owner changes a schedule, an Organization Admin included');
    assert.equal((await refused(tx, () => backend.remove(identity(colleague), monthly.item.scheduleId, tx))).code, 'export_schedule_not_found');

    // ------------------------------------------------------------ a calendar run: re-authorized, governed, idempotent
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'nothing is due before the period starts');
    await forceDue(monthly.item.scheduleId);
    assert.deepEqual(await tick(), { stopped: 0, requested: 1, failed: 0, errors: 0 }, JSON.stringify(await runsOf(monthly.item.scheduleId)));
    const [run] = await runsOf(monthly.item.scheduleId);
    assert.equal(run.outcome, 'requested');
    assert.match(run.trigger_key, /^monthly:\d{4}-\d{2}$/);
    const job = (await tx.query(`select requested_by,auth_method,session_id,workspace_id,format,state,manifest,snapshot_ids from corvis_serving.export_job where export_id=$1`, [run.export_id]))[0];
    assert.deepEqual([job.requested_by, job.auth_method, job.session_id, job.workspace_id, job.format, job.state], [owner.subject, 'oidc', scheduleSessionId(monthly.item.scheduleId), workspaceId, 'csv', 'queued'],
      'the export is requested as the owner and handed to the existing export worker as a queued job');
    assert.deepEqual([job.manifest.scope, job.snapshot_ids], [{ snapshotId: snapshotA }, [snapshotA]], 'the manifest carries the saved scope');
    assert.equal(await exportJobs(), baseline + 1);
    assert.equal(await count(`select count(*)::int as n from corvis_control.outbox_event where tenant_id=$1 and event_type='ExportRequested' and aggregate_id=$2`, [tenantId, run.export_id]), 1, 'the same ExportRequested event an interactive request emits');
    assert.deepEqual(await audits(monthly.item.scheduleId), [['export_schedule.run', 'success', owner.subject]]);

    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'a second tick finds the trigger already handled');
    await forceDue(monthly.item.scheduleId);
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'even a schedule forced due again yields no second run for the same period');
    assert.equal((await runsOf(monthly.item.scheduleId)).length, 1);
    assert.equal(await exportJobs(), baseline + 1, 'no duplicate export');
    const advanced = await backend.get(identity(owner), monthly.item.scheduleId, tx);
    assert.ok(Date.parse(advanced.nextRunAt) > Date.now(), 'the schedule moved to the next period');
    assert.deepEqual([advanced.lastRun.exportId, advanced.lastRun.exportState, advanced.lastRun.outcome], [run.export_id, 'queued', 'requested']);

    // The run appears in delivery history with its schedule label, and in the run history with its scope.
    const history = await listPhysicalExportStatuses(identity(owner), 20, tx);
    assert.deepEqual(history.map((entry) => [entry.exportId, entry.schedule?.label, entry.schedule?.triggerKey]), [[run.export_id, 'Schedule m-1', run.trigger_key]]);
    const runHistory = await backend.listRuns(identity(owner), { scope: 'mine', limit: 10 }, tx);
    assert.deepEqual(runHistory.items.map((item) => [item.scheduleLabel, item.scopeLabel, item.exportState]), [['Schedule m-1', `Snapshot ${snapshotA}`, 'queued']]);
    assert.equal((await backend.listRuns(identity(colleague), { scope: 'mine', limit: 10 }, tx)).items.length, 0);
    assert.equal((await backend.listRuns(asBoss, { scope: 'all', limit: 10 }, tx)).items.length, 1);

    // ------------------------------------------------------------ publication triggers: coalesced, scoped, refused when rights are gone
    // (The fund-level schedule has a Position Financials scope. This fixture has no position statements, so its runs are refused as
    // "scope no longer resolves": that is the fail-closed path, and exactly what should happen when the data is not there.)
    const byFund = await backend.create(identity(owner), command('p-1', { scope: position, trigger: 'on_publish', label: 'Fund X on publish' }), tx);
    const forSnapshot = await backend.create(identity(owner), command('p-2', { scope: { snapshotId: snapshotB }, trigger: 'on_publish', format: 'xlsx' }), tx);
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'what was published before the schedule existed is never exported');
    await tx.execute(`update corvis_control.export_schedule set publish_watermark = now() - interval '4 hours' where tenant_id=$1 and trigger_kind='on_publish'`, [tenantId]);
    const jobsBeforePublish = await exportJobs();
    assert.deepEqual(await tick(), { stopped: 0, requested: 1, failed: 1, errors: 0 }, 'the snapshot schedule exports its own snapshot; the fund schedule is refused because its position scope resolves to nothing');
    assert.equal(await exportJobs(), jobsBeforePublish + 1);
    assert.deepEqual((await runsOf(byFund.item.scheduleId)).map((entry) => [entry.trigger_key, entry.outcome, entry.failure_reason]), [[`publish:${snapshotB}:v1`, 'failed', 'scope_unavailable']],
      'the two publications of fund-x are one trigger, for the newest');
    assert.deepEqual((await runsOf(forSnapshot.item.scheduleId)).map((entry) => [entry.trigger_key, entry.outcome]), [[`publish:${snapshotB}:v1`, 'requested']]);
    const xlsx = (await tx.query(`select format,snapshot_ids from corvis_serving.export_job where export_id=$1`, [(await runsOf(forSnapshot.item.scheduleId))[0].export_id]))[0];
    assert.deepEqual([xlsx.format, xlsx.snapshot_ids], ['xlsx', [snapshotB]]);
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'a publication triggers once');

    // Contractual redistribution rights are withdrawn: the next version of the snapshot is refused, nothing is exported, the reason is stable.
    await tx.execute(`update corvis_control.data_rights set redistribution_allowed=false where tenant_id=$1 and resource_type='workspace'`, [tenantId]);
    await tx.execute(`update corvis_consolidated.fund_period_snapshot set status='superseded' where tenant_id=$1 and snapshot_id=$2 and version=1`, [tenantId, snapshotB]);
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
      values ($1,$2,'fund-x','2026-Q2',2,'published','1','1',now() - interval '5 minutes')`, [tenantId, snapshotB]);
    const jobsBefore = await exportJobs();
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 2, errors: 0 });
    assert.equal(await exportJobs(), jobsBefore, 'a refused run exports nothing');
    const refusedRun = (await runsOf(forSnapshot.item.scheduleId))[1];
    assert.deepEqual([refusedRun.trigger_key, refusedRun.outcome, refusedRun.export_id, refusedRun.failure_reason], [`publish:${snapshotB}:v2`, 'failed', null, 'redistribution_not_permitted']);
    assert.deepEqual((await audits(forSnapshot.item.scheduleId)).map(([action, outcome]) => `${action}:${outcome}`).sort(), ['export_schedule.run:failure', 'export_schedule.run:success']);
    const stillActive = await backend.get(identity(owner), forSnapshot.item.scheduleId, tx);
    assert.equal(stillActive.status, 'active', 'a rights problem does not stop the schedule: the rights may come back');
    assert.equal(stillActive.lastRun !== null, true, 'the schedule reports its latest run');
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'the refused trigger is not retried either');
    await tx.execute(`update corvis_control.data_rights set redistribution_allowed=true where tenant_id=$1 and resource_type='workspace'`, [tenantId]);

    // The owner loses the fund entitlement: refused as not entitled, still nothing exported.
    await tx.execute(`delete from corvis_control.resource_entitlement where tenant_id=$1 and subject_user_id=$2`, [tenantId, owner.userId]);
    await tx.execute(`update corvis_consolidated.fund_period_snapshot set status='superseded' where tenant_id=$1 and snapshot_id=$2 and version=2`, [tenantId, snapshotB]);
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
      values ($1,$2,'fund-x','2026-Q2',3,'published','1','1',now() - interval '4 minutes')`, [tenantId, snapshotB]);
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 2, errors: 0 });
    assert.deepEqual((await runsOf(forSnapshot.item.scheduleId)).map((entry) => entry.failure_reason).slice(1), ['redistribution_not_permitted', 'scope_not_entitled']);
    assert.equal(await exportJobs(), jobsBefore);

    // ------------------------------------------------------------ pause, resume, delete
    const paused = await backend.setStatus(identity(owner), byFund.item.scheduleId, 'pause', tx);
    assert.deepEqual([paused.status, paused.nextRunAt], ['paused', null]);
    const deleted = await backend.remove(identity(owner), forSnapshot.item.scheduleId, tx);
    assert.equal(deleted.scheduleId, forSnapshot.item.scheduleId);
    assert.equal((await refused(tx, () => backend.get(identity(owner), forSnapshot.item.scheduleId, tx))).code, 'export_schedule_not_found');
    assert.ok(!(await backend.list(identity(owner), { scope: 'mine', limit: 10 }, tx)).items.some((item) => item.scheduleId === forSnapshot.item.scheduleId));
    assert.equal((await backend.listRuns(identity(owner), { scope: 'mine', limit: 50, scheduleId: forSnapshot.item.scheduleId }, tx)).items.length, 3, 'a deleted schedule keeps its run history');
    await tx.execute(`update corvis_consolidated.fund_period_snapshot set status='superseded' where tenant_id=$1 and snapshot_id=$2 and version=3`, [tenantId, snapshotB]);
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
      values ($1,$2,'fund-x','2026-Q2',4,'published','1','1',now() - interval '3 minutes')`, [tenantId, snapshotB]);
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'a paused schedule and a deleted one do not run');
    assert.equal((await refused(tx, () => backend.setStatus(identity(owner), byFund.item.scheduleId, 'pause', tx))).applicationError, 'export schedule transition not allowed');
    assert.equal((await backend.setStatus(identity(owner), byFund.item.scheduleId, 'resume', tx)).status, 'active');
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'publications while paused are not caught up on resume');

    // ------------------------------------------------------------ deactivated owners stop their schedules automatically
    const leavers = [
      await backend.create(identity(leaver), command('l-1', { scope: position }), tx),
      await backend.create(identity(leaver), command('l-2', { scope: position, trigger: 'on_publish' }), tx),
    ];
    await tx.execute(`update corvis_control.identity_subject set status='disabled',disabled_at=now() where tenant_id=$1 and user_id=$2`, [tenantId, leaver.userId]);
    const swept = await tick();
    assert.equal(swept.stopped, 2, 'both of the leaver\'s schedules stop on the next tick');
    for (const item of leavers) {
      const stopped = (await tx.query(`select status,stop_reason,next_run_at,publish_watermark from corvis_control.export_schedule where schedule_id=$1`, [item.item.scheduleId]))[0];
      assert.deepEqual([stopped.status, stopped.stop_reason, stopped.next_run_at, stopped.publish_watermark], ['stopped', 'owner_inactive', null, null]);
      assert.deepEqual((await audits(item.item.scheduleId)).map(([action, outcome, actor]) => `${action}:${outcome}:${actor}`), ['export_schedule.stop:success:system:export-scheduler']);
    }
    assert.equal((await backend.get(identity(owner, { subject: leaver.subject }), leavers[0].item.scheduleId, tx)).status, 'stopped');
    assert.equal((await refused(tx, () => backend.setStatus(identity(owner, { subject: leaver.subject }), leavers[0].item.scheduleId, 'resume', tx))).applicationError, 'export schedule transition not allowed');
    assert.deepEqual(await tick(), { stopped: 0, requested: 0, failed: 0, errors: 0 }, 'stopping is idempotent');

    // An owner whose membership resolution fails at run time (here: the workspace was suspended, which the sweep does not look at)
    // is failed closed and the schedule stopped by the run itself.
    const moved = await backend.create(identity(colleague), command('c-1', { scope: position }), tx);
    await forceDue(moved.item.scheduleId);
    await tx.execute(`update corvis_control.workspace set status='suspended' where workspace_id=$1`, [workspaceId]);
    const exportsBefore = await exportJobs();
    const summary = await tick();
    assert.deepEqual([summary.requested, summary.failed, summary.errors], [0, 1, 0]);
    assert.equal(await exportJobs(), exportsBefore, 'an owner who cannot be authorized exports nothing');
    assert.deepEqual((await runsOf(moved.item.scheduleId)).map((entry) => [entry.outcome, entry.failure_reason]), [['failed', 'owner_inactive']]);
    assert.equal((await tx.query(`select status from corvis_control.export_schedule where schedule_id=$1`, [moved.item.scheduleId]))[0].status, 'stopped');
    assert.deepEqual((await audits(moved.item.scheduleId)).map(([action, outcome]) => `${action}:${outcome}`).sort(), ['export_schedule.run:failure', 'export_schedule.stop:success']);

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('scheduled exports: re-authorized governed runs, idempotent triggers, fail-closed refusals, owner-only changes, Organization Admin visibility, automatic stop and audit verified against real Postgres');
} finally {
  await db.close?.();
}
