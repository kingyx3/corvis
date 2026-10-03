import type { PerformanceScorecardExportScope } from "../../core/delivery.ts";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { buildScorecard, scorecardExportRows, scorecardSnapshotIds } from "../../core/performance-scorecard.ts";
import { assertExportRowLimit, type ExportRow } from "./export-renderer.ts";
import { PostgresPerformanceScorecardRepository } from "./performance-scorecard.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

/** Delivery-history label of a scorecard export. */
export const SCORECARD_EXPORT_LABEL = "Performance scorecard · all entitled funds";

/** The scorecard scope as persisted in a manifest or sent by a client; anything but `performanceScorecard: true` is not one. */
export function performanceScorecardScope(value: unknown): PerformanceScorecardExportScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as { performanceScorecard?: unknown }).performanceScorecard === true ? { performanceScorecard: true } : undefined;
}

/**
 * Resolves a scorecard export request to the exact already-entitled published data behind the view: the row count
 * the manifest records and the current published snapshots the export is pinned to. A scorecard with no reported
 * figure resolves to nothing and is refused, like every scope that resolves to nothing, rather than exporting an
 * empty file or widening the scope.
 */
export async function resolveScorecardExport(identity: RequestIdentity, store: PostgresSqlApi): Promise<{ rowCount: number; snapshots: PostgresRow[] }> {
  const payload = await new PostgresPerformanceScorecardRepository(store).load(identity);
  const scorecard = buildScorecard(payload);
  const snapshotIds = scorecardSnapshotIds(scorecard);
  if (snapshotIds.length === 0) throw new AuthorizationError("exports:scope");
  const snapshots = await store.query(`select s.snapshot_id,s.schema_version,s.taxonomy_version,s.fund_id,s.version,s.blocking_exception_count
    from corvis_serving.fund_period_snapshots s
    where s.tenant_id=$1 and s.status='published'
      and not exists (
        select 1 from corvis_serving.fund_period_snapshots newer
        where newer.tenant_id=s.tenant_id and newer.snapshot_id=s.snapshot_id and newer.version>s.version
      )
      and s.fund_id in (select jsonb_array_elements_text($2::jsonb))
      and s.snapshot_id::text in (select jsonb_array_elements_text($3::jsonb))
    order by s.published_at desc`,
  [identity.tenantId, JSON.stringify(payload.funds.map((fund) => fund.fundId)), JSON.stringify(snapshotIds)]);
  return { rowCount: scorecardExportRows(scorecard).length, snapshots };
}

/**
 * The scorecard export rows, rebuilt at delivery time from only the snapshots the export was pinned to. If any pinned
 * snapshot has since been withdrawn, superseded or taken out of the caller's entitlement it no longer contributes, and
 * the export fails instead of delivering a different scorecard than the one that was requested.
 */
export async function loadScorecardExportRows(identity: RequestIdentity, snapshotIds: readonly string[], store: PostgresSqlApi): Promise<ExportRow[]> {
  const payload = await new PostgresPerformanceScorecardRepository(store).load(identity, { snapshotIds });
  const scorecard = buildScorecard(payload);
  if (snapshotIds.length === 0 || scorecardSnapshotIds(scorecard).length !== snapshotIds.length) throw new Error("export_snapshot_authorization_expired");
  const rows = scorecardExportRows(scorecard);
  assertExportRowLimit(rows.length);
  return rows;
}
