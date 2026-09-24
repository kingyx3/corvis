import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { sqlKeyset, type KeysetPage } from "./pagination.ts";
import { postgres, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

function text(row: PostgresRow, key: string): string { return row[key] == null ? "" : String(row[key]); }
function nullableText(row: PostgresRow, key: string): string | null { return row[key] == null ? null : String(row[key]); }
function allowedFundJson(identity: RequestIdentity): string { return JSON.stringify(identity.entitlements.fundIds ?? []); }

export type PublicReconciliation = {
  id: string;
  snapshotId: string;
  snapshotVersion: number;
  fundId: string;
  reportPeriod: string;
  status: "blocked" | "ready";
  schemaVersion: string;
  taxonomyVersion: string;
  observationCount: number;
  blockingExceptionCount: number;
  createdAt: string;
  completedAt: string | null;
};

export class PostgresReconciliationServingRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  /** `page` pushes one keyset page (by reconciliation run id, the route's cursor key) down to SQL; see sqlKeyset. */
  async list(identity: RequestIdentity, page?: KeysetPage): Promise<PublicReconciliation[]> {
    const parameters: PostgresPrimitive[] = [identity.tenantId, allowedFundJson(identity)];
    const keyset = page ? sqlKeyset("r.reconciliation_run_id::text", page, parameters) : { where: "", tail: "order by r.created_at desc,r.reconciliation_run_id" };
    const rows = await this.db.query(`
      with allowed_fund as (
        select value as fund_id from jsonb_array_elements_text($2::jsonb)
      )
      select r.reconciliation_run_id,r.snapshot_id,r.snapshot_version,r.fund_id,r.report_period,
             r.status,r.schema_version,r.taxonomy_version,r.observation_count,
             r.blocking_exception_count,r.created_at,r.completed_at
      from corvis_consolidated.reconciliation_run r
      join allowed_fund a on a.fund_id=r.fund_id
      where r.tenant_id=$1::uuid${keyset.where}
      ${keyset.tail}`, parameters);
    return rows.map((row) => ({
      id: text(row,"reconciliation_run_id"),
      snapshotId: text(row,"snapshot_id"),
      snapshotVersion: Number(row.snapshot_version ?? 0),
      fundId: text(row,"fund_id"),
      reportPeriod: text(row,"report_period"),
      status: text(row,"status") as "blocked"|"ready",
      schemaVersion: text(row,"schema_version"),
      taxonomyVersion: text(row,"taxonomy_version"),
      observationCount: Number(row.observation_count ?? 0),
      blockingExceptionCount: Number(row.blocking_exception_count ?? 0),
      createdAt: text(row,"created_at"),
      completedAt: nullableText(row,"completed_at"),
    }));
  }
}

let singleton: PostgresReconciliationServingRepository | undefined;
export function reconciliationServing(dsn = getServerConfig().postgresDsn): PostgresReconciliationServingRepository {
  if (!singleton) singleton = new PostgresReconciliationServingRepository(postgres(dsn));
  return singleton;
}
