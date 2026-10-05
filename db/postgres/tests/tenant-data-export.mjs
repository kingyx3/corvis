// Real-Postgres acceptance for the full tenant export (F10, #266), through the application code: the Postgres backend in
// src/modules/delivery/server/tenant-export.ts and the build worker in src/modules/delivery/server/tenant-export-worker.ts drive the SQL of migration 084
// inside one transaction that is always rolled back. Covers what the pure-SQL test (tenant-data-export.sql) cannot:
// that the worker's data queries run against the real schema, that contractual data rights decide what the archive
// holds, that the archive and its checksum manifest verify, that download links are single-use and bound, and that a
// rights change after the build blocks the download. Migration 094 (F10b, F10c) adds: the source document files in the
// archive (only for documents the tenant may redistribute AND holds source-file access for, copied through a fake object
// store, their checksums matching the manifest, a document without access counted and never listed), data sets split into
// parts read by keyset (with rows that share one timestamp), the archive streamed rather than buffered, the progress report
// of a running build, and a download blocked when source-file access (not only redistribution) changes after the build.
// Migration 089 (F10d, F10f) adds: the approval and outcome notices
// dispatched through the outbox worker (send-time eligibility, opt-out, no reason or note in any email), the keyset-paged
// request list, the sweep of expired artifacts and grants, and the operator view of failed builds. Run after the full
// migration chain on a disposable database:
//   CORVIS_POSTGRES_DSN=postgres://... node db/postgres/tests/tenant-data-export.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { NativePostgresSqlApi } from '../../../src/platform/database/postgres-native.ts';
import { RecordingEmailSender } from '../../../src/modules/notifications/adapters/recording-email-sender.ts';

// src/modules/governance/server/data-governance.ts reaches the Next.js "@/..." alias through http.ts.
register(new URL('../../../src/test-support/alias-loader.mjs', import.meta.url), import.meta.url);
const { PostgresTenantExportBackend } = await import('../../../src/modules/delivery/server/tenant-export.ts');
const { processApprovedTenantExports } = await import('../../../src/modules/delivery/server/tenant-export-worker.ts');
const { processEmailOutbox } = await import('../../../src/modules/notifications/server/notifications.ts');
const { sweepTenantExports } = await import('../../../src/modules/delivery/server/tenant-export-sweep.ts');
const { listTenantExportBuildIssues } = await import('../../../src/modules/delivery/server/tenant-export-operations.ts');
const { readStoredZip } = await import('../../../src/test-support/zip-reader.ts');

const dsn = process.env.CORVIS_POSTGRES_DSN;
assert.ok(dsn, 'CORVIS_POSTGRES_DSN is required');
process.env.CORVIS_OBJECT_STORE_BUCKET = 'ci-bucket';

