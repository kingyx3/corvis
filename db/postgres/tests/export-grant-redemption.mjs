// Real-Postgres acceptance for physical export download grants: the redemption SQL in
// src/modules/delivery/server/exports/physical-exports.ts must be bound to the grant's subject, tenant, token hash
// and expiry (and to a complete, unexpired export owned by that subject). Runs the
// application code itself against a native connection inside one transaction that is
// always rolled back. Run after the full migration chain on a disposable database:
//   CORVIS_DATABASE_DSN=postgres://... node db/postgres/tests/export-grant-redemption.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NativePostgresSqlApi } from '../../../src/platform/database/postgres-native.ts';
import { getPhysicalExportStatus, redeemPhysicalExportGrant, restorePhysicalExportGrant } from '../../../src/modules/delivery/server/exports/physical-exports.ts';
import { assertExportSnapshotVersions } from '../../../src/modules/delivery/server/exports/export-snapshot-state.ts';

const dsn = process.env.CORVIS_DATABASE_DSN;
assert.ok(dsn, 'CORVIS_DATABASE_DSN is required');

const tenantId = 'e9000000-0000-4000-8000-000000000001';
const workspaceId = 'e9000000-0000-4000-8000-000000000002';
const exportId = 'e9000000-0000-4000-8000-000000000003';
const objectUri = 'gs://ci-bucket/exports/export.csv';
const ROLLBACK = Symbol('rollback');

