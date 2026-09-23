import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { getPhysicalExportStatus, type ExportStatus } from "./physical-exports.ts";

export async function listPhysicalExportStatuses(
  identity: RequestIdentity,
  limit = 20,
  store: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<ExportStatus[]> {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await store.query(`select export_id
    from corvis_serving.export_job
    where tenant_id=$1 and requested_by=$2
    order by created_at desc
    limit $3`, [identity.tenantId, identity.subject, boundedLimit]);
  const statuses = await Promise.all(rows.map((row) => getPhysicalExportStatus(identity, String(row.export_id), store)));
  return statuses.filter((status): status is ExportStatus => status != null);
}
