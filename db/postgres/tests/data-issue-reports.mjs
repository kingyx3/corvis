// Real-Postgres acceptance for data-issue reports (F5, #261), through the application code: the repository in
// src/modules/governance/server/data-issue.ts drives the SQL functions of migration 083 inside one transaction that is always rolled back.
// Covers what the pure-SQL test (data-issue-reports.sql) cannot: visibility predicates as the repository builds them,
// keyset paging, the reporter's unseen indicator, the in-app/email notice by status, send-time eligibility and
// preferences from the F2 outbox, and the link from the governed correction flow. Run after the full migration chain on a
// disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/data-issue-reports.mjs
import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../src/platform/database/postgres-native.ts';
import { RecordingEmailSender } from '../../../src/modules/notifications/adapters/recording-email-sender.ts';
import { PostgresDataIssueBackend, closeDataIssuesForCorrection } from '../../../src/modules/governance/server/data-issue.ts';
import { captureVerifiedRecipient, processEmailOutbox, updateNotificationPreferences } from '../../../src/modules/notifications/server/notifications.ts';

const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const tenantId = 'f5000000-0000-4000-8000-000000000001';
const otherTenantId = 'f5000000-0000-4000-8000-000000000009';
const workspaceId = 'f5000000-0000-4000-8000-000000000002';
const otherWorkspaceId = 'f5000000-0000-4000-8000-00000000000a';
const reporter = { userId: 'f5000000-0000-4000-8000-0000000000a1', subject: 'reporter-subject', email: 'reporter@example.com' };
const colleague = { userId: 'f5000000-0000-4000-8000-0000000000a2', subject: 'colleague-subject', email: 'colleague@example.com' };
const admin = { userId: 'f5000000-0000-4000-8000-0000000000a3', subject: 'admin-subject', email: 'admin@example.com' };
const snapshotId = 'f5000000-0000-4000-8000-0000000000b1';
const replacementId = 'f5000000-0000-4000-8000-0000000000b2';
const incidentId = 'f5000000-0000-4000-8000-0000000000c1';
const appUrl = 'https://app.corvis.test';
const ROLLBACK = Symbol('rollback');

