// Real-Postgres acceptance for customer deletion requests (F10e, #325), through the application code: the customer backend in
// src/modules/governance/server/lifecycle/customer-deletion.ts, the retention view in src/modules/governance/server/lifecycle/data-retention.ts and the unchanged operator flow in
// src/modules/governance/server/lifecycle/data-lifecycle.ts drive the schema inside one transaction that is always rolled back. Covers what the pure-SQL
// test (customer-deletion-requests.sql) cannot: that the application's statements run against the real schema, that the
// customer read never returns what only operators may see, and that the operator flow cannot execute a customer's request
// before a different Organization Admin approved it, and still blocks it under a legal hold afterwards. Run after the full
// migration chain on a disposable database:
//   CORVIS_DATABASE_DSN=postgres://... node db/postgres/tests/customer-deletion-requests.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { NativePostgresSqlApi } from '../../../src/platform/database/postgres-native.ts';

// src/modules/governance/server/lifecycle/data-governance.ts reaches the Next.js "@/..." alias through http.ts.
register(new URL('../../../src/test-support/alias-loader.mjs', import.meta.url), import.meta.url);
const { PostgresCustomerDeletionBackend, createCustomerDeletionService } = await import('../../../src/modules/governance/server/lifecycle/customer-deletion.ts');
const { PostgresRetentionBackend } = await import('../../../src/modules/governance/server/lifecycle/data-retention.ts');
const { executeDeletionRequest, LegalHoldError, DeletionExecutionError } = await import('../../../src/modules/governance/server/lifecycle/data-lifecycle.ts');
const { createDeletionRequest } = await import('../../../src/platform/data/operations.ts');
const { adminSqlErrorClassification } = await import('../../../src/platform/database/sql-application-errors.ts');

const dsn = process.env.CORVIS_DATABASE_DSN;
assert.ok(dsn, 'CORVIS_DATABASE_DSN is required');
process.env.CORVIS_DATA_LIFECYCLE_ENDPOINT = 'https://lifecycle.invalid';