const id = (n) => `f1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1);
const workspaceId = id(2);
const admin1 = { userId: id(11), subject: 'admin-one' };
const admin2 = { userId: id(12), subject: 'admin-two' };
const analyst = { userId: id(13), subject: 'analyst-one' };
const docA = id(21); // redistributable, and source-file access is granted: its file is in the archive
const docB = id(22); // no rights row: must be left out
const docC = id(23); // redistributable, but no source-file access: listed in the inventory without its file
const fileBytes = (docId) => Buffer.from(`%PDF-1.7 ${docId} stored source document bytes`);
const sourceKey = (docId) => `tenant=${tenantId}/document=${docId}/original.pdf`;
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
  maxPiece = 0;
  pieces = 0;
  // The archive arrives as a stream of pieces (the worker never hands over a whole buffer); only the finished object is kept here to be inspected.
  async putObjectStream(key, source, contentType) {
    const parts = [];
    for await (const piece of source) { this.maxPiece = Math.max(this.maxPiece, piece.length); this.pieces += 1; parts.push(Buffer.from(piece)); }
    this.objects.set(key, { bytes: Buffer.concat(parts), contentType });
    return { sizeBytes: this.objects.get(key).bytes.length };
  }
  async deleteObject(key) { this.objects.delete(key); }
  async getObjectStream(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: new Response(object.bytes).body, contentType: object.contentType, contentLength: String(object.bytes.length) };
  }
  exports() { return [...this.objects].filter(([key]) => key.startsWith('exports/')); }
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
    for (const [docId, name] of [[docA, 'Fund A Q2.pdf'], [docB, 'Fund B Q2.pdf'], [docC, 'Fund C Q2.pdf']]) {
      await tx.execute(`insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by) values ($1,$2,$3,'application/pdf','published','ci')`, [tenantId, docId, name]);
      // A released, clean file on record, whose bytes are in the (fake) object store under the tenant's own document prefix.
      await tx.execute(`insert into corvis_source.document_artifact_version (tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes,sha256,storage_generation,malware_scan_status,quarantine_status)
        values ($1,$2,$3,$5,$6,$7,$4,'7','clean','released')`, [tenantId, versionOf(docId), docId, sha(fileBytes(docId)), `ing-${docId}`, `gs://ci-bucket/${sourceKey(docId)}`, fileBytes(docId).length]);
      objects.objects.set(sourceKey(docId), { bytes: fileBytes(docId), contentType: 'application/pdf' });
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
    // A second approved observation of fund A, from the same published fact: the archive needs more than one row to be read by keyset.
    await tx.execute(`insert into corvis_facts.observation (tenant_id,observation_id,fund_id,metric_code,value_number,review_state,source_reference_id,schema_version)
      values ($1,$2,'fund-a','ebitda',77.25,'approved',$3,'v1')`, [tenantId, id(33), referenceOf(docA)]);
    await tx.execute(`update corvis_consolidated.consolidated_fact set source_observation_ids = array[$2::uuid,$3::uuid] where tenant_id=$1 and consolidated_fact_id=$4`, [tenantId, id(31), id(33), id(41)]);
    await tx.execute(`insert into corvis_control.data_rights (tenant_id,resource_type,resource_id,client_visible,redistribution_allowed,source_document_access_allowed) values
      ($1,'workspace',$2,true,true,false),($1,'fund','fund-a',true,true,false),($1,'document',$3,true,true,true),($1,'document',$4,true,true,false)`, [tenantId, workspaceId, docA, docC]);
    // Access events that share one transaction timestamp: the keyset over the audit trail must tell them apart by id, losing and repeating none.
    for (let n = 1; n <= 4; n += 1) {
      await tx.execute(`insert into corvis_control.audit_event (tenant_id,workspace_id,actor_subject,action,target_type,target_id,outcome,correlation_id) values ($1,$2,'admin-one','access.member.role_changed','membership',$3,'success','ci')`, [tenantId, workspaceId, `member-${n}`]);
    }

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
    assert.equal(objects.exports().length, 0);

    // Approval by the second admin queues the build; the worker builds it through the governed delivery tick.
    const approved = await backend.decide(identity(admin2, true), mine.requestId, { action: 'approve', expectedStatus: 'pending_approval', note: 'Approved.' }, tx);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decidedBy, 'admin-two');
    assert.equal(code(await refused(tx, () => backend.decide(identity(admin1, true), mine.requestId, { action: 'cancel', expectedStatus: 'pending_approval' }, tx))), 'tenant export status changed');
    // Parts of one row and pages of one row, so the keyset runs across every part boundary against the real schema.
    assert.deepEqual(await processApprovedTenantExports(5, { store: tx, objectStore: objects, archive: { rowsPerFile: 1, pageRows: 1, documentPage: 1 } }), { processed: 1, failed: 0 });
    assert.equal(objects.exports().length, 1);
    assert.ok(objects.pieces > 5 && objects.maxPiece < 64 * 1024, 'the archive reached the object store as a stream of small pieces');

    const complete = await backend.get(identity(admin2, true), mine.requestId, tx);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.actions.canDownload, true);
    const [[key, stored]] = objects.exports();
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
    assert.equal([...entries.keys()].at(-1), 'manifest.json', 'the manifest is last: it lists the checksums of everything written before it');
    for (const file of manifest.files) {
      assert.equal(file.sha256, sha(entries.get(file.path)), `${file.path} verifies against the manifest`);
      assert.equal(file.sizeBytes, entries.get(file.path).length, `${file.path} size`);
    }
    assert.deepEqual(manifest.files.map((file) => file.path), [...entries.keys()].slice(0, -1), 'every file in the archive is in the manifest');
    // F10c: parts of one row each; every observation exactly once across them.
    const observationParts = manifest.files.filter((file) => file.dataset === 'observations');
    assert.deepEqual(observationParts.map((file) => [file.path, file.rowCount]), [['published-data/observations-0001.csv', 1], ['published-data/observations-0002.csv', 1]]);
    const observations = observationParts.map((file) => entries.get(file.path).toString('utf8')).join('');
    assert.match(observations, /fund-a/);
    assert.match(observations, /125\.5000000000/, 'numeric(38,10) is exact');
    assert.match(observations, /77\.2500000000/);
    assert.doesNotMatch(observations, /fund-b|999/, 'a fund without a redistribution right is never exported');
    assert.deepEqual(observationParts.flatMap((file) => entries.get(file.path).toString('utf8').split('\r\n').slice(1).filter(Boolean).map((line) => line.split(',')[0])), [id(31), id(33)], 'in order, none repeated or lost');
    const inventoryParts = manifest.files.filter((file) => file.dataset === 'source_inventory');
    assert.equal(inventoryParts.length, 2, 'two entitled documents, one per part');
    const inventory = inventoryParts.map((file) => entries.get(file.path).toString('utf8')).join('');
    assert.match(inventory, /Fund A Q2\.pdf/);
    assert.match(inventory, /Fund C Q2\.pdf/, 'a redistributable document without source-file access is still listed');
    assert.doesNotMatch(inventory, /Fund B Q2\.pdf/, 'a document without a redistribution right is not even listed');
    assert.deepEqual(manifest.dataRights.funds, { included: 1, excluded: 1 });
    assert.deepEqual(manifest.dataRights.documents, { included: 2, excluded: 1 });
    // F10b: the source file of the one document the tenant may redistribute and has source-file access for, and no other.
    const sourceFiles = manifest.files.filter((file) => file.dataset === 'source_document');
    assert.deepEqual(sourceFiles.map((file) => [file.path, file.documentId]), [[`source-documents/files/${docA}/Fund A Q2.pdf`, docA]]);
    assert.ok(entries.get(sourceFiles[0].path).equals(fileBytes(docA)), 'the stored bytes, exactly');
    assert.equal(sourceFiles[0].sha256, sha(fileBytes(docA)));
    assert.deepEqual(manifest.sourceFiles, { included: 1, excluded: 1, totalBytes: fileBytes(docA).length }, 'a document left out is a count');
    assert.equal(JSON.stringify(manifest).includes(docB) || JSON.stringify(manifest).includes(docC), false, 'left-out documents are never named in the manifest');
    assert.equal([...entries.keys()].some((name) => name.includes(docB) || name.includes(docC)), false);
    assert.equal([...entries.values()].some((bytes) => bytes.equals(fileBytes(docB)) || bytes.equals(fileBytes(docC))), false, 'no left-out file is anywhere in the archive');
    assert.match(manifest.notIncluded[0].reason, /^1 document is listed in the inventory without its file/);
    assert.equal(complete.artifact.manifest.files.some((file) => file.dataset === 'source_document'), false, 'the API copy of the manifest leaves out the individual source files');
    assert.equal(complete.artifact.manifest.fileCount, manifest.fileCount);
    const auditParts = manifest.files.filter((file) => file.dataset === 'access_audit');
    const auditCsv = auditParts.map((file) => entries.get(file.path).toString('utf8')).join('');
    assert.match(auditCsv, /data_export\.build_started/, 'the access audit includes the export steps themselves');
    // The audit trail was read by keyset in parts of one row: all four events that share one timestamp are there, once each.
    const inTrail = (await tx.query(`select count(*)::int as n from corvis_control.audit_event where tenant_id=$1 and (action like 'access.member.%' or action like 'data_export.%') and action <> 'data_export.build_completed'`, [tenantId]))[0].n;
    assert.equal(auditParts.reduce((sum, file) => sum + file.rowCount, 0), inTrail);
    assert.equal(auditParts.length, inTrail, 'one row per part');
    for (let n = 1; n <= 4; n += 1) assert.equal(auditCsv.split(`member-${n},`).length, 2, `audit event ${n} appears exactly once`);
    // The scope recorded with the archive stays inside the database: it is not even selected for the API.
    assert.equal(JSON.stringify(complete).includes('sourceDocumentIds'), false);
    const recorded = (await tx.query(`select manifest -> 'artifact' as artifact from corvis_control.tenant_export_request where request_id=$1`, [mine.requestId]))[0].artifact;
    assert.deepEqual([recorded.fundIds, recorded.documentIds, recorded.sourceDocumentIds], [['fund-a'], [docA, docC].sort(), [docA]]);

    // A download is blocked when source-file access (not only redistribution) is withdrawn after the build: the archive holds that file.
    await tx.execute(`update corvis_control.data_rights set source_document_access_allowed=false where tenant_id=$1 and resource_type='document' and resource_id=$2`, [tenantId, docA]);
    assert.equal((await refused(tx, () => backend.issueDownload(identity(admin1, true), mine.requestId, tx))).code, 'data_export_rights_changed', 'no link once source-file access is withdrawn');
    await tx.execute(`update corvis_control.data_rights set source_document_access_allowed=true where tenant_id=$1 and resource_type='document' and resource_id=$2`, [tenantId, docA]);
    // Access to a document whose file is NOT in the archive does not matter to it.
    await tx.execute(`update corvis_control.data_rights set source_document_access_allowed=true where tenant_id=$1 and resource_type='document' and resource_id=$2`, [tenantId, docC]);
    await tx.execute(`update corvis_control.data_rights set source_document_access_allowed=false where tenant_id=$1 and resource_type='document' and resource_id=$2`, [tenantId, docC]);

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

    // Contractual rights are re-checked at download: once source-file access for a file in the archive is withdrawn after a link was issued, redeeming it is refused.
    const sourceLink = await backend.issueDownload(identity(admin1, true), mine.requestId, tx);
    await tx.execute(`update corvis_control.data_rights set source_document_access_allowed=false where tenant_id=$1 and resource_type='document' and resource_id=$2`, [tenantId, docA]);
    assert.equal((await refused(tx, () => backend.redeemDownload(identity(admin1, true), mine.requestId, new URL(sourceLink.download.downloadUrl, 'https://corvis.test').searchParams.get('grant'), tx))).code, 'data_export_rights_changed');
    assert.equal((await tx.query('select consumed_at from corvis_control.tenant_export_download_grant where token_sha256=$1', [sha(new URL(sourceLink.download.downloadUrl, 'https://corvis.test').searchParams.get('grant'))]))[0].consumed_at, null, 'a refused redemption does not consume the link');
    await tx.execute(`update corvis_control.data_rights set source_document_access_allowed=true where tenant_id=$1 and resource_type='document' and resource_id=$2`, [tenantId, docA]);
    // ... and so once the document's redistribution right lapses, the archive cannot be fetched at all.
    const lastLink = await backend.issueDownload(identity(admin1, true), mine.requestId, tx);
    await tx.execute(`update corvis_control.data_rights set redistribution_allowed=false where tenant_id=$1 and resource_type='document' and resource_id=$2`, [tenantId, docA]);
    assert.equal((await refused(tx, () => backend.redeemDownload(identity(admin1, true), mine.requestId, new URL(lastLink.download.downloadUrl, 'https://corvis.test').searchParams.get('grant'), tx))).code, 'data_export_rights_changed');
    assert.equal((await refused(tx, () => backend.issueDownload(identity(admin1, true), mine.requestId, tx))).code, 'data_export_rights_changed', 'no new link either');

    // Listing, and the tenant's audit trail: every system step is audited, human steps are audited by the service layer.
    assert.equal((await backend.list(identity(admin1, true), { limit: 10 }, tx)).items.length, 1);
    const audit = await tx.query(`select action, actor_subject from corvis_control.audit_event where target_type='tenant_export_request' order by action`);
    // Both rows share one transaction timestamp and the id is random, so order by action rather than by time.
    assert.deepEqual(audit.map((row) => row.action), ['data_export.build_completed', 'data_export.build_started']);
    assert.ok(audit.every((row) => row.actor_subject === 'system:tenant-export'));

    // ------------------------------------------------------------------------------------------------------------------
    // F10d: approval and outcome notices, dispatched through the application's outbox worker.
    // ------------------------------------------------------------------------------------------------------------------
    for (const person of [admin1, admin2]) {
      await tx.execute(`insert into corvis_control.notification_recipient (tenant_id,user_id,email,source,verified_at,updated_at) values ($1,$2,$3,'verified_identity_claim',now(),now())`,
        [tenantId, person.userId, `${person.subject}@corvis.test`]);
    }
    const mailer = new RecordingEmailSender();
    const dispatch = () => processEmailOutbox({ db: tx, sender: mailer, appUrl: 'https://app.corvis.test' });
    const outboxFor = async (category, userId) => (await tx.query(`select status,suppression_reason,template_params->>'event' as event from corvis_control.email_outbox where tenant_id=$1 and category=$2 and recipient_user_id=$3 order by status,template_params->>'event',dedupe_key`, [tenantId, category, userId])).map((row) => ({ ...row }));
    const readEmails = () => mailer.sent.map((email) => ({ to: email.to, subject: email.subject, text: email.text, category: email.category }));
    const REASON = /Records review at contract end|admin-one|admin-two|SECRET/;

    // Admin one asked and admin two approved; admin one then turns the optional outcome notice off. The approval notice
    // to admin two cannot be turned off and is sent; admin one's approved and ready notices are suppressed as opted out.
    assert.deepEqual(await outboxFor('tenant_export_approval', admin2.userId), [{ status: 'queued', suppression_reason: null, event: 'approval_needed' }]);
    assert.deepEqual(await outboxFor('tenant_export_approval', admin1.userId), [], 'the requester is not asked to approve their own request');
    assert.deepEqual((await outboxFor('tenant_export_outcome', admin1.userId)).map((row) => row.event).sort(), ['approved', 'ready']);
    await tx.execute(`insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery) values ($1,$2,'tenant_export_outcome',false,'immediate')`, [tenantId, admin1.userId]);
    await dispatch();
    assert.deepEqual((await outboxFor('tenant_export_approval', admin2.userId)).map((row) => row.status), ['sent']);
    assert.deepEqual((await outboxFor('tenant_export_outcome', admin1.userId)).map((row) => [row.status, row.suppression_reason]), [['suppressed', 'opted_out'], ['suppressed', 'opted_out']]);
    let emails = readEmails().filter((email) => email.to.endsWith('@corvis.test'));
    assert.deepEqual(emails.map((email) => [email.to, email.category]), [['admin-two@corvis.test', 'tenant_export_approval']]);
    assert.match(emails[0].subject, /needs your approval/);
    assert.match(emails[0].text, /\/access-self-service/);
    assert.match(emails[0].text, /cannot be turned off/);
    assert.doesNotMatch(emails[0].text, REASON, 'no reason, name or note in the email');
    await tx.execute(`delete from corvis_control.notification_preference where tenant_id=$1 and user_id=$2`, [tenantId, admin1.userId]);

    // A rejection tells the requester in words only; the other admin is asked to approve the new request.
    const second = await backend.request(identity(admin2, true), { reason: 'SECRET purpose from admin two' }, tx);
    await backend.decide(identity(admin1, true), second.requestId, { action: 'reject', note: 'SECRET note from admin one' }, tx);
    await dispatch();
    emails = readEmails().filter((email) => email.to.endsWith('@corvis.test')).slice(1);
    assert.deepEqual(emails.map((email) => [email.to, email.category]).sort(), [['admin-one@corvis.test', 'tenant_export_approval'], ['admin-two@corvis.test', 'tenant_export_outcome']]);
    assert.match(emails.find((email) => email.to === 'admin-two@corvis.test').subject, /was rejected/);
    for (const email of emails) assert.doesNotMatch(email.text, REASON);

    // Eligibility is re-checked when the notice is sent: an admin demoted after it was queued is not emailed.
    const third = await backend.request(identity(admin1, true), { reason: 'Demotion check' }, tx);
    assert.deepEqual(await outboxFor('tenant_export_approval', admin2.userId), [{ status: 'queued', suppression_reason: null, event: 'approval_needed' }, { status: 'sent', suppression_reason: null, event: 'approval_needed' }]);
    await tx.execute(`update corvis_control.membership set status='revoked' where tenant_id=$1 and user_id=$2`, [tenantId, admin2.userId]);
    const sentBefore = mailer.sent.length;
    await dispatch();
    assert.equal(mailer.sent.length, sentBefore, 'nothing is sent to a demoted admin');
    assert.deepEqual((await outboxFor('tenant_export_approval', admin2.userId)).map((row) => [row.status, row.suppression_reason]), [['sent', null], ['suppressed', 'not_eligible']]);
    await tx.execute(`update corvis_control.membership set status='active' where tenant_id=$1 and user_id=$2`, [tenantId, admin2.userId]);
    await backend.decide(identity(admin1, true), third.requestId, { action: 'cancel' }, tx);

    // A build that keeps failing: retried with backoff, then the requester is told, and operations see why.
    const fourth = await backend.request(identity(admin1, true), { reason: 'Failing build' }, tx);
    await backend.decide(identity(admin2, true), fourth.requestId, { action: 'approve' }, tx);
    // The store takes the first piece, and while the build is in flight the request shows its size estimate (F10c) before failing.
    let seen = null;
    const broken = {
      bucket: 'ci-bucket',
      async putObjectStream(_key, source) {
        await source[Symbol.asyncIterator]().next();
        seen = await backend.get(identity(admin1, true), fourth.requestId, tx);
        throw new Error('object store down');
      },
      async getObjectStream() { return null; },
      async deleteObject() {},
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.deepEqual(await processApprovedTenantExports(5, { store: tx, objectStore: broken }), { processed: 0, failed: 1 });
      const retrying = await listTenantExportBuildIssues(tx, { limit: 10 });
      const issue = retrying.items.find((item) => item.requestId === fourth.requestId);
      assert.equal(issue.status, attempt < 5 ? 'retrying' : 'failed');
      assert.equal(issue.attempts, attempt);
      assert.equal(seen.status, 'building', 'the export is shown as building while the worker streams it');
      assert.deepEqual([seen.progress.phase, seen.progress.percent, seen.progress.bytesWritten], ['estimating', 0, 0]);
      assert.deepEqual([seen.progress.estimatedDocuments, seen.progress.estimatedBytes > 0, seen.progress.estimatedRows >= 4], [0, true, true], 'counted before anything is written, and from the rights as they are now (document A was withdrawn above, so it has no file to count)');
      assert.equal(seen.history.at(-1).eventType, 'build_started');
      seen = null;
      assert.match(issue.lastError, /object store down/);
      assert.equal(issue.tenantName, 'F10 CI');
      assert.deepEqual(Object.keys(issue).sort(), ['attempts', 'changedAt', 'lastError', 'nextAttemptAt', 'requestId', 'requestedAt', 'status', 'tenantId', 'tenantName'], 'no requester, reason or approver reaches operations');
      if (attempt < 5) await tx.execute(`update corvis_control.tenant_export_request set build_next_attempt_at=now() where request_id=$1`, [fourth.requestId]);
    }
    assert.equal((await backend.get(identity(admin1, true), fourth.requestId, tx)).status, 'failed');
    assert.deepEqual((await listTenantExportBuildIssues(tx, { limit: 10, status: 'retrying' })).items.filter((item) => item.requestId === fourth.requestId), []);
    assert.equal((await listTenantExportBuildIssues(tx, { limit: 10, status: 'failed' })).items.filter((item) => item.requestId === fourth.requestId).length, 1);
    assert.equal((await outboxFor('tenant_export_outcome', admin1.userId)).filter((row) => row.event === 'failed').length, 1, 'the requester is told once, when the build gives up');
    await dispatch();
    emails = readEmails().filter((email) => email.to === 'admin-one@corvis.test' && email.category === 'tenant_export_outcome');
    assert.deepEqual(emails.map((email) => email.subject).sort(), ['Your Corvis organization export could not be built', 'Your Corvis organization export was approved']);

    // Operations paging is keyset-stable even for rows sharing one timestamp.
    const failedPage = await listTenantExportBuildIssues(tx, { limit: 1 });
    assert.equal(failedPage.items.length, 1);
    assert.equal(failedPage.nextCursor, null, 'one failed build, nothing more');

    // F10f: the request list is paged with a keyset cursor. All four requests share this transaction's timestamp, so the
    // order and the cursor rest on the id tie-break: every request appears once, in the same order as one big page.
    const everything = (await backend.list(identity(admin1, true), { limit: 50 }, tx)).items.map((item) => item.requestId);
    assert.equal(everything.length, 4);
    assert.deepEqual([...everything], [...everything].sort().reverse(), 'same timestamp: newest-first falls back to id descending');
    const walked = [];
    let cursor = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await backend.list(identity(admin1, true), { limit: 3, cursor }, tx);
      walked.push(...page.items.map((item) => item.requestId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(walked, everything, 'paging by cursor yields each request exactly once, in order');

    // F10f: the sweep. Make the first export's artifact lifetime pass; its object is deleted, the deletion is recorded and
    // audited once, its grants go with it, and an old grant on another request is swept too.
    await tx.execute(`update corvis_control.tenant_export_request set artifact_expires_at = now() - interval '1 minute' where request_id=$1`, [mine.requestId]);
    await tx.execute(`insert into corvis_control.tenant_export_download_grant (tenant_id,request_id,subject,token_sha256,expires_at) values ($1,$2,'admin-one',$3,now()-interval '3 days')`, [tenantId, second.requestId, 'ab'.repeat(32)]);
    assert.equal(objects.exports().length, 1);
    assert.deepEqual(await sweepTenantExports({ store: tx, objectStore: objects }), { artifactsDeleted: 1, grantsDeleted: 1, errors: 0 });
    assert.equal(objects.exports().length, 0, 'the stored archive was deleted from the object store');
    const swept = await backend.get(identity(admin1, true), mine.requestId, tx);
    assert.equal(swept.status, 'download_expired');
    assert.equal(swept.history.at(-1).eventType, 'artifact_deleted');
    assert.equal((await tx.query(`select count(*)::int as n from corvis_control.tenant_export_download_grant where tenant_id=$1`, [tenantId]))[0].n, 0);
    assert.deepEqual((await tx.query(`select action from corvis_control.audit_event where tenant_id=$1 and action in ('data_export.artifact_deleted','data_export.grants_swept') order by action`, [tenantId])).map((row) => row.action),
      ['data_export.artifact_deleted', 'data_export.grants_swept']);
    assert.deepEqual(await sweepTenantExports({ store: tx, objectStore: objects }), { artifactsDeleted: 0, grantsDeleted: 0, errors: 0 }, 'a second sweep has nothing to do');

    // Nothing touched the per-user export queue or the outbox.
    const after = await tx.query(`select (select count(*) from corvis_serving.export_job)::int as jobs, (select count(*) from corvis_control.outbox_event)::int as outbox`);
    assert.deepEqual(after[0], before[0]);

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('tenant data export: ok');
} finally {
  await db.close?.();
}