function identity(person, overrides = {}) {
  return {
    subject: person.subject, tenantId, workspaceId, roles: ['analyst'], authMethod: 'oidc', sessionId: `session-${person.subject}`,
    authenticatedEmail: person.email, emailVerified: true, isTenantAdmin: false,
    entitlements: { workspaceIds: [workspaceId], fundIds: ['fund-a'], documentIds: [], sourceDocumentAccessAllowed: false },
    ...overrides,
  };
}
const asAdmin = identity(admin, { roles: ['admin'], isTenantAdmin: true, entitlements: { workspaceIds: [workspaceId], fundIds: [], documentIds: [], sourceDocumentAccessAllowed: false } });
const command = (key, overrides = {}) => ({
  idempotencyKey: key, figure: 'review', comment: 'Revenue for ABC Corp looks too high.',
  scope: { fundId: 'fund-a', fundLabel: 'Secret Growth Fund', companyId: 'company-1', companyLabel: 'ABC Corp', metricCode: 'revenue', metricLabel: 'Revenue', reportPeriod: '2026-Q2', snapshotId, snapshotVersion: 1 },
  ...overrides,
});
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
    const backend = new PostgresDataIssueBackend(() => tx);
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f5-ci','F5 CI'),($2,'f5-ci-other','F5 CI Other')`, [tenantId, otherTenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Growth Fund Workspace'),($3,$4,'ws','Other Workspace')`, [workspaceId, tenantId, otherWorkspaceId, otherTenantId]);
    for (const person of [reporter, colleague, admin]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenantId, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'analyst'),($1,$2,$4,'analyst'),($1,$2,$5,'tenant_admin')`, [tenantId, workspaceId, reporter.userId, colleague.userId, admin.userId]);
    for (const person of [reporter, colleague]) {
      await tx.execute(`insert into corvis_control.resource_entitlement (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission) values ($1,$2,$3,'fund','fund-a','read')`, [tenantId, workspaceId, person.userId]);
    }
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible) values ($1,'fund','fund-a',true)`, [tenantId]);
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,published_at)
      values ($1,$2,'fund-a','2026-Q2',1,'published','1','1',now()),($1,$3,'fund-a','2026-Q2',1,'published','1','1',now())`, [tenantId, snapshotId, replacementId]);
    for (const person of [reporter, colleague, admin]) await captureVerifiedRecipient(identity(person), tx);

    const stateBefore = await tx.query(`select (select count(*) from corvis_consolidated.fund_period_snapshot)::int as snapshots, (select count(*) from corvis_control.outbox_event)::int as outbox,
      (select count(*) from corvis_control.data_correction_incident)::int as incidents, (select count(*) from corvis_control.email_outbox)::int as emails`);

    // Reporting: idempotent, tenant-scoped, inert.
    const first = await backend.report(identity(reporter), command('r-1'), tx);
    assert.equal(first.created, true);
    assert.deepEqual([first.item.status, first.item.routedTo, first.item.reportedByMe, first.item.hasUnseenUpdate], ['received', 'data_operations', true, false]);
    assert.equal((await backend.report(identity(reporter), command('r-1'), tx)).created, false, 'a retry returns the original case');
    assert.equal((await backend.report(identity(reporter), command('r-1'), tx)).item.caseId, first.item.caseId);
    const reused = await refused(tx, () => backend.report(identity(reporter), command('r-1', { comment: 'a different complaint' }), tx));
    assert.equal(reused.applicationError, 'idempotency key reused with different data issue report');
    const afterState = await tx.query(`select (select count(*) from corvis_consolidated.fund_period_snapshot)::int as snapshots, (select count(*) from corvis_control.outbox_event)::int as outbox,
      (select count(*) from corvis_control.data_correction_incident)::int as incidents, (select count(*) from corvis_control.email_outbox)::int as emails`);
    assert.deepEqual(afterState[0], stateBefore[0], 'reporting changes no snapshot, queues no event, opens no correction and sends no email');

    // Visibility: the reporter and Organization Admins only; a colleague with the same fund entitlement sees nothing.
    assert.equal((await backend.get(identity(reporter), first.item.caseId, tx)).history.length, 1);
    assert.equal((await backend.get(asAdmin, first.item.caseId, tx)).reportedByMe, false);
    for (const attempt of [() => backend.get(identity(colleague), first.item.caseId, tx), () => backend.acknowledge(identity(colleague), first.item.caseId, tx), () => backend.get(asAdmin, 'f5000000-0000-4000-8000-0000000000ff', tx)]) {
      assert.equal((await refused(tx, attempt)).code, 'data_issue_not_found');
    }
    assert.equal((await refused(tx, () => backend.get({ ...asAdmin, tenantId: otherTenantId }, first.item.caseId, tx))).code, 'data_issue_not_found', 'another tenant cannot read it');
    assert.equal((await backend.list(identity(colleague), { scope: 'mine', limit: 10 }, tx)).items.length, 0);
    assert.equal((await backend.list(identity(reporter, { entitlements: { workspaceIds: [workspaceId], fundIds: [], sourceDocumentAccessAllowed: false } }), { scope: 'mine', limit: 10 }, tx)).items.length, 0, 'losing the fund entitlement hides the case from its reporter');

    // Keyset paging over ties (one transaction shares one now()): every case exactly once, newest first.
    for (const key of ['r-2', 'r-3', 'r-4', 'r-5']) await backend.report(identity(reporter), command(key), tx);
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await backend.list(asAdmin, { scope: 'all', limit: 2, cursor }, tx);
      seen.push(...page.items.map((item) => item.caseId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5, 'no case is repeated or skipped at a page boundary');
    assert.equal((await backend.list(asAdmin, { scope: 'all', limit: 50, status: 'investigating' }, tx)).items.length, 0);

    // Data Operations: the state machine, the link to the governed correction, and the reporter's notice by status.
    assert.equal((await refused(tx, () => backend.transition(asAdmin, first.item.caseId, { action: 'correct' }, tx))).applicationError, 'data issue transition not allowed');
    await tx.execute(`insert into corvis_control.data_correction_incident (tenant_id,incident_id,idempotency_key,request_hash,fund_id,report_period,state,root_cause,correction_intent,opened_by)
      values ($1,$2,'f5-incident',repeat('a',64),'fund-a','2026-Q2','open','mapping','republish','ops')`, [tenantId, incidentId]);
    const investigating = await backend.transition(asAdmin, first.item.caseId, { action: 'investigate', expectedStatus: 'received', correctionIncidentId: incidentId, note: 'Checking.' }, tx);
    assert.equal(investigating.status, 'investigating');
    assert.equal(investigating.correctionIncidentId, incidentId, 'Organization Admins see the governed incident');
    const reporterView = await backend.get(identity(reporter), first.item.caseId, tx);
    assert.deepEqual([reporterView.status, reporterView.hasUnseenUpdate, reporterView.correctionIncidentId], ['investigating', true, undefined]);
    assert.equal((await backend.list(identity(reporter), { scope: 'mine', limit: 50 }, tx)).unseenUpdateCount, 1);
    assert.equal((await backend.acknowledge(identity(reporter), first.item.caseId, tx)).hasUnseenUpdate, false);
    assert.equal((await backend.list(identity(reporter), { scope: 'mine', limit: 50 }, tx)).unseenUpdateCount, 0);

    const noticeRows = await tx.query(`select category,status,fund_id,workspace_id::text,template_params,dedupe_key from corvis_control.email_outbox where tenant_id=$1 and category='data_issue_update'`, [tenantId]);
    assert.equal(noticeRows.length, 1);
    assert.deepEqual([noticeRows[0].status, noticeRows[0].fund_id, noticeRows[0].dedupe_key], ['queued', 'fund-a', `data_issue_update:${first.item.caseId}:investigating`]);
    assert.deepEqual(noticeRows[0].template_params, { status: 'investigating' }, 'the queued notice names the status and nothing else');

    // Dispatch: the reporter is emailed in words only; the colleague and the admin are not.
    const sender = new RecordingEmailSender();
    const run = await processEmailOutbox({ db: tx, sender, appUrl });
    assert.equal(run.sent, 1);
    assert.equal(sender.sent[0].to, 'reporter@example.com');
    assert.equal(sender.sent[0].category, 'data_issue_update');
    assert.match(sender.sent[0].text, /Data Operations is investigating a data issue you reported in Growth Fund Workspace\./);
    assert.match(sender.sent[0].text, /https:\/\/app\.corvis\.test\/#\/issues/);
    for (const secret of ['Secret Growth Fund', 'ABC Corp', 'Revenue', 'too high', first.item.caseId, 'fund-a']) {
      assert.ok(!sender.sent[0].text.includes(secret) && !sender.sent[0].html.includes(secret) && !sender.sent[0].subject.includes(secret), `${secret} must never be emailed`);
    }

    // Correcting through the governed flow: resolve the incident, then close every linked case once.
    await tx.query(`select corvis_control.resolve_data_correction_incident($1::uuid,$2::uuid,$3::uuid,1,'ops','{}'::jsonb)`, [tenantId, incidentId, replacementId]);
    const audited = [];
    const closed = await closeDataIssuesForCorrection(tx, asAdmin, incidentId, 'corr-1', async (event) => { audited.push(event); });
    assert.equal(closed.length, 1);
    assert.deepEqual([closed[0].status, closed[0].replacement], ['corrected', { snapshotId: replacementId, snapshotVersion: 1 }]);
    assert.equal(audited.length, 1);
    assert.equal(audited[0].action, 'data_issue.correct');
    assert.deepEqual(await closeDataIssuesForCorrection(tx, asAdmin, incidentId, 'corr-2', async () => { throw new Error('nothing left to audit'); }), [], 'a second resolve closes nothing');
    const corrected = await backend.get(identity(reporter), first.item.caseId, tx);
    assert.deepEqual([corrected.status, corrected.hasUnseenUpdate, corrected.replacement.snapshotVersion], ['corrected', true, 1]);
    assert.deepEqual(corrected.history.map((event) => event.toStatus), ['received', 'investigating', 'corrected']);

    const correctedSender = new RecordingEmailSender();
    assert.equal((await processEmailOutbox({ db: tx, sender: correctedSender, appUrl })).sent, 1);
    assert.match(correctedSender.sent[0].text, /was corrected\. A replacement publication is available\./);

    // Preferences are honoured: opting out of data issue updates suppresses the next notice but not the in-app status.
    await updateNotificationPreferences(identity(reporter), { categories: [{ id: 'data_issue_update', enabled: false, delivery: 'immediate' }] }, { db: tx, sender });
    const second = (await backend.list(identity(reporter), { scope: 'mine', limit: 50 }, tx)).items.find((item) => item.status === 'received');
    await backend.transition(asAdmin, second.caseId, { action: 'investigate' }, tx);
    assert.equal((await processEmailOutbox({ db: tx, sender: new RecordingEmailSender(), appUrl })).suppressed, 1);
    const suppressed = await tx.query(`select suppression_reason from corvis_control.email_outbox where tenant_id=$1 and dedupe_key=$2`, [tenantId, `data_issue_update:${second.caseId}:investigating`]);
    assert.equal(suppressed[0].suppression_reason, 'opted_out');
    assert.equal((await backend.get(identity(reporter), second.caseId, tx)).status, 'investigating');

    // No change needs a reason, and a closed case does not move again.
    const third = (await backend.list(identity(reporter), { scope: 'mine', limit: 50 }, tx)).items.find((item) => item.status === 'received');
    await backend.transition(asAdmin, third.caseId, { action: 'investigate' }, tx);
    const done = await backend.transition(asAdmin, third.caseId, { action: 'no_change', note: 'Matches the source document.' }, tx);
    assert.deepEqual([done.status, done.resolutionNote, done.replacement], ['no_change', 'Matches the source document.', null]);

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('DATA_ISSUE_REPORTS_PASS');
} finally {
  await db.close?.();
}