function identity(subject, overrides = {}) {
  return {
    subject, tenantId, workspaceId, roles: ['analyst'], authMethod: 'oidc', sessionId: `session-${subject}`,
    entitlements: { workspaceIds: [workspaceId], fundIds: [], documentIds: [], sourceDocumentAccessAllowed: false, redistributionAllowed: true },
    ...overrides,
  };
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
const db = new NativePostgresSqlApi(dsn);
try {
  await assert.rejects(db.transaction(async (tx) => {
    await tx.execute(`insert into corvis_control.tenant (tenant_id,slug,display_name) values ($1,'export-grant-ci','Export Grant CI')`, [tenantId]);
    await tx.execute(`insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name) values ($1,$2,'ws','Workspace')`, [workspaceId, tenantId]);
    await tx.execute(`insert into corvis_serving.export_job
        (tenant_id,export_id,workspace_id,auth_method,session_id,requested_by,format,snapshot_ids,state,checksum_sha256,
         object_uri,manifest,created_at,completed_at,expires_at)
      values ($1,$2,$3,'oidc','s','owner','csv','{}','complete',$4,$5,$6::jsonb,now(),now(),now() + interval '1 hour')`,
    [tenantId, exportId, workspaceId, 'a'.repeat(64), objectUri, JSON.stringify({ exportId, tenantId, format: 'csv', snapshotIds: [] })]);

    // The owner reads their export and is issued a grant; only its hash is stored.
    const status = await getPhysicalExportStatus(identity('owner'), exportId, tx);
    assert.ok(status?.downloadAvailable, 'a complete, unexpired export is downloadable');
    const token = new URL(status.downloadUrl, 'https://corvis.test').searchParams.get('grant');
    assert.ok(token && token.length >= 32);
    const stored = await tx.query('select subject,token_sha256,expires_at > now() as live from corvis_serving.export_download_grant where export_id=$1', [exportId]);
    assert.deepEqual(stored.map((row) => [row.subject, row.token_sha256, row.live]), [['owner', sha(token), true]]);

    // Grants are single use, so every check below that must reach the redemption predicate runs
    // against a freshly issued, unconsumed grant; otherwise it would "pass" only because an earlier
    // redemption already consumed the token.
    const issueGrant = async () => {
      const current = await getPhysicalExportStatus(identity('owner'), exportId, tx);
      const issued = new URL(current.downloadUrl, 'https://corvis.test').searchParams.get('grant');
      assert.ok(issued && issued.length >= 32, 'a fresh grant is issued on each read');
      return issued;
    };

    // Only the owner, in the same tenant, with the exact token, can redeem it -- and only once.
    const redeemed = await redeemPhysicalExportGrant(identity('owner'), exportId, token, tx);
    assert.deepEqual(redeemed, { objectUri, format: 'csv', checksumSha256: 'a'.repeat(64) });
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, token, tx), null, 'a grant is single use: a replay matches nothing');

    // Failed attempts never consume a valid grant (binding is part of the same predicate).
    const bound = await issueGrant();
    assert.equal(await redeemPhysicalExportGrant(identity('someone-else'), exportId, bound, tx), null, 'a grant is bound to its subject');
    assert.equal(await redeemPhysicalExportGrant(identity('owner', { tenantId: 'e9000000-0000-4000-8000-0000000000ff' }), exportId, bound, tx), null, 'a grant is bound to its tenant');
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, `${bound}x`, tx), null, 'a different token never redeems');
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, '', tx), null);
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), 'e9000000-0000-4000-8000-0000000000aa', bound, tx), null, 'a grant is bound to its export');
    assert.ok(await redeemPhysicalExportGrant(identity('owner'), exportId, bound, tx), 'the grant survived every failed attempt and still redeems for its owner');

    // A download that failed before any byte was delivered gives the grant back, for its own subject only.
    const restorable = await issueGrant();
    assert.ok(await redeemPhysicalExportGrant(identity('owner'), exportId, restorable, tx));
    await restorePhysicalExportGrant(identity('someone-else'), exportId, restorable, tx);
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, restorable, tx), null, 'another subject cannot restore the grant');
    await restorePhysicalExportGrant(identity('owner'), exportId, restorable, tx);
    assert.ok(await redeemPhysicalExportGrant(identity('owner'), exportId, restorable, tx), 'the owner\'s restored grant redeems again');
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, restorable, tx), null, 'and is single use again');

    // Current data rights are re-checked at redemption, not only when the grant was issued.
    const rightsGrant = await issueGrant();
    await assert.rejects(
      redeemPhysicalExportGrant(identity('owner', { entitlements: { workspaceIds: [workspaceId], fundIds: [], documentIds: [], sourceDocumentAccessAllowed: false, redistributionAllowed: false } }), exportId, rightsGrant, tx),
      (error) => error?.name === 'AuthorizationError' || /Access denied/.test(String(error?.message)),
    );

    // An expired grant no longer redeems.
    const expiredGrant = await issueGrant();
    await tx.execute(`update corvis_serving.export_download_grant set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where export_id=$1 and token_sha256=$2`, [exportId, sha(expiredGrant)]);
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, expiredGrant, tx), null, 'an expired grant must not redeem');
    await restorePhysicalExportGrant(identity('owner'), exportId, expiredGrant, tx);
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, expiredGrant, tx), null, 'restoring never revives an expired grant');

    // Nor does a live grant for an export that is not complete, or that has itself expired.
    const incompleteGrant = await issueGrant();
    await tx.execute(`update corvis_serving.export_job set state='delivering' where export_id=$1`, [exportId]);
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, incompleteGrant, tx), null, 'an incomplete export must not redeem');
    await tx.execute(`update corvis_serving.export_job set state='complete' where export_id=$1`, [exportId]);
    assert.ok(await redeemPhysicalExportGrant(identity('owner'), exportId, incompleteGrant, tx), 'sanity: once complete again the untouched grant redeems');
    const expiredExportGrant = await issueGrant();
    await tx.execute(`update corvis_serving.export_job set expires_at = now() - interval '1 minute' where export_id=$1`, [exportId]);
    assert.equal(await redeemPhysicalExportGrant(identity('owner'), exportId, expiredExportGrant, tx), null, 'an expired export must not redeem');

    // Same snapshot ID, newer published version: old bytes and old manifests must stop being served.
    const snapshotId = 'e9000000-0000-4000-8000-000000000004';
    const owner = identity('owner', { entitlements: { fundIds: ['export-grant-fund'], documentIds: [], redistributionAllowed: true } });
    const pins = [{ snapshotId, version: 1, openExceptionCount: 0 }];
    const manifest = { snapshotIds: [snapshotId], snapshotState: pins, artifact: { fundIds: ['export-grant-fund'], documentIds: [] } };
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot
      (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version)
      values ($1,$2,'export-grant-fund','2026-Q3',1,'published','v1','v1')`, [tenantId, snapshotId]);
    await tx.execute(`update corvis_serving.export_job set expires_at=now()+interval '1 hour',
      snapshot_ids=array[$2::uuid],manifest=$3::jsonb where export_id=$1`, [exportId, snapshotId, JSON.stringify(manifest)]);
    const pinnedStatus = await getPhysicalExportStatus(owner, exportId, tx);
    assert.ok(pinnedStatus.downloadAvailable);
    const pinnedToken = new URL(pinnedStatus.downloadUrl, 'https://corvis.test').searchParams.get('grant');
    await assertExportSnapshotVersions(owner, [snapshotId], pins, tx);
    // Leave v1 published too: the latest-version guard must still reject it.
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot
      (tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version)
      values ($1,$2,'export-grant-fund','2026-Q3',2,'published','v1','v1')`, [tenantId, snapshotId]);
    const changed = (error) => error.code === 'export_snapshot_authorization_expired';
    await assert.rejects(getPhysicalExportStatus(owner, exportId, tx), changed);
    await assert.rejects(redeemPhysicalExportGrant(owner, exportId, pinnedToken, tx), changed);
    await assert.rejects(assertExportSnapshotVersions(owner, [snapshotId], pins, tx), changed);
    const replacementPins = [{ ...pins[0], version: 2 }];
    await assertExportSnapshotVersions(owner, [snapshotId], replacementPins, tx);
    await assert.rejects(assertExportSnapshotVersions(identity('owner'), [snapshotId], replacementPins, tx), changed);
    await assert.rejects(assertExportSnapshotVersions({ ...owner, tenantId: 'e9000000-0000-4000-8000-0000000000ff' }, [snapshotId], replacementPins, tx), changed);
    await tx.execute(`update corvis_consolidated.fund_period_snapshot set status='withdrawn' where tenant_id=$1 and snapshot_id=$2 and version=2`, [tenantId, snapshotId]);
    await assert.rejects(assertExportSnapshotVersions(owner, [snapshotId], replacementPins, tx), changed);

    throw ROLLBACK;
  }), (error) => error === ROLLBACK);
  console.log('export grant redemption acceptance passed');
} finally {
  await db.close?.();
}