const id = (n) => `f1100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1);
const workspaceId = id(2);
const admin1 = { userId: id(11), subject: 'admin-one' };
const admin2 = { userId: id(12), subject: 'admin-two' };
const analyst = { userId: id(13), subject: 'analyst-one' };

function identity(person, isTenantAdmin = true) {
  return {
    subject: person.subject, tenantId, workspaceId, roles: [isTenantAdmin ? 'admin' : 'analyst'], authMethod: 'oidc', sessionId: `session-${person.subject}`,
    isTenantAdmin, entitlements: { workspaceIds: [workspaceId], fundIds: [], documentIds: [], sourceDocumentAccessAllowed: false },
  };
}
const operator = { subject: 'ops-executor', tenantId, workspaceId, roles: ['admin'], authMethod: 'oidc', sessionId: 'ops', entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } };

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
// The stable public code: a typed refusal carries its own, a SQL business error maps through the shared allowlist.
// A refusal raised by the application (not by a failing statement) leaves the transaction usable and keeps what the flow
// wrote before refusing (a blocked request is recorded as blocked), so it must not run under a rolled-back savepoint.
async function thrown(run) {
  try { await run(); } catch (error) { return error; }
  return assert.fail('expected the command to be refused');
}
const code = (error) => error?.name === 'DataGovernanceError' ? error.code : adminSqlErrorClassification(error)?.code;

const ROLLBACK = Symbol('rollback');
const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    const backend = new PostgresCustomerDeletionBackend();
    const retention = new PostgresRetentionBackend(() => tx);
    const service = createCustomerDeletionService(backend);
    const view = async (who) => (await retention.view(who, tx)).deletionRequests;

    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f10e-ci','F10e CI')`, [tenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Workspace')`, [workspaceId, tenantId]);
    for (const person of [admin1, admin2, analyst]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenantId, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'tenant_admin'),($1,$2,$4,'tenant_admin'),($1,$2,$5,'analyst')`,
      [tenantId, workspaceId, admin1.userId, admin2.userId, analyst.userId]);
    await tx.execute(`insert into corvis_control.retention_policy (tenant_id,data_class,retention_days,policy_version,effective_from)
      values ($1,'financials',2555,'2026-01',now() - interval '30 days'), ($1,'audit',1825,'2026-01',now() - interval '30 days'), ($1,'source_documents',3650,'2026-01',now() - interval '30 days')`, [tenantId]);

    // Operations' own request is listed, without anything only operations may see.
    const opId = await createDeletionRequest(operator, { dataClasses: ['audit'] }, 'INTERNAL: churn risk, do not tell the customer', tx);
    await tx.execute(`update corvis_control.deletion_request set last_error = 'adapter exploded', blocked_reason = 'secret reason' where deletion_request_id = $1`, [opId]);
    const listed = await view(identity(admin1));
    assert.equal(listed.length, 1);
    assert.deepEqual([listed[0].origin, listed[0].status, listed[0].scopeLabel, listed[0].legalHoldBlocks, listed[0].requestedByMe], ['corvis', 'requested', 'Audit records', false, false]);
    assert.deepEqual([listed[0].reason, listed[0].requestedBy, listed[0].decidedBy, listed[0].decisionNote, listed[0].approvalExpiresAt], [null, null, null, null, null]);
    for (const secret of ['INTERNAL', 'churn', 'ops-executor', 'adapter exploded', 'secret reason']) assert.equal(JSON.stringify(listed).includes(secret), false, `${secret} is never returned`);
    // ...and never decided by a customer.
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin2), opId, { action: 'approve' }, tx))), 'deletion_request_not_found');

    // Only an Organization Admin may ask, and only for classes with a policy; a hold refuses it.
    assert.equal(code(await refused(tx, () => service.request(identity(analyst, false), { dataClasses: ['financials'], reason: 'Closing' }, 'c'))), 'tenant_admin_required');
    assert.equal(code(await refused(tx, () => backend.request(identity(analyst), { dataClasses: ['financials'], reason: 'Closing the account' }, tx))), 'tenant_admin_required', 'and SQL checks it again');
    assert.equal(code(await refused(tx, () => backend.request(identity(admin1), { dataClasses: ['nothing'], reason: 'Closing the account' }, tx))), 'invalid_data_classes');
    await tx.execute(`insert into corvis_control.legal_hold (tenant_id,data_class,scope,matter_reference,placed_by) values ($1,'source_documents','{}','MATTER-1','ops')`, [tenantId]);
    assert.equal(code(await refused(tx, () => backend.request(identity(admin1), { dataClasses: ['financials', 'source_documents'], reason: 'Closing the account' }, tx))), 'deletion_blocked_by_legal_hold');

    // A request, and the four-eyes rule through the application.
    const mine = await backend.request(identity(admin1), { dataClasses: ['financials', 'audit'], reason: 'Closing the account' }, tx);
    assert.deepEqual([mine.status, mine.origin, mine.requestedByMe, mine.reason, mine.dataClasses, mine.scopeLabel, mine.legalHoldBlocks], ['pending_approval', 'customer', true, 'Closing the account', ['audit', 'financials'], 'Audit records, financial data', false]);
    assert.deepEqual(mine.actions, { canApprove: false, canReject: false, canCancel: true });
    const theirs = (await view(identity(admin2))).find((item) => item.requestId === mine.requestId);
    assert.deepEqual([theirs.requestedByMe, theirs.requestedBy, theirs.actions], [false, 'admin-one', { canApprove: true, canReject: true, canCancel: false }]);
    assert.equal(code(await refused(tx, () => backend.request(identity(admin2), { dataClasses: ['audit'], reason: 'A second one' }, tx))), 'deletion_request_already_pending');
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin1), mine.requestId, { action: 'approve' }, tx))), 'deletion_independent_approver_required');
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin2), mine.requestId, { action: 'cancel' }, tx))), 'deletion_cancel_requester_only');
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin2), mine.requestId, { action: 'reject', note: '  ' }, tx))), 'invalid_note');
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin2), mine.requestId, { action: 'approve', expectedStatus: 'pending_approval' }, tx).then(() => backend.decide(identity(admin2), mine.requestId, { action: 'approve', expectedStatus: 'pending_approval' }, tx)))), 'deletion_status_changed', 'approving twice');

    // The notice went to the other admin only, in words.
    const notices = await tx.query(`select recipient_user_id::text as user_id, template_params::text as params, status from corvis_control.email_outbox where tenant_id = $1 and category = 'deletion_request_approval'`, [tenantId]);
    assert.deepEqual(notices.map((row) => [row.user_id, row.params, row.status]), [[admin2.userId, '{"event": "approval_needed"}', 'queued']]);
    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  await assert.rejects(db.transaction(async (tx) => {
    const backend = new PostgresCustomerDeletionBackend();
    const retention = new PostgresRetentionBackend(() => tx);
    const view = async (who) => (await retention.view(who, tx)).deletionRequests;
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f10e-ci','F10e CI')`, [tenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Workspace')`, [workspaceId, tenantId]);
    for (const person of [admin1, admin2]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenantId, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'tenant_admin'),($1,$2,$4,'tenant_admin')`, [tenantId, workspaceId, admin1.userId, admin2.userId]);
    await tx.execute(`insert into corvis_control.retention_policy (tenant_id,data_class,retention_days,policy_version,effective_from) values ($1,'financials',2555,'2026-01',now() - interval '30 days')`, [tenantId]);

    // The operator flow cannot run a customer's request before the second admin approved it...
    const mine = await backend.request(identity(admin1), { dataClasses: ['financials'], reason: 'Closing the account' }, tx);
    const adapterCalls = [];
    const fetchImpl = async (url, init) => { adapterCalls.push([url, JSON.parse(init.body)]); return new Response(JSON.stringify({ evidence: { deleted: true } }), { status: 200 }); };
    const early = await thrown(() => executeDeletionRequest(operator, mine.requestId, { db: tx, fetchImpl }));
    assert.ok(early instanceof DeletionExecutionError && early.code === 'deletion_request_not_executable', 'a pending customer request is not executable');
    assert.equal(adapterCalls.length, 0, 'nothing was sent to the lifecycle adapter');
    // ...nor can the table be told it was approved by its own requester.
    await tx.execute('savepoint probe');
    await assert.rejects(tx.execute(`update corvis_control.deletion_request set state = 'approved', customer_decided_by_subject = 'admin-one', customer_decided_by_user_id = $2, customer_decided_at = now() where deletion_request_id = $1`, [mine.requestId, admin2.userId]));
    await tx.execute('rollback to savepoint probe');

    // A hold placed after the request stops its approval; releasing it lets a different admin approve.
    const hold = (await tx.query(`insert into corvis_control.legal_hold (tenant_id,data_class,scope,matter_reference,placed_by) values ($1,'financials','{}','MATTER-2','ops') returning legal_hold_id::text as id`, [tenantId]))[0].id;
    assert.equal((await view(identity(admin2))).find((item) => item.requestId === mine.requestId).legalHoldBlocks, true, 'the list says a hold applies');
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin2), mine.requestId, { action: 'approve' }, tx))), 'deletion_blocked_by_legal_hold');
    await tx.execute(`update corvis_control.legal_hold set released_by = 'ops', released_at = now() where legal_hold_id = $1::uuid`, [hold]);
    const approved = await backend.decide(identity(admin2), mine.requestId, { action: 'approve', note: 'Agreed', expectedStatus: 'pending_approval' }, tx);
    assert.deepEqual([approved.status, approved.decidedBy, approved.decisionNote, approved.actions], ['approved', 'admin-two', 'Agreed', { canApprove: false, canReject: false, canCancel: false }]);
    assert.ok(approved.decidedAt);

    // A hold that arrives after the approval blocks the operator flow, and the customer sees why.
    const second = (await tx.query(`insert into corvis_control.legal_hold (tenant_id,data_class,scope,matter_reference,placed_by) values ($1,null,'{}','MATTER-3','ops') returning legal_hold_id::text as id`, [tenantId]))[0].id;
    const blocked = await thrown(() => executeDeletionRequest(operator, mine.requestId, { db: tx, fetchImpl }));
    assert.ok(blocked instanceof LegalHoldError, 'the operator flow still refuses data under a hold');
    const shown = (await view(identity(admin1))).find((item) => item.requestId === mine.requestId);
    assert.deepEqual([shown.status, shown.legalHoldBlocks], ['blocked', true]);
    assert.equal(adapterCalls.length, 0);
    await tx.execute(`update corvis_control.legal_hold set released_by = 'ops', released_at = now() where legal_hold_id = $1::uuid`, [second]);

    // Released, the same approved request executes through the unchanged flow, and the customer sees it completed with its dates.
    const executed = await executeDeletionRequest(operator, mine.requestId, { db: tx, fetchImpl });
    assert.deepEqual([executed.state, executed.replayed], ['completed', false]);
    assert.equal(adapterCalls.length, 1);
    assert.deepEqual(adapterCalls[0][1].scope.dataClasses, ['financials']);
    const done = (await view(identity(admin1))).find((item) => item.requestId === mine.requestId);
    assert.deepEqual([done.status, done.legalHoldBlocks, done.decidedBy], ['completed', false, 'admin-two']);
    assert.ok(done.decidedAt && done.executedAt, 'the decided and executed dates are shown');
    assert.equal((await tx.query(`select approved_by from corvis_control.deletion_request where deletion_request_id = $1::uuid`, [mine.requestId]))[0].approved_by, 'admin-two', 'the executor never overwrites the customer approver');
    assert.equal(JSON.stringify(done).includes('ops-executor'), false, 'the operator who ran it is not shown');
    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('customer deletion requests: ok');
} finally {
  await db.close?.();
}
