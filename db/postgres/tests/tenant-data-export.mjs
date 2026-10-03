// Real-Postgres acceptance for the full tenant export (F10, #266), through the application code: the Postgres backend in
// lib/server/tenant-export.ts and the build worker in lib/server/tenant-export-worker.ts drive the SQL of migration 084
// inside one transaction that is always rolled back. Covers what the pure-SQL test (tenant-data-export.sql) cannot:
// that the worker's data queries run against the real schema, that contractual data rights decide what the archive
// holds, that the archive and its checksum manifest verify, that download links are single-use and bound, and that a
// rights change after the build blocks the download. Run after the full migration chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/tenant-data-export.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { NativePostgresSqlApi } from '../../../lib/server/postgres-native.ts';

// lib/server/data-governance.ts reaches the Next.js "@/..." alias through http.ts.
register(new URL('../../../lib/server/test-support/alias-loader.mjs', import.meta.url), import.meta.url);
const { PostgresTenantExportBackend } = await import('../../../lib/server/tenant-export.ts');
const { processApprovedTenantExports } = await import('../../../lib/server/tenant-export-worker.ts');
const { readStoredZip } = await import('../../../lib/server/test-support/zip-reader.ts');

const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');
process.env.CORVIS_OBJECT_STORE_BUCKET = 'ci-bucket';

