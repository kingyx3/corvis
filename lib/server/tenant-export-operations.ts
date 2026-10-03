import type { RequestIdentity } from "../../core/enterprise.ts";
import { DataGovernanceError } from "./data-governance.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { decodeKeysetCursor, encodeKeysetCursor, keysetTimestampSql } from "./tenant-export.ts";

/**
 * The operator view of full tenant export builds that did not succeed (F10f, #326), for Corvis operations on
 * `GET /api/v1/admin/tenant-export-builds` and the `/admin/tenant-export-builds` page. A customer only ever sees that an
 * export "could not be built"; the cause is stored in `last_error` (migration 084), which until now no surface showed.
 *
 * What an operator may see is deliberately no more than they already see on the cross-tenant tenant-health view plus the
 * build's own diagnostics: the tenant (id and name), the request id, whether it is still being retried or has given up, the
 * attempt count, the stored error and the timestamps. Never the requester, the reason they gave, the approver, the manifest
 * or anything in the archive. `last_error` is already redacted when it is written (`safeErrorText`, or a fixed phrase for a
 * lapsed lease).
 */

export type TenantExportBuildIssueStatus = "failed" | "retrying";

export type TenantExportBuildIssue = {
  tenantId: string;
  tenantName: string;
  requestId: string;
  /** `failed`: the build gave up and nothing was delivered. `retrying`: an attempt failed and another is scheduled. */
  status: TenantExportBuildIssueStatus;
  attempts: number;
  lastError: string | null;
  requestedAt: string;
  /** When the request last changed state (for a failed build, when it gave up). */
  changedAt: string;
  /** When the next attempt is due, for a build that is being retried. */
  nextAttemptAt: string | null;
};

export type TenantExportBuildIssuePage = { items: TenantExportBuildIssue[]; nextCursor: string | null };

export type TenantExportBuildIssueQuery = { limit: number; cursor?: string | null; status?: TenantExportBuildIssueStatus };

/** Only the Corvis operations organization's own admins reach this; every other tenant, even its Organization Admins, is refused. */
export function assertOperationsAdmin(identity: RequestIdentity, operationsTenantId: string | undefined): void {
  if (!operationsTenantId || identity.tenantId !== operationsTenantId || !identity.roles.includes("admin")) {
    throw new DataGovernanceError("operations_admin_required", 403);
  }
}

/** `?status=failed|retrying`; absent lists both. Anything else is a 400 rather than a silently ignored filter. */
export function parseBuildIssueStatus(value: string | null): TenantExportBuildIssueStatus | undefined {
  if (value === null || value === "") return undefined;
  if (value === "failed" || value === "retrying") return value;
  throw new DataGovernanceError("invalid_status", 400);
}

const STATUS_PREDICATE: Record<TenantExportBuildIssueStatus | "all", string> = {
  all: "(r.state = 'failed' or (r.state = 'approved' and r.last_error is not null))",
  failed: "r.state = 'failed'",
  retrying: "(r.state = 'approved' and r.last_error is not null)",
};

function toIssue(row: PostgresRow): TenantExportBuildIssue {
  return {
    tenantId: String(row.tenant_id),
    tenantName: String(row.tenant_name),
    requestId: String(row.request_id),
    status: row.state === "failed" ? "failed" : "retrying",
    attempts: Number(row.build_attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
    requestedAt: String(row.requested_at),
    changedAt: String(row.state_changed_at),
    nextAttemptAt: row.build_next_attempt_at == null ? null : String(row.build_next_attempt_at),
  };
}

/**
 * Failed and retrying builds across tenants, most recently changed first, in a stable keyset order
 * (state_changed_at desc, request_id desc). A build that is retrying moves out of the list when its next attempt starts, so
 * a page walked while builds are running can miss one that was picked up in between; a failed build is final and never moves.
 */
export async function listTenantExportBuildIssues(db: PostgresSqlApi, query: TenantExportBuildIssueQuery): Promise<TenantExportBuildIssuePage> {
  const after = query.cursor ? decodeKeysetCursor(query.cursor) : null;
  const parameters: PostgresPrimitive[] = [];
  let where = STATUS_PREDICATE[query.status ?? "all"];
  if (after) {
    parameters.push(after.at, after.id);
    where += " and (r.state_changed_at, r.request_id) < ($1::timestamptz, $2::uuid)";
  }
  parameters.push(query.limit + 1);
  const rows = await db.query(`select r.tenant_id::text as tenant_id, coalesce(t.display_name, r.tenant_id::text) as tenant_name,
      r.request_id::text as request_id, r.state, r.build_attempts, r.last_error, r.requested_at, r.state_changed_at, r.build_next_attempt_at,
      ${keysetTimestampSql("r.state_changed_at")} as cursor_at
    from corvis_control.tenant_export_request r
    join corvis_control.tenant t on t.tenant_id = r.tenant_id
    where ${where}
    order by r.state_changed_at desc, r.request_id desc
    limit $${parameters.length}::integer`, parameters);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toIssue),
    nextCursor: rows.length > query.limit && last ? encodeKeysetCursor(String(last.cursor_at), String(last.request_id)) : null,
  };
}
