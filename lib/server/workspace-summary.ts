import { hasPermission, type RequestIdentity } from "../../core/enterprise.ts";
import {
  buildFundTrends,
  buildTrendContributors,
  buildWorkspaceDigest,
  type DashboardSourceHealth,
  type ExceptionDigestEvent,
  type WorkspaceDashboardSummary,
} from "../../core/workspace-dashboard.ts";
import { buildWorkspaceSummary, type SourceHealthInput } from "../../core/workspace-summary.ts";
import { getServerConfig } from "./config.ts";
import { platform as defaultPlatform, type PlatformPort } from "./platform.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { getWorkspacePersonalization, type WorkspacePersonalization } from "./workspace-personalization.ts";

export type WorkspaceSummaryDependencies = {
  platform?: PlatformPort;
  /** Legacy test seam: customer-safe source inputs without fund attribution. */
  sources?: (identity: RequestIdentity) => Promise<SourceHealthInput[]>;
  sourceHealth?: (identity: RequestIdentity) => Promise<DashboardSourceHealth[]>;
  personalization?: (identity: RequestIdentity) => Promise<WorkspacePersonalization>;
  exceptionEvents?: (identity: RequestIdentity, since: string | null) => Promise<ExceptionDigestEvent[]>;
  now?: Date;
};

