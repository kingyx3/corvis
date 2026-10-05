import type { PerformanceScorecardExportScope } from "../../core/delivery.ts";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { buildScorecard, parseScorecardFilters, scorecardExportRows, scorecardScopeLabel, scorecardSnapshotIds, type ScorecardFilters } from "../../core/performance-scorecard.ts";
import { assertExportRowLimit, type ExportRow } from "./export-renderer.ts";
import { PostgresPerformanceScorecardRepository } from "./performance-scorecard.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

/** Delivery-history label of an unfiltered scorecard export; a filtered one names its filters (`scorecardScopeLabel`). */
export const SCORECARD_EXPORT_LABEL = scorecardScopeLabel({});

/**
 * The scorecard scope as persisted in a manifest or sent by a client, with its canonical filters; anything but
 * `performanceScorecard: true` is not a scorecard scope (undefined). A scorecard scope whose filters are malformed throws
 * `ScorecardFilterError` (a 400 for the caller) rather than silently exporting a wider scorecard.
 */
export function performanceScorecardScope(value: unknown): PerformanceScorecardExportScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { performanceScorecard?: unknown; fundId?: unknown; period?: unknown };
  return candidate.performanceScorecard === true ? { performanceScorecard: true, ...parseScorecardFilters(candidate) } : undefined;
}

/**
 * Resolves a scorecard export request to the exact already-entitled published data behind the view: the row count
 * the manifest records and the current published snapshots the export is pinned to. A scorecard with no reported
 * figure resolves to nothing and is refused, like every scope that resolves to nothing, rather than exporting an
 * empty file or widening the scope. The scorecard is read fund page by fund page, so a tenant above the per-page figure
 * cap resolves too; a fund filter naming a fund the caller is not entitled to is refused by the read.
 */
export async function resolveScorecardExport(identity: RequestIdentity, store: PostgresSqlApi, filters: ScorecardFilters = {}): Promise<{ rowCount: number; snapshots: PostgresRow[] }> {
  const snapshotIds = new Set<string>();
  const fundIds: string[] = [];
  let rowCount = 0;
  for await (const payload of new PostgresPerformanceScorecardRepository(store).pages(identity, filters)) {
    const scorecard = buildScorecard(payload);
    for (const id of scorecardSnapshotIds(scorecard)) snapshotIds.add(id);
    fundIds.push(...payload.funds.map((fund) => fund.fundId));
    rowCount += scorecardExportRows(scorecard).length;
  }
  if (snapshotIds.size === 0) throw new AuthorizationError("exports:scope");
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
  [identity.tenantId, JSON.stringify(fundIds), JSON.stringify([...snapshotIds].sort())]);
  return { rowCount, snapshots };
}

/**
 * The scorecard export rows, rebuilt at delivery time from only the snapshots the export was pinned to, with the filters it
 * was requested with. If any pinned snapshot has since been withdrawn, superseded or taken out of the caller's entitlement it
 * no longer contributes, and the export fails instead of delivering a different scorecard than the one that was requested.
 */
export async function loadScorecardExportRows(identity: RequestIdentity, snapshotIds: readonly string[], store: PostgresSqlApi, filters: ScorecardFilters = {}): Promise<ExportRow[]> {
  if (snapshotIds.length === 0) throw new Error("export_snapshot_authorization_expired");
  const rows: ExportRow[] = [];
  const contributing = new Set<string>();
  for await (const payload of new PostgresPerformanceScorecardRepository(store).pages(identity, { ...filters, snapshotIds })) {
    const scorecard = buildScorecard(payload);
    for (const id of scorecardSnapshotIds(scorecard)) contributing.add(id);
    // Pushed one by one: a spread of this many rows would overflow the call stack.
    for (const row of scorecardExportRows(scorecard)) rows.push(row);
    assertExportRowLimit(rows.length);
  }
  if (contributing.size !== snapshotIds.length) throw new Error("export_snapshot_authorization_expired");
  return rows;
}