const id = (n) => `f1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1);
const workspaceId = id(2);
const admin1 = { userId: id(11), subject: 'admin-one' };
const admin2 = { userId: id(12), subject: 'admin-two' };
const analyst = { userId: id(13), subject: 'analyst-one' };
const docA = id(21); // redistributable
const docB = id(22); // no rights row: must be left out
const versionOf = (docId) => id(Number(docId.slice(-2)) + 40 + 100);
const referenceOf = (docId) => id(Number(docId.slice(-2)) + 60 + 100);
const sha = (value) => createHash('sha256').update(value).digest('hex');

function identity(person, isTenantAdmin) {
  return {
    subject: person.subject, tenantId, workspaceId, roles: [isTenantAdmin ? 'admin' : 'analyst'], authMethod: 'oidc', sessionId: `session-${person.subject}`,
    isTenantAdmin, entitlements: { workspaceIds: [workspaceId], fundIds: [], documentIds: [], sourceDocumentAccessAllowed: false },
  };
}

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
const code = (error) => error?.applicationError ?? error?.code;

class MemoryObjects {
  bucket = 'ci-bucket';
  objects = new Map();
  async putObject(key, bytes, contentType) { this.objects.set(key, { bytes: Buffer.from(bytes), contentType }); }
  async deleteObject(key) { this.objects.delete(key); }
  async getObjectStream(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: new Response(object.bytes).body, contentType: object.contentType, contentLength: String(object.bytes.length) };
  }
}

const ROLLBACK = Symbol('rollback');
const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    const objects = new MemoryObjects();
    const backend = new PostgresTenantExportBackend(() => tx, () => objects);

    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'f10-ci','F10 CI')`, [tenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Workspace')`, [workspaceId, tenantId]);
    for (const person of [admin1, admin2, analyst]) {
      await tx.execute(`insert into corvis_control.identity_subject (tenant_id,user_id,auth_method,subject) values ($1,$2,'oidc',$3)`, [tenantId, person.userId, person.subject]);
    }
    await tx.execute(`insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name) values ($1,$2,$3,'tenant_admin'),($1,$2,$4,'tenant_admin'),($1,$2,$5,'analyst')`,
      [tenantId, workspaceId, admin1.userId, admin2.userId, analyst.userId]);

    // Two funds with published data from two documents; only fund-a / doc A carry contractual redistribution rights.
    for (const [docId, name] of [[docA, 'Fund A Q2.pdf'], [docB, 'Fund B Q2.pdf']]) {
      await tx.execute(`insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by) values ($1,$2,$3,'application/pdf','published','ci')`, [tenantId, docId, name]);
      await tx.execute(`insert into corvis_source.document_artifact_version (tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes,sha256)
        values ($1,$2,$3,$5,'gs://b/u',2048,$4)`, [tenantId, versionOf(docId), docId, 'ab'.repeat(32), `ing-${docId}`]);
      await tx.execute(`insert into corvis_source.source_reference (tenant_id,source_reference_id,document_id,document_artifact_version_id) values ($1,$2,$3,$4)`,
        [tenantId, referenceOf(docId), docId, versionOf(docId)]);
    }
    const seedFund = async (fundId, docId, obsId, factId, snapshotId, value) => {
      await tx.execute(`insert into corvis_facts.observation (tenant_id,observation_id,fund_id,metric_code,value_number,review_state,source_reference_id,schema_version)
        values ($1,$2,$3,'revenue',$4,'approved',$5,'v1')`, [tenantId, obsId, fundId, value, referenceOf(docId)]);
      await tx.execute(`insert into corvis_consolidated.consolidated_fact (tenant_id,consolidated_fact_id,fund_id,subject_type,subject_id,metric_code,value,source_observation_ids,consolidation_rule_version)
        values ($1,$2,$3,'fund',$3,'revenue','{"semanticDimensions":{"subjectLevel":"fund"}}'::jsonb,array[$4::uuid],'r1')`, [tenantId, factId, fundId, obsId]);
      await tx.execute(`insert into corvis_consolidated.fund_period_snapshot (tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,schema_version,taxonomy_version,published_at)
        values ($1,$2,$3,'2026-Q2',1,'published',array[$4::uuid],'1','1',now())`, [tenantId, snapshotId, fundId, factId]);
    };
    await seedFund('fund-a', docA, id(31), id(41), id(51), '125.5000000000');
    await seedFund('fund-b', docB, id(32), id(42), id(52), '999.0000000000');
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed) values
      ($1,'workspace',$2,true,true),($1,'fund','fund-a',true,true),($1,'document',$3,true,true)`, [tenantId, workspaceId, docA]);

    const before = await tx.query(`select (select count(*) from corvis_serving.export_job)::int as jobs, (select count(*) from corvis_control.outbox_event)::int as outbox`);

    // Request: only an Organization Admin; the open request is unique.
    const mine = await backend.request(identity(admin1, true), { reason: 'Records review at contract end' }, tx);
    assert.equal(mine.status, 'pending_approval');
    assert.equal(mine.requestedByMe, true);
    assert.deepEqual(mine.actions, { canApprove: false, canReject: false, canCancel: true, canDownload: false });
    assert.equal(code(await refused(tx, () => backend.request(identity(analyst, true), { reason: 'Records review' }, tx))), 'tenant export requires an active organization admin', 'an analyst claiming admin is refused by SQL');
    assert.equal(code(await refused(tx, () => backend.request(identity(admin2, true), { reason: 'Second request' }, tx))), 'tenant export already in progress');

    // Four eyes, enforced in SQL: the requester cannot approve or reject; nothing is built.
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin1, true), mine.requestId, { action: 'approve' }, tx))), 'tenant export requires an independent approver');
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin1, true), mine.requestId, { action: 'reject', note: 'No' }, tx))), 'tenant export requires an independent approver');
    assert.equal(code(await refused(tx, () => backend.decide(identity(analyst, true), mine.requestId, { action: 'approve' }, tx))), 'tenant export requires an active organization admin');
    assert.equal((await processApprovedTenantExports(5, { store: tx, objectStore: objects })).processed, 0, 'nothing is built before approval');

    // Approval by the second admin queues the build; the worker builds it through the governed delivery tick.
    const approved = await backend.decide(identity(admin2, true), mine.requestId, { action: 'approve', expectedStatus: 'pending_approval', note: 'Approved.' }, tx);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decidedBy, 'admin-two');
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin1, true), mine.requestId, { action: 'cancel', expectedStatus: 'pending_approval' }, tx))), 'tenant export status changed');
    assert.deepEqual(await processApprovedTenantExports(5, { store: tx, objectStore: objects }), { processed: 1, failed: 0 });
    assert.equal(objects.objects.size, 1);

    const complete = await backend.get(identity(admin2, true), mine.requestId, tx);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.actions.canDownload, true);
    const [[key, stored]] = [...objects.objects];
    assert.ok(key.startsWith(`exports/${tenantId}/`), 'stored under the shared exports prefix and lifecycle');
    assert.equal(complete.artifact.checksumSha256, sha(stored.bytes));
    assert.equal(complete.artifact.sizeBytes, stored.bytes.length);
    assert.deepEqual(complete.history.map((event) => [event.eventType, event.actor]), [
      ['requested', 'admin-one'], ['approved', 'admin-two'], ['build_started', 'system:tenant-export'], ['build_completed', 'system:tenant-export'],
    ]);
    assert.equal('artifact' in complete.artifact.manifest, false, 'the internal artifact scope is not sent to clients');

    // The archive: a well-formed zip whose manifest verifies every file, holding only what the rights allow.
    const entries = readStoredZip(stored.bytes);
    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
    for (const file of manifest.files) assert.equal(file.sha256, sha(entries.get(file.path)), `${file.path} verifies against the manifest`);
    const observations = entries.get('published-data/observations.csv').toString('utf8');
    assert.match(observations, /fund-a/);
    assert.match(observations, /125\.5000000000/, 'numeric(38,10) is exact');
    assert.doesNotMatch(observations, /fund-b|999/, 'a fund without a redistribution right is never exported');
    const inventory = entries.get('source-documents/inventory.csv').toString('utf8');
    assert.match(inventory, /Fund A Q2\.pdf/);
    assert.doesNotMatch(inventory, /Fund B Q2\.pdf/, 'a document without a redistribution right is not even listed');
    assert.deepEqual(manifest.dataRights.funds, { included: 1, excluded: 1 });
    assert.deepEqual(manifest.dataRights.documents, { included: 1, excluded: 1 });
    assert.equal(manifest.files.find((file) => file.path === 'published-data/observations.csv').rowCount, 1);
    const auditCsv = entries.get('access-audit/access-audit.csv').toString('utf8');
    assert.match(auditCsv, /data_export\.build_started/, 'the access audit includes the export steps themselves');

    // Download: an expiring, single-use link bound to the admin it was issued to.
    const issued = await backend.issueDownload(identity(admin1, true), mine.requestId, tx);
    const token = new URL(issued.download.downloadUrl, 'https://corvis.test').searchParams.get('grant');
    const grants = await tx.query('select subject,token_sha256,consumed_at is null as unused from corvis_control.tenant_export_download_grant where request_id=$1', [mine.requestId]);
    assert.deepEqual(grants.map((row) => [row.subject, row.token_sha256, row.unused]), [['admin-one', sha(token), true]], 'only the hash of the token is stored');
    assert.equal(await backend.redeemDownload(identity(admin2, true), mine.requestId, token, tx), null, 'another admin cannot redeem it');
    const redeemed = await backend.redeemDownload(identity(admin1, true), mine.requestId, token, tx);
    assert.equal(redeemed.checksumSha256, complete.artifact.checksumSha256);
    assert.equal(await backend.redeemDownload(identity(admin1, true), mine.requestId, token, tx), null, 'a link works once');
    const stream = await backend.openArtifact(identity(admin1, true), mine.requestId, token, redeemed, tx);
    assert.equal(sha(Buffer.from(await new Response(stream.body).arrayBuffer())), complete.artifact.checksumSha256);
    // A storage fault that delivered nothing gives the link back.
    objects.objects.clear();
    assert.equal(await backend.openArtifact(identity(admin1, true), mine.requestId, token, redeemed, tx), null);
    assert.equal((await tx.query('select consumed_at from corvis_control.tenant_export_download_grant where request_id=$1', [mine.requestId]))[0].consumed_at, null);
    objects.objects.set(key, stored);

    // An expired link redeems nothing.
    const stale = await backend.issueDownload(identity(admin1, true), mine.requestId, tx);
    await tx.execute(`update corvis_control.tenant_export_download_grant set expires_at = now() - interval '1 second' where token_sha256=$1`, [sha(new URL(stale.download.downloadUrl, 'https://corvis.test').searchParams.get('grant'))]);
    assert.equal(await backend.redeemDownload(identity(admin1, true), mine.requestId, new URL(stale.download.downloadUrl, 'https://corvis.test').searchParams.get('grant'), tx), null);

    // Contractual rights are re-checked at download: once the document's right lapses, the archive cannot be fetched.
    const lastLink = await backend.issueDownload(identity(admin1, true), mine.requestId, tx);
    await tx.execute(`update corvis_control.data_rights set redistribution_allowed=false where tenant_id=$1 and resource_type='document' and resource_id=$2`, [tenantId, docA]);
    assert.equal((await refused(tx, () => backend.redeemDownload(identity(admin1, true), mine.requestId, new URL(lastLink.download.downloadUrl, 'https://corvis.test').searchParams.get('grant'), tx))).code, 'data_export_rights_changed');
    assert.equal((await refused(tx, () => backend.issueDownload(identity(admin1, true), mine.requestId, tx))).code, 'data_export_rights_changed', 'no new link either');

    // Listing, and the tenant's audit trail: every system step is audited, human steps are audited by the service layer.
    assert.equal((await backend.list(identity(admin1, true), tx)).length, 1);
    const audit = await tx.query(`select action, actor_subject from corvis_control.audit_event where target_type='tenant_export_request' order by occurred_at, audit_event_id`);
    assert.deepEqual(audit.map((row) => row.action), ['data_export.build_started', 'data_export.build_completed']);
    assert.ok(audit.every((row) => row.actor_subject === 'system:tenant-export'));

    // Nothing touched the per-user export queue or the outbox.
    const after = await tx.query(`select (select count(*) from corvis_serving.export_job)::int as jobs, (select count(*) from corvis_control.outbox_event)::int as outbox`);
    assert.deepEqual(after[0], before[0]);

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('tenant data export: ok');
} finally {
  await db.close?.();
}