function dbDefault(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }
function text(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}
function integer(row: PostgresRow, key: string): number {
  const parsed = Number(row[key] ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}
function postgresTextArrayLiteral(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`).join(",")}}`;
}

function sourceHealthStatus(status: string, failures: number): DashboardSourceHealth["health"] {
  if (status === "paused") return "paused";
  if (status === "reauthorization_required" || status === "suspended") return "action_required";
  if (status === "active" && failures > 0) return "degraded";
  return "healthy";
}

/**
 * Customer-safe source projection. The secret reference, credential type,
 * confirmed scope and operator metadata are never selected. Fund attribution
 * is inferred only through acquired documents -> source references -> facts
 * the caller is currently entitled to, so revoked fund access cannot leak a
 * historical source/fund relationship through Overview.
 */
async function workspaceSourceHealth(identity: RequestIdentity, db?: PostgresSqlApi): Promise<DashboardSourceHealth[]> {
  if (getServerConfig().demoMode || identity.authMethod === "demo") return [];
  const fundIds = identity.entitlements.fundIds ?? [];
  if (fundIds.length === 0) return [];
  // db is a lazy default: constructing it eagerly (as a default parameter
  // expression) would call postgres() and throw before the demo-mode/no-
  // entitlement early returns above ever get a chance to run.
  const database = db ?? dbDefault();
  const rows = await database.query(`select c.source_connection_id,c.connection_label,c.status,c.consecutive_failures,c.last_success_at,
      array_remove(array_agg(distinct o.fund_id),null) as fund_ids
    from corvis_source.source_connection c
    join corvis_source.acquired_document a
      on a.tenant_id=c.tenant_id and a.source_connection_id=c.source_connection_id
    join corvis_source.source_reference sr
      on sr.tenant_id=a.tenant_id and sr.document_id=a.document_id
    join corvis_facts.observation o
      on o.tenant_id=sr.tenant_id and o.source_reference_id=sr.source_reference_id
         and o.fund_id=any($3::text[])
    where c.tenant_id=$1::uuid and c.workspace_id=$2::uuid and c.status <> 'revoked'
    group by c.source_connection_id,c.connection_label,c.status,c.consecutive_failures,c.last_success_at,c.created_at
    order by c.created_at desc`,
  [identity.tenantId, identity.workspaceId, postgresTextArrayLiteral(fundIds)]);
  return rows.map((row) => {
    const failures = integer(row, "consecutive_failures");
    const status = text(row, "status") ?? "active";
    return {
      sourceConnectionId: text(row, "source_connection_id") ?? "",
      connectionLabel: text(row, "connection_label") ?? "Source",
      status,
      health: sourceHealthStatus(status, failures),
      consecutiveFailures: failures,
      lastSuccessAt: text(row, "last_success_at") ?? null,
      fundIds: strings(row.fund_ids).filter((fundId) => fundIds.includes(fundId)),
    };
  }).filter((row) => row.sourceConnectionId);
}

async function workspaceExceptionEvents(identity: RequestIdentity, since: string | null, db?: PostgresSqlApi): Promise<ExceptionDigestEvent[]> {
  if (!since || getServerConfig().demoMode || identity.authMethod === "demo") return [];
  const fundIds = identity.entitlements.fundIds ?? [];
  if (fundIds.length === 0) return [];
  const database = db ?? dbDefault();
  const encodedFunds = postgresTextArrayLiteral(fundIds);
  const rows = await database.query(`
    select e.exception_id::text as event_id,'exception_opened' as event_kind,e.fund_id,e.report_period,e.summary,e.created_at
    from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=$1::uuid and e.fund_id=any($2::text[]) and e.created_at > $3::timestamptz
    union all
    select r.resolution_event_id::text as event_id,'exception_resolved' as event_kind,e.fund_id,e.report_period,e.summary,r.created_at
    from corvis_consolidated.reconciliation_resolution_event r
    join corvis_consolidated.reconciliation_exception e
      on e.tenant_id=r.tenant_id and e.exception_id=r.exception_id
    where r.tenant_id=$1::uuid and e.fund_id=any($2::text[]) and r.created_at > $3::timestamptz
    order by created_at desc`, [identity.tenantId, encodedFunds, since]);
  return rows.map((row) => ({
    id: text(row, "event_id") ?? "",
    kind: (text(row, "event_kind") === "exception_resolved" ? "exception_resolved" : "exception_opened") as ExceptionDigestEvent["kind"],
    fundId: text(row, "fund_id") ?? "",
    period: text(row, "report_period") ?? "",
    summary: text(row, "summary") ?? "Reconciliation status changed",
  })).filter((event) => event.id && event.fundId);
}

/**
 * Composes the Overview summary from entitlement-scoped reads. Customer-safe
 * connector health is deliberately separate from the privileged connector
 * administration API. Personalization is a user/workspace UX state only and
 * is re-filtered through current fund entitlements before it reaches this read
 * model.
 */
export async function workspaceSummary(identity: RequestIdentity, dependencies: WorkspaceSummaryDependencies = {}): Promise<WorkspaceDashboardSummary> {
  const port = dependencies.platform ?? defaultPlatform();
  const now = dependencies.now ?? new Date();
  const sourcePromise: Promise<DashboardSourceHealth[]> = dependencies.sourceHealth
    ? dependencies.sourceHealth(identity)
    : dependencies.sources
      ? dependencies.sources(identity).then((rows) => rows.map((source) => ({
          sourceConnectionId: source.sourceConnectionId,
          connectionLabel: source.connectionLabel,
          status: source.status,
          health: sourceHealthStatus(source.status, source.consecutiveFailures),
          consecutiveFailures: source.consecutiveFailures,
          lastSuccessAt: source.lastSuccessAt ?? null,
          fundIds: [],
        })))
      : workspaceSourceHealth(identity);
  const personalizationPromise = (dependencies.personalization ?? getWorkspacePersonalization)(identity);

  const [snapshots, observations, documents, valueFacts, dimensionFacts, sourceHealth, personalization] = await Promise.all([
    port.listSnapshots(identity),
    port.listObservations(identity),
    hasPermission(identity, "documents:read") ? port.listDocuments(identity) : Promise.resolve([]),
    port.portfolioValueFacts(identity),
    port.exposureDimensionFacts(identity),
    sourcePromise,
    personalizationPromise,
  ]);

  const attentionSources: SourceHealthInput[] = sourceHealth.map((source) => ({
    sourceConnectionId: source.sourceConnectionId,
    connectionLabel: source.connectionLabel,
    status: source.status,
    consecutiveFailures: source.consecutiveFailures,
    lastSuccessAt: source.lastSuccessAt ?? undefined,
  }));
  const base = buildWorkspaceSummary({ snapshots, observations, documents, valueFacts, dimensionFacts, sources: attentionSources, now });
  const fundTrends = buildFundTrends(valueFacts, base.currency);
  const trendContributors = buildTrendContributors(fundTrends, base.valueTrend.map((point) => point.period));
  const exceptionEvents = await (dependencies.exceptionEvents ?? workspaceExceptionEvents)(identity, personalization.lastSeenAt);
  const fundNames = new Map(fundTrends.map((series) => [series.fundId, series.fund]));
  for (const event of exceptionEvents) event.fund = fundNames.get(event.fundId);

  return {
    ...base,
    sourceHealth,
    personalization: { pinnedFundIds: personalization.pinnedFundIds },
    digest: buildWorkspaceDigest({ lastSeenAt: personalization.lastSeenAt, snapshots, fundTrends, exceptionEvents, currency: base.currency }),
    fundTrends,
    trendContributors,
  };
}
