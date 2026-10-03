// Real-Postgres acceptance for email notifications (#258): recipient capture,
// preferences, audience enqueueing, send-time eligibility re-checks, digests and
// invitation outcome records. Runs lib/server/notifications.ts against a native
// connection inside one transaction that is always rolled back. Run after the
// full migration chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/email-notifications.mjs
import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../lib/server/postgres-native.ts';
import { RecordingEmailSender } from '../../../adapters/email/recording-email-sender.ts';
import { DisabledEmailSender } from '../../../adapters/email/disabled-email-sender.ts';
import {
  captureVerifiedRecipient, deliverInvitationEmail, enqueueExportReady, enqueueForRoleAudience, enqueueForUser,
  enqueuePinnedFundPublished, getNotificationSettings, processEmailDigests, processEmailOutbox, updateNotificationPreferences,
} from '../../../lib/server/notifications.ts';

const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const tenantId = 'e2000000-0000-4000-8000-000000000001';
const workspaceId = 'e2000000-0000-4000-8000-000000000002';
const otherWorkspaceId = 'e2000000-0000-4000-8000-000000000003';
const admin = { userId: 'e2000000-0000-4000-8000-0000000000a1', subject: 'admin-subject', email: 'admin@example.com' };
const analyst = { userId: 'e2000000-0000-4000-8000-0000000000a2', subject: 'analyst-subject', email: 'analyst@example.com' };
const leaver = { userId: 'e2000000-0000-4000-8000-0000000000a3', subject: 'leaver-subject', email: 'leaver@example.com' };
const snapshotId = 'e2000000-0000-4000-8000-0000000000b1';
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

async function statuses(tx, category) {
  const rows = await tx.query(`select recipient_user_id::text as user_id,status,suppression_reason from corvis_control.email_outbox
    where tenant_id=$1 and category=$2 order by recipient_user_id`, [tenantId, category]);
  return Object.fromEntries(rows.map((row) => [row.user_id, row.suppression_reason ? `${row.status}:${row.suppression_reason}` : row.status]));
}

