// Real-Postgres acceptance for assigning and discussing review items (F3, #259), through the application code: the
// repository in lib/server/review-discussion.ts drives the SQL functions of migration 084 inside one transaction that is
// always rolled back. Covers what the pure-SQL test (review-item-discussion.sql) cannot: the repository's predicates and
// labels, keyset paging, the open-assignments read behind the Overview attention list, the audit event round trip, the
// notice and its send-time eligibility and preferences from the F2 outbox, and that discussion leaves dual control alone.
// Run after the full migration chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/review-item-discussion.mjs
import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../lib/server/postgres-native.ts';
import { RecordingEmailSender } from '../../../adapters/email/recording-email-sender.ts';
import { PostgresReviewDiscussionBackend, commentFingerprint, reviewDiscussionAuditEvent } from '../../../lib/server/review-discussion.ts';
import { PostgresOperationsRepository } from '../../../lib/server/platform-repositories.ts';
import { captureVerifiedRecipient, processEmailOutbox, updateNotificationPreferences } from '../../../lib/server/notifications.ts';
import { mentionedUserIds } from '../../../core/review-discussion.ts';

const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');

const tenantId = 'f3000000-0000-4000-8000-000000000001';
const otherTenantId = 'f3000000-0000-4000-8000-000000000009';
const workspaceId = 'f3000000-0000-4000-8000-000000000002';
const otherWorkspaceId = 'f3000000-0000-4000-8000-00000000000a';
const ana = { userId: 'f3000000-0000-4000-8000-0000000000a1', subject: 'ana-subject', email: 'ana@example.com' };
const ben = { userId: 'f3000000-0000-4000-8000-0000000000a2', subject: 'ben-subject', email: 'ben@example.com' };
const cleo = { userId: 'f3000000-0000-4000-8000-0000000000a3', subject: 'cleo-subject', email: 'cleo@example.com' };
const dev = { userId: 'f3000000-0000-4000-8000-0000000000a4', subject: 'dev-subject', email: 'dev@example.com' };
const zed = { userId: 'f3000000-0000-4000-8000-0000000000a5', subject: 'zed-subject', email: 'zed@example.com' };
const documentId = 'f3000000-0000-4000-8000-0000000000d1';
const artifactId = 'f3000000-0000-4000-8000-0000000000d2';
const referenceId = 'f3000000-0000-4000-8000-0000000000d3';
const obsOpen = 'f3000000-0000-4000-8000-0000000000f1';
const obsApproved = 'f3000000-0000-4000-8000-0000000000f2';
const obsOtherFund = 'f3000000-0000-4000-8000-0000000000f3';
const exceptionId = 'f3000000-0000-4000-8000-0000000000f4';
const snapshotId = 'f3000000-0000-4000-8000-0000000000c1';
const appUrl = 'https://app.corvis.test';
const ROLLBACK = Symbol('rollback');

function identity(person, roles = ['reviewer'], overrides = {}) {
  return {
    subject: person.subject, tenantId, workspaceId, roles, authMethod: 'oidc', sessionId: `session-${person.subject}`,
    authenticatedEmail: person.email, emailVerified: true, isTenantAdmin: false,
    entitlements: { workspaceIds: [workspaceId], fundIds: ['fund-a'], documentIds: [documentId], sourceDocumentAccessAllowed: true },
    ...overrides,
  };
}
const subject = (kind, id) => ({ subjectKind: kind, subjectId: id });
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
const counts = (tx) => tx.query(`select (select count(*) from corvis_facts.observation)::int as observations,
  (select md5(string_agg(o::text, '|' order by o.observation_id)) from corvis_facts.observation o) as observation_digest,
  (select count(*) from corvis_facts.review_event)::int as review_events,
  (select count(*) from corvis_consolidated.reconciliation_resolution_event)::int as resolutions,
  (select count(*) from corvis_consolidated.snapshot_publication_event)::int as publications,
  (select count(*) from corvis_control.outbox_event)::int as outbox_events`).then((rows) => rows[0]);

