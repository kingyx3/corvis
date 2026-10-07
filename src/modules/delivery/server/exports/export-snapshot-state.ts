import { AuthorizationError, type RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type { PostgresSqlApi } from "../../../../platform/database/postgres.ts";

/** A stale/unverifiable export must be requested again, never silently rebuilt from a replacement publication. */
export class ExportSnapshotChangedError extends AuthorizationError {
  readonly code = "export_snapshot_authorization_expired";
  readonly retryable = false;
  constructor() { super("exports:current_data_rights"); }
}

/** Validate every recorded version, including between loader pages and again before downloading stored bytes. */
export async function assertExportSnapshotVersions(
  identity: RequestIdentity,
  snapshotIds: readonly string[],
  snapshotState: unknown,
  store: PostgresSqlApi,
): Promise<void> {
  if (snapshotIds.length === 0) return;
  if (!Array.isArray(snapshotState) || snapshotState.length !== snapshotIds.length) throw new ExportSnapshotChangedError();
  const expected = new Set(snapshotIds);
  if (expected.size !== snapshotIds.length) throw new ExportSnapshotChangedError();
  for (const pin of snapshotState) {
    if (!pin || typeof pin.snapshotId !== "string" || !expected.delete(pin.snapshotId)
      || !Number.isSafeInteger(pin.version) || pin.version < 1 || pin.version > 2_147_483_647) throw new ExportSnapshotChangedError();
  }
  const rows = await store.query(`select count(distinct s.snapshot_id) as snapshot_count
    from corvis_consolidated.fund_period_snapshot s
    join jsonb_to_recordset($4::jsonb) as pin("snapshotId" text, version integer)
      on s.snapshot_id::text=pin."snapshotId" and s.version=pin.version
    where s.tenant_id=$1::uuid and s.status='published'
      and not exists (
        select 1 from corvis_consolidated.fund_period_snapshot newer
        where newer.tenant_id=s.tenant_id and newer.snapshot_id=s.snapshot_id and newer.version>s.version
      )
      and s.snapshot_id::text in (select jsonb_array_elements_text($2::jsonb))
      and s.fund_id in (select jsonb_array_elements_text($3::jsonb))`,
  [identity.tenantId, JSON.stringify(snapshotIds), JSON.stringify(identity.entitlements.fundIds ?? []), JSON.stringify(snapshotState)]);
  if (Number(rows[0]?.snapshot_count ?? 0) !== snapshotIds.length) throw new ExportSnapshotChangedError();
}