const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'email-ci','Email CI')`, [tenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Growth Fund Workspace'),($3,$2,'ws2','Other Workspace')`, [workspaceId, tenantId, otherWorkspaceId]);
    for (const person of [admin, analyst, leaver]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenantId, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values
      ($1,$2,$3,'tenant_admin'),($1,$2,$4,'analyst'),($1,$2,$5,'viewer')`, [tenantId, workspaceId, admin.userId, analyst.userId, leaver.userId]);
    await tx.execute(`insert into corvis_control.resource_entitlement (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission)
      values ($1,$2,$3,'fund','fund-a','read')`, [tenantId, workspaceId, analyst.userId]);
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible) values ($1,'fund','fund-a',true)`, [tenantId]);

    // Recipient capture: verified claims only, and never for unknown subjects.
    await captureVerifiedRecipient(identity(admin), tx);
    await captureVerifiedRecipient(identity(analyst), tx);
    await captureVerifiedRecipient(identity(leaver, { emailVerified: false }), tx);
    await captureVerifiedRecipient(identity({ subject: 'nobody', email: 'nobody@example.com' }), tx);
    const recipients = await tx.query(`select user_id::text,email from corvis_control.notification_recipient where tenant_id=$1 order by email`, [tenantId]);
    assert.deepEqual(recipients.map((row) => row.email), ['admin@example.com', 'analyst@example.com'], 'only verified claims of known subjects are recorded');

    // Preferences: defaults, persisted changes, hidden and mandatory categories.
    const sender = new RecordingEmailSender();
    const defaults = await getNotificationSettings(identity(analyst), { db: tx, sender });
    assert.equal(defaults.address, 'analyst@example.com');
    assert.deepEqual(defaults.categories.map((category) => category.id), ['export_ready', 'pinned_fund_published', 'data_issue_update', 'review_discussion', 'role_changed'], 'admin-only categories are hidden from analysts');
    await assert.rejects(updateNotificationPreferences(identity(analyst), { categories: [{ id: 'role_changed', enabled: false, delivery: 'immediate' }] }, { db: tx, sender }), /category_not_configurable/);
    await assert.rejects(updateNotificationPreferences(identity(analyst), { categories: [{ id: 'source_attention', enabled: false, delivery: 'immediate' }] }, { db: tx, sender }), /unknown_category/);
    const updated = await updateNotificationPreferences(identity(analyst), { categories: [{ id: 'export_ready', enabled: false, delivery: 'immediate' }] }, { db: tx, sender });
    assert.equal(updated.categories.find((category) => category.id === 'export_ready').enabled, false);
    const adminSettings = await getNotificationSettings(identity(admin, { roles: ['admin'], isTenantAdmin: true }), { db: tx, sender });
    assert.ok(adminSettings.categories.some((category) => category.id === 'support_access' && category.mandatory), 'organization admins see the mandatory support notice');

    // Enqueue: role audiences, requester, pinned fund and role change; dedupe keys make each idempotent.
    for (let i = 0; i < 2; i++) {
      await enqueueForRoleAudience(tx, { tenantId, workspaceId: null, roles: ['tenant_admin'], category: 'support_access', params: { status: 'active' }, dedupeBase: 'support_access:grant-1:active' });
      await enqueueForRoleAudience(tx, { tenantId, workspaceId, roles: ['tenant_admin', 'accountadmin'], category: 'source_attention', params: { status: 'suspended' }, dedupeBase: 'source_attention:run-1' });
      await enqueueExportReady(tx, { tenantId, exportId: 'export-1', workspaceId, authMethod: 'oidc', subject: analyst.subject, format: 'csv' });
      await enqueueExportReady(tx, { tenantId, exportId: 'export-2', workspaceId, authMethod: 'oidc', subject: admin.subject, format: 'csv' });
      await enqueueForUser(tx, { tenantId, userId: leaver.userId, category: 'role_changed', workspaceId, params: { roleName: null }, dedupeKey: 'role_changed:audit-1' });
    }
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version)
      values ($1,$2,'fund-a','2026-Q2',1,'published','1','1')`, [tenantId, snapshotId]);
    await tx.execute(`insert into corvis_control.workspace_user_preference (tenant_id,workspace_id,auth_method,subject,pinned_fund_ids) values
      ($1,$2,'oidc',$3,'{fund-a}'),($1,$2,'oidc',$4,'{fund-a}')`, [tenantId, workspaceId, analyst.subject, leaver.subject]);
    await enqueuePinnedFundPublished(tx, { tenantId, snapshotId });
    await enqueuePinnedFundPublished(tx, { tenantId, snapshotId });
    const counts = await tx.query(`select category,count(*)::int as n from corvis_control.email_outbox where tenant_id=$1 group by category order by category`, [tenantId]);
    assert.deepEqual(Object.fromEntries(counts.map((row) => [row.category, row.n])),
      { export_ready: 2, pinned_fund_published: 2, role_changed: 1, source_attention: 1, support_access: 1 }, 'one row per recipient, deduplicated');

    // Dispatch with the provider off: rows are suppressed honestly, never sent.
    const off = await processEmailOutbox({ db: tx, sender: new DisabledEmailSender(), appUrl });
    assert.equal(off.sent, 0);
    assert.equal((await statuses(tx, 'support_access'))[admin.userId], 'suppressed:provider_not_configured');
    await tx.execute(`update corvis_control.email_outbox set status='queued',suppression_reason=null,attempts=0 where tenant_id=$1 and status='suppressed' and suppression_reason='provider_not_configured'`, [tenantId]);
    await tx.execute(`update corvis_control.email_outbox set status='queued',attempts=0 where tenant_id=$1 and status='digest_pending'`, [tenantId]);

    // Dispatch with a provider: preferences, eligibility and addresses are all re-checked at send time.
    const run = await processEmailOutbox({ db: tx, sender, appUrl });
    assert.equal(run.claimed, 4, "only the requeued rows are claimed again");
    assert.equal((await statuses(tx, 'support_access'))[admin.userId], 'sent');
    assert.equal((await statuses(tx, 'source_attention'))[admin.userId], 'sent');
    assert.equal((await statuses(tx, 'export_ready'))[analyst.userId], 'suppressed:opted_out', 'an opted-out category is not sent');
    assert.equal((await statuses(tx, 'export_ready'))[admin.userId], 'sent');
    assert.equal((await statuses(tx, 'pinned_fund_published'))[analyst.userId], 'digest_pending', 'the default for pinned funds is the daily digest');
    assert.equal((await statuses(tx, 'pinned_fund_published'))[leaver.userId], 'suppressed:not_eligible', 'a pin without a current fund entitlement is never emailed');
    assert.equal((await statuses(tx, 'role_changed'))[leaver.userId], 'suppressed:no_verified_address', 'mandatory notices still need a verified address');
    assert.equal(sender.sent.length, 3);
    for (const email of sender.sent) {
      assert.doesNotMatch(email.text, /fund-a|2026-Q2/, 'emails carry no fund identifiers or periods');
      assert.match(email.text, /https:\/\/app\.corvis\.test\//);
    }
    assert.match(sender.sent.find((email) => email.category === 'source_attention').text, /Growth Fund Workspace/, 'the workspace name is resolved at send time');

    // A deactivated identity is not emailed even for a queued mandatory notice.
    await tx.execute(`update corvis_control.identity_subject set status='disabled',disabled_at=now() where tenant_id=$1 and user_id=$2`, [tenantId, admin.userId]);
    await enqueueForUser(tx, { tenantId, userId: admin.userId, category: 'role_changed', workspaceId, params: { roleName: 'viewer' }, dedupeKey: 'role_changed:audit-2' });
    await processEmailOutbox({ db: tx, sender, appUrl });
    assert.equal((await statuses(tx, 'role_changed'))[admin.userId], 'suppressed:not_eligible');

    // Retryable failures back off; the row is retried, not lost.
    await tx.execute(`update corvis_control.identity_subject set status='active',disabled_at=null where tenant_id=$1 and user_id=$2`, [tenantId, admin.userId]);
    await enqueueForUser(tx, { tenantId, userId: admin.userId, category: 'role_changed', workspaceId, params: { roleName: 'analyst' }, dedupeKey: 'role_changed:audit-3' });
    const flaky = new RecordingEmailSender([{ status: 'failed', retryable: true, errorClass: 'provider_timeout' }]);
    const retried = await processEmailOutbox({ db: tx, sender: flaky, appUrl });
    assert.equal(retried.retried, 1);
    const retryRow = (await tx.query(`select status,attempts,next_attempt_at > now() as later from corvis_control.email_outbox where tenant_id=$1 and dedupe_key like 'role_changed:audit-3%'`, [tenantId]))[0];
    assert.deepEqual([retryRow.status, retryRow.attempts, retryRow.later], ['retry', 1, true]);

    // Digests bundle deferred items once the oldest has waited the window.
    await tx.execute(`update corvis_control.email_outbox set created_at=now()-interval '25 hours' where tenant_id=$1 and status='digest_pending'`, [tenantId]);
    assert.equal((await processEmailDigests({ db: tx })).digests, 1);
    assert.equal((await processEmailDigests({ db: tx })).digests, 0, 'digested items are not bundled twice');
    const digestSender = new RecordingEmailSender();
    await processEmailOutbox({ db: tx, sender: digestSender, appUrl });
    assert.equal(digestSender.sent.length, 1);
    assert.equal(digestSender.sent[0].category, 'digest');
    assert.match(digestSender.sent[0].text, /New data for pinned funds/);

    // Invitations are sent inline; the outbox records the outcome without the link.
    const invitation = { invitationId: 'e2000000-0000-4000-8000-0000000000c1', tenantId, workspaceId, workspaceName: 'Growth Fund Workspace', email: 'new@example.com', roleName: 'analyst', expiresAt: '2026-10-07T00:00:00.000Z' };
    const inviteSender = new RecordingEmailSender();
    assert.equal(await deliverInvitationEmail(invitation, 'a'.repeat(43), { db: tx, sender: inviteSender, appUrl }), 'sent');
    assert.match(inviteSender.sent[0].text, /https:\/\/app\.corvis\.test\/invite\?tenantId=.*#a{43}/);
    assert.equal(await deliverInvitationEmail({ ...invitation, invitationId: 'e2000000-0000-4000-8000-0000000000c2' }, 'b'.repeat(43), { db: tx, sender: new DisabledEmailSender(), appUrl }), 'not_configured');
    const stored = await tx.query(`select status,template_params::text as params from corvis_control.email_outbox where tenant_id=$1 and category='invitation' order by status`, [tenantId]);
    assert.deepEqual(stored.map((row) => row.status), ['sent', 'suppressed']);
    assert.ok(stored.every((row) => !row.params.includes('aaaa') && !row.params.includes('invite')), 'the invitation token is never persisted');

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('EMAIL_NOTIFICATIONS_PASS');
} finally {
  await db.close?.();
}