const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    const backend = new PostgresReviewDiscussionBackend(() => tx);
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f3-ci','F3 CI'),($2,'f3-ci-other','F3 CI Other')`, [tenantId, otherTenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Review Workspace'),($3,$2,'ws-two','Second Workspace'),('f3000000-0000-4000-8000-0000000000b1',$4,'ws','Other Tenant')`, [workspaceId, tenantId, otherWorkspaceId, otherTenantId]);
    for (const person of [ana, ben, cleo, dev, zed]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenantId, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values
      ($1,$2,$3,'reviewer'),($1,$2,$4,'accountadmin'),($1,$2,$5,'analyst'),($1,$2,$6,'reviewer'),($1,$7,$8,'reviewer')`,
    [tenantId, workspaceId, ana.userId, ben.userId, cleo.userId, dev.userId, otherWorkspaceId, zed.userId]);
    for (const [person, fund, workspace] of [[ana, 'fund-a', workspaceId], [ben, 'fund-a', workspaceId], [cleo, 'fund-a', workspaceId], [dev, 'fund-b', workspaceId], [zed, 'fund-a', otherWorkspaceId]]) {
      await tx.execute(`insert into corvis_control.resource_entitlement (tenant_id,workspace_id,subject_user_id,resource_type,resource_id,permission) values ($1,$2,$3,'fund',$4,'read')`, [tenantId, workspace, person.userId, fund]);
    }
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible) values ($1,'fund','fund-a',true),($1,'fund','fund-b',true)`, [tenantId]);
    for (const person of [ana, ben, dev]) await captureVerifiedRecipient(identity(person), tx);

    await tx.execute(`insert into corvis_source.document(tenant_id,document_id,display_name,media_type,status,created_by) values($1,$2,'Quarterly.pdf','application/pdf','published','fixture')`, [tenantId, documentId]);
    await tx.execute(`insert into corvis_source.document_artifact_version(tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes,storage_generation,malware_scan_status,quarantine_status) values($1,$2,$3,'f3-fixture','gs://test/f3',1,'42','clean','released')`, [tenantId, artifactId, documentId]);
    await tx.execute(`insert into corvis_source.source_reference(tenant_id,source_reference_id,document_id,document_artifact_version_id) values($1,$2,$3,$4)`, [tenantId, referenceId, documentId, artifactId]);
    for (const [id, fund, state] of [[obsOpen, 'fund-a', 'review_required'], [obsApproved, 'fund-a', 'approved'], [obsOtherFund, 'fund-b', 'review_required']]) {
      await tx.execute(`insert into corvis_facts.observation(tenant_id,observation_id,fund_id,company_id,metric_code,value_number,currency,economic_period,review_state,source_reference_id,schema_version) values($1,$2,$3,'company-a','revenue',100,'USD','Q2 2026',$4,$5,'v1')`, [tenantId, id, fund, state, referenceId]);
    }
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot(tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version) values($1,$2,'fund-a','Q2 2026',1,'blocked','v1','v1')`, [tenantId, snapshotId]);
    await tx.execute(`insert into corvis_consolidated.reconciliation_exception(tenant_id,exception_id,snapshot_id,snapshot_version,exception_key,fund_id,report_period,exception_type,subject_type,subject_id,metric_code,summary,created_by) values($1,$2,$3,1,'f3','fund-a','Q2 2026','source_authority','company','company-a','revenue','Competing revenue values','fixture')`, [tenantId, exceptionId, snapshotId]);

    const before = await counts(tx);
    const sender = new RecordingEmailSender();

    // Assign: the thread names the assignee by the verified address, and nothing is decided.
    const assigned = await backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: ben.userId, expectedVersion: 0 }, tx);
    assert.deepEqual(assigned.change, { previousAssigneeUserId: null, fundId: 'fund-a' });
    assert.deepEqual([assigned.thread.version, assigned.thread.assignee.displayName, assigned.thread.assignee.isMe, assigned.thread.commentCount], [1, 'ben@example.com', false, 0]);
    const unchanged = await backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: ben.userId, expectedVersion: 1 }, tx);
    assert.equal(unchanged.change, null, 'assigning the current assignee changes nothing');

    // Only people with review access to the fund in this workspace can be assigned.
    for (const [person, label] of [[cleo, 'an analyst'], [dev, 'a reviewer without the fund'], [zed, 'a reviewer of another workspace'], [{ userId: 'f3000000-0000-4000-8000-0000000000ff' }, 'a stranger']]) {
      const error = await refused(tx, () => backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: person.userId, expectedVersion: 1 }, tx));
      assert.equal(error.applicationError, 'review assignee not eligible', label);
    }
    assert.equal((await refused(tx, () => backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: ben.userId, expectedVersion: 0 }, tx))).applicationError, 'review item assignment changed');
    assert.equal((await refused(tx, () => backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: 'not-a-uuid', expectedVersion: 1 }, tx))).code, 'assignee_not_eligible');

    // The notice: queued with the roles to re-check, saying only that an item was assigned; dispatched in words without any name.
    const queued = await tx.query(`select recipient_user_id::text,status,fund_id,required_roles,template_params,dedupe_key from corvis_control.email_outbox where tenant_id=$1 and category='review_discussion'`, [tenantId]);
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].recipient_user_id, queued[0].status, queued[0].fund_id, queued[0].template_params, queued[0].dedupe_key], [ben.userId, 'queued', 'fund-a', { event: 'assigned' }, `review_discussion:assigned:observation:${obsOpen}:1`]);
    assert.deepEqual([...queued[0].required_roles].sort(), ['accountadmin', 'reviewer', 'tenant_admin']);
    assert.equal((await processEmailOutbox({ db: tx, sender, appUrl })).sent, 1);
    assert.equal(sender.sent[0].to, 'ben@example.com');
    assert.equal(sender.sent[0].category, 'review_discussion');
    assert.match(sender.sent[0].text, /A review item in Review Workspace was assigned to you\./);
    assert.match(sender.sent[0].text, /https:\/\/app\.corvis\.test\/#\/review/);
    for (const secret of ['fund-a', 'company-a', 'revenue', 'ana@example.com', obsOpen]) {
      assert.ok(!sender.sent[0].text.includes(secret) && !sender.sent[0].html.includes(secret) && !sender.sent[0].subject.includes(secret), `${secret} must never be emailed`);
    }

    // Reassign to yourself (no email), then unassign; the version counts changes of assignee.
    const toMe = await backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: ana.userId, expectedVersion: 1 }, tx);
    assert.deepEqual([toMe.thread.version, toMe.change.previousAssigneeUserId, toMe.thread.assignee.isMe], [2, ben.userId, true]);
    assert.equal((await tx.query(`select count(*)::int as n from corvis_control.email_outbox where tenant_id=$1 and category='review_discussion'`, [tenantId]))[0].n, 1, 'assigning yourself queues no notice');

    // Comments: append-only, idempotent, mentions verified and notified, text never emailed.
    const members = (await backend.getThread(identity(ana), subject('observation', obsOpen), tx)).members;
    assert.deepEqual(members.map((member) => [member.displayName, member.roleLabel, member.isMe]).sort(), [['ana@example.com', 'Review Analyst', true], ['ben@example.com', 'Workspace Admin', false]],
      'cleo (analyst), dev (no fund) and zed (other workspace) are not offered');
    const text = `Please check page 4, @ben@example.com. The revenue looks too high.`;
    assert.deepEqual(mentionedUserIds(text, members), [ben.userId]);
    const command = { idempotencyKey: 'c-1', body: text, mentionUserIds: [ben.userId, ana.userId] };
    const first = await backend.comment(identity(ana), subject('observation', obsOpen), command, tx);
    assert.deepEqual([first.created, first.comment.author.isMe, first.comment.mentions.map((mention) => mention.displayName), first.thread.commentCount, first.thread.version], [true, true, ['ben@example.com', 'ana@example.com'], 1, 2]);
    const replay = await backend.comment(identity(ana), subject('observation', obsOpen), command, tx);
    assert.deepEqual([replay.created, replay.comment.commentId, replay.thread.commentCount], [false, first.comment.commentId, 1]);
    assert.equal((await refused(tx, () => backend.comment(identity(ana), subject('observation', obsOpen), { ...command, body: 'something else' }, tx))).applicationError, 'idempotency key reused with different review comment');
    assert.equal((await refused(tx, () => backend.comment(identity(ana), subject('observation', obsOpen), { idempotencyKey: 'c-2', body: 'hi @cleo', mentionUserIds: [cleo.userId] }, tx))).applicationError, 'review mention not eligible');
    assert.equal((await backend.getThread(identity(ana), subject('observation', obsOpen), tx)).commentCount, 1, 'a refused comment writes nothing');
    const second = await backend.comment(identity(ben), subject('observation', obsOpen), { idempotencyKey: 'c-1', body: 'On it.', mentionUserIds: [] }, tx);
    assert.equal(second.created, true, 'keys are per author');
    assert.equal(second.comment.author.isMe, true);

    const mentions = await tx.query(`select recipient_user_id::text,template_params,dedupe_key from corvis_control.email_outbox where tenant_id=$1 and category='review_discussion' and dedupe_key like 'review_discussion:mention:%'`, [tenantId]);
    assert.equal(mentions.length, 1, 'ben is notified; ana, the author, is not');
    assert.deepEqual([mentions[0].recipient_user_id, mentions[0].template_params], [ben.userId, { event: 'mentioned' }]);
    const mentionSender = new RecordingEmailSender();
    assert.equal((await processEmailOutbox({ db: tx, sender: mentionSender, appUrl })).sent, 1);
    assert.match(mentionSender.sent[0].text, /You were mentioned in a discussion on a review item in Review Workspace\./);
    for (const secret of ['page 4', 'revenue looks too high', 'ana@example.com', 'fund-a']) {
      assert.ok(!mentionSender.sent[0].text.includes(secret) && !mentionSender.sent[0].html.includes(secret) && !mentionSender.sent[0].subject.includes(secret), `${secret} must never be emailed`);
    }

    // Append-only at the database, even for the application's own role.
    for (const statement of [`update corvis_control.review_item_comment set body='edited' where tenant_id=$1`, `delete from corvis_control.review_item_comment where tenant_id=$1`, `delete from corvis_control.review_item_thread where tenant_id=$1`]) {
      await refused(tx, () => tx.execute(statement, [tenantId]));
    }

    // Visibility: the item must be one the caller can read in Data review; other funds, tenants and malformed ids are all 404.
    for (const attempt of [
      () => backend.getThread(identity(ana), subject('observation', obsOtherFund), tx),
      () => backend.getThread(identity(ana, ['reviewer'], { entitlements: { workspaceIds: [workspaceId], fundIds: ['fund-a'], documentIds: [], sourceDocumentAccessAllowed: true } }), subject('observation', obsOpen), tx),
      () => backend.getThread(identity(ana, ['reviewer'], { tenantId: otherTenantId }), subject('observation', obsOpen), tx),
      () => backend.getThread(identity(ana), subject('observation', 'not-a-uuid'), tx),
      () => backend.comment(identity(ana), subject('observation', obsOtherFund), { idempotencyKey: 'x', body: 'x', mentionUserIds: [] }, tx),
      () => backend.assign(identity(ana), subject('observation', obsOtherFund), { assigneeUserId: ana.userId, expectedVersion: 0 }, tx),
    ]) {
      const error = await refused(tx, attempt);
      assert.ok(error.code === 'review_item_not_found' || error.code === 'human_identity_required', `an invisible item is refused: ${error.code}`);
    }
    assert.equal((await refused(tx, () => backend.getThread(identity(ana), subject('observation', obsOtherFund), tx))).code, 'review_item_not_found');

    // The thread index: only items the caller can read, keyset paged over ties (one transaction shares one now()).
    await backend.assign(identity(ana), subject('observation', obsApproved), { assigneeUserId: ben.userId, expectedVersion: 0 }, tx);
    await backend.assign(identity(ana), subject('reconciliation_exception', exceptionId), { assigneeUserId: ben.userId, expectedVersion: 0 }, tx);
    assert.equal((await processEmailOutbox({ db: tx, sender: new RecordingEmailSender(), appUrl })).sent, 2, 'the two assignments to ben are emailed');
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await backend.listThreads(identity(ana), { limit: 1, cursor }, tx);
      seen.push(...page.items.map((item) => `${item.subjectKind}:${item.subjectId}`));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, [`observation:${obsOpen}`, `observation:${obsApproved}`, `reconciliation_exception:${exceptionId}`].sort(), 'every thread exactly once, in key order');
    assert.equal((await backend.listThreads(identity(dev, ['reviewer'], { entitlements: { workspaceIds: [workspaceId], fundIds: ['fund-b'], documentIds: [documentId], sourceDocumentAccessAllowed: true } }), { limit: 10 }, tx)).items.length, 0, 'a reviewer of another fund sees none of these threads');
    const listed = (await backend.listThreads(identity(ana), { limit: 10 }, tx)).items.find((item) => item.subjectId === obsOpen);
    assert.deepEqual([listed.assignee.displayName, listed.assignee.isMe, listed.commentCount, listed.version], ['ana@example.com', true, 2, 2]);

    // Open assignments for the Overview: decided work drops out; blocking exceptions come first.
    const bensWork = await backend.assignedToMe(identity(ben, ['admin']), tx);
    assert.deepEqual(bensWork.map((item) => [item.subjectKind, item.severity, item.subjectId]), [['reconciliation_exception', 'blocking', exceptionId]], 'the approved observation is not open, and obsOpen is now ana\'s');
    assert.equal(bensWork[0].snapshotId, snapshotId);
    assert.equal(bensWork[0].title, 'Competing revenue values');
    const anasWork = await backend.assignedToMe(identity(ana), tx);
    assert.deepEqual(anasWork.map((item) => [item.subjectKind, item.subjectId, item.snapshotId]), [['observation', obsOpen, snapshotId]]);
    assert.match(anasWork[0].detail, /Q2 2026 · Assigned to you for review\./);
    await tx.execute(`update corvis_consolidated.reconciliation_exception set status='resolved', resolved_by='ops', resolved_at=now(), version=version+1 where tenant_id=$1 and exception_id=$2`, [tenantId, exceptionId]);
    assert.deepEqual(await backend.assignedToMe(identity(ben, ['admin']), tx), [], 'a resolved exception is no longer attention');

    // Audit: the application's audit event round-trips through the real audit table, with identifiers and counts only.
    const audit = new PostgresOperationsRepository(tx);
    await audit.audit(reviewDiscussionAuditEvent(identity(ana), 'corr-1', 'review_item.comment', subject('observation', obsOpen), { fundId: 'fund-a', commentId: first.comment.commentId, mentionedUserIds: [ben.userId], commentLength: text.length }));
    const stored = await tx.query(`select action,target_type,target_id,metadata from corvis_control.audit_event where tenant_id=$1 and target_type='review_item'`, [tenantId]);
    assert.deepEqual([stored[0].action, stored[0].target_type, stored[0].target_id], ['review_item.comment', 'review_item', `observation:${obsOpen}`]);
    assert.ok(!JSON.stringify(stored[0].metadata).includes('revenue looks too high'));
    assert.equal(commentFingerprint(subject('observation', obsOpen), command).length, 64);

    // Send-time eligibility and preferences: the same F2 outbox rules as every other notice.
    await backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: ben.userId, expectedVersion: 2 }, tx);
    await tx.execute(`update corvis_control.membership set status='revoked' where tenant_id=$1 and user_id=$2`, [tenantId, ben.userId]);
    assert.equal((await processEmailOutbox({ db: tx, sender: new RecordingEmailSender(), appUrl })).suppressed, 1);
    const suppressed = await tx.query(`select suppression_reason from corvis_control.email_outbox where tenant_id=$1 and dedupe_key=$2`, [tenantId, `review_discussion:assigned:observation:${obsOpen}:3`]);
    assert.equal(suppressed[0].suppression_reason, 'not_eligible', 'someone who lost review access in the meantime is not emailed');
    await tx.execute(`update corvis_control.membership set status='active' where tenant_id=$1 and user_id=$2`, [tenantId, ben.userId]);
    await updateNotificationPreferences(identity(ben), { categories: [{ id: 'review_discussion', enabled: false, delivery: 'immediate' }] }, { db: tx, sender });
    await backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: ana.userId, expectedVersion: 3 }, tx);
    await backend.assign(identity(ana), subject('observation', obsOpen), { assigneeUserId: ben.userId, expectedVersion: 4 }, tx);
    assert.equal((await processEmailOutbox({ db: tx, sender: new RecordingEmailSender(), appUrl })).suppressed, 1);
    const optedOut = await tx.query(`select suppression_reason from corvis_control.email_outbox where tenant_id=$1 and dedupe_key=$2`, [tenantId, `review_discussion:assigned:observation:${obsOpen}:5`]);
    assert.equal(optedOut[0].suppression_reason, 'opted_out');
    assert.equal((await backend.getThread(identity(ana), subject('observation', obsOpen), tx)).assignee.displayName, 'ben@example.com', 'the assignment itself is independent of email');

    // Dual control: a comment is not a review decision. One approval is recorded by the existing review path (here its
    // table), discussion by the other reviewer changes neither the approval count nor any decision.
    await tx.execute(`insert into corvis_facts.review_event(tenant_id,observation_id,actor_subject,decision,reason_code,observation_version) values($1,$2,$3,'approve','reviewer_verified',1)`, [tenantId, obsOpen, ana.subject]);
    const approvals = () => tx.query(`select approved_reviewer_count::int as n from corvis_serving.observations where tenant_id=$1 and observation_id=$2`, [tenantId, obsOpen]).then((rows) => rows[0].n);
    assert.equal(await approvals(), 1);
    await backend.comment(identity(ben), subject('observation', obsOpen), { idempotencyKey: 'dual-1', body: 'I approve this value too.', mentionUserIds: [ana.userId] }, tx);
    await backend.comment(identity(ben), subject('observation', obsOpen), { idempotencyKey: 'dual-2', body: 'Second reviewer here: approved.', mentionUserIds: [] }, tx);
    await backend.assign(identity(ben), subject('observation', obsOpen), { assigneeUserId: ana.userId, expectedVersion: 5 }, tx);
    assert.equal(await approvals(), 1, 'comments and assignment never count as a second approval');

    const after = await counts(tx);
    assert.deepEqual({ ...after, review_events: before.review_events + 1 }, { ...before, review_events: before.review_events + 1 }, 'discussion changed no observation, decision, resolution, publication or event; the one review event is the approval inserted above');
    assert.equal(after.review_events, before.review_events + 1);

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('REVIEW_ITEM_DISCUSSION_PASS');
} finally {
  await db.close?.();
}
