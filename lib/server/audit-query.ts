import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type AuditQuery = {
  limit?: number;
  action?: string;
  actor?: string;
  targetType?: string;
  outcome?: string;
  after?: string;
  before?: string;
};

export type AuditRecord = {
  id: string;
  occurredAt: string;
  workspaceId?: string;
  actorSubject: string;
  action: string;
  targetType: string;
  targetId?: string;
  outcome: string;
  correlationId: string;
};

function value(row: PostgresRow, key: string): string | undefined {
  const raw = row[key];
  if (raw == null) return undefined;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}

function boundedLimit(input?: number): number {
  if (!Number.isFinite(input)) return 100;
  return Math.max(1, Math.min(200, Math.trunc(input ?? 100)));
}

function timestamp(input: string | undefined, name: string): string | undefined {
  if (!input) return undefined;
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) throw new Error(`invalid_${name}`);
  return new Date(parsed).toISOString();
}

export async function listAuditRecords(
  identity: RequestIdentity,
  query: AuditQuery = {},
  db: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<AuditRecord[]> {
  const after = timestamp(query.after, "after");
  const before = timestamp(query.before, "before");
  const rows = await db.query(`select audit_event_id, occurred_at, workspace_id, actor_subject, action,
      target_type, target_id, outcome, correlation_id
    from corvis_control.audit_event
    where tenant_id=$1
      and ($2::text is null or action=$2)
      and ($3::text is null or actor_subject=$3)
      and ($4::text is null or target_type=$4)
      and ($5::text is null or outcome=$5)
      and ($6::timestamptz is null or occurred_at >= $6::timestamptz)
      and ($7::timestamptz is null or occurred_at <= $7::timestamptz)
    order by occurred_at desc, audit_event_id desc
    limit $8`, [
      identity.tenantId,
      query.action?.trim() || null,
      query.actor?.trim() || null,
      query.targetType?.trim() || null,
      query.outcome?.trim() || null,
      after ?? null,
      before ?? null,
      boundedLimit(query.limit),
    ]);

  return rows.map((row) => ({
    id: value(row, "audit_event_id") ?? "",
    occurredAt: value(row, "occurred_at") ?? "",
    workspaceId: value(row, "workspace_id"),
    actorSubject: value(row, "actor_subject") ?? "",
    action: value(row, "action") ?? "",
    targetType: value(row, "target_type") ?? "",
    targetId: value(row, "target_id"),
    outcome: value(row, "outcome") ?? "",
    correlationId: value(row, "correlation_id") ?? "",
  }));
}
