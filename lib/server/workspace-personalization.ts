import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type WorkspacePersonalization = {
  pinnedFundIds: string[];
  lastSeenAt: string | null;
};

export class WorkspacePersonalizationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.name = "WorkspacePersonalizationError";
    this.code = code;
    this.status = status;
  }
}

const MAX_PINS = 100;

function dbDefault(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }
function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}
function allowedFunds(identity: RequestIdentity): Set<string> { return new Set(identity.entitlements.fundIds ?? []); }

/**
 * Returns only preferences still permitted by the caller's current fund
 * entitlement. Revoking fund access therefore removes a stale pin from every
 * response immediately even before the stored preference is rewritten.
 */
export async function getWorkspacePersonalization(
  identity: RequestIdentity,
  db: PostgresSqlApi = dbDefault(),
): Promise<WorkspacePersonalization> {
  if (getServerConfig().demoMode || identity.authMethod === "demo") return { pinnedFundIds: [], lastSeenAt: null };
  const rows = await db.query(`select pinned_fund_ids,last_seen_at
      from corvis_control.workspace_user_preference
      where tenant_id=$1::uuid and workspace_id=$2::uuid and auth_method=$3 and subject=$4
      limit 1`, [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject]);
  const row = rows[0];
  if (!row) return { pinnedFundIds: [], lastSeenAt: null };
  const allowed = allowedFunds(identity);
  return {
    pinnedFundIds: strings(row.pinned_fund_ids).filter((fundId) => allowed.has(fundId)),
    lastSeenAt: iso(row.last_seen_at),
  };
}

export function normalizePinnedFundIds(identity: RequestIdentity, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PINS) throw new WorkspacePersonalizationError("invalid_pinned_funds");
  const allowed = allowedFunds(identity);
  const normalized: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) throw new WorkspacePersonalizationError("invalid_pinned_funds");
    const fundId = raw.trim();
    if (!allowed.has(fundId)) throw new WorkspacePersonalizationError("fund_not_entitled", 403);
    if (!normalized.includes(fundId)) normalized.push(fundId);
  }
  return normalized;
}

/** Upserts pins without advancing the last-visit cursor. */
export async function updatePinnedFunds(
  identity: RequestIdentity,
  pinnedFundIds: string[],
  db: PostgresSqlApi = dbDefault(),
): Promise<WorkspacePersonalization> {
  if (getServerConfig().demoMode || identity.authMethod === "demo") return { pinnedFundIds, lastSeenAt: null };
  const rows = await db.query(`insert into corvis_control.workspace_user_preference
      (tenant_id,workspace_id,auth_method,subject,pinned_fund_ids,created_at,updated_at)
    values ($1::uuid,$2::uuid,$3,$4,$5::text[],now(),now())
    on conflict (tenant_id,workspace_id,auth_method,subject) do update
      set pinned_fund_ids=excluded.pinned_fund_ids,updated_at=now()
    returning pinned_fund_ids,last_seen_at`,
  [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject, `{${pinnedFundIds.map((id) => `"${id.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`]);
  const row: PostgresRow | undefined = rows[0];
  return { pinnedFundIds: strings(row?.pinned_fund_ids), lastSeenAt: iso(row?.last_seen_at) };
}

/**
 * Advances the visit cursor monotonically. A delayed/retried browser request
 * cannot move it backwards and resurrect already-acknowledged digest items.
 */
export async function markWorkspaceVisited(
  identity: RequestIdentity,
  seenAt: Date,
  db: PostgresSqlApi = dbDefault(),
): Promise<string | null> {
  if (getServerConfig().demoMode || identity.authMethod === "demo") return seenAt.toISOString();
  const rows = await db.query(`insert into corvis_control.workspace_user_preference
      (tenant_id,workspace_id,auth_method,subject,last_seen_at,created_at,updated_at)
    values ($1::uuid,$2::uuid,$3,$4,$5::timestamptz,now(),now())
    on conflict (tenant_id,workspace_id,auth_method,subject) do update
      set last_seen_at=greatest(corvis_control.workspace_user_preference.last_seen_at,excluded.last_seen_at),updated_at=now()
    returning last_seen_at`,
  [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject, seenAt.toISOString()]);
  return iso(rows[0]?.last_seen_at);
}
