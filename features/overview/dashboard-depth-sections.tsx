"use client";

import { useEffect, useMemo, useState } from "react";
import type { ObservationRecord } from "@/core/contracts";
import type { WorkspaceDashboardSummary } from "@/core/workspace-dashboard";
import type { WorkspaceSummary } from "@/core/workspace-summary";
import { TimeSeriesChart } from "@/components/ui/charts/time-series-chart";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";
import { workspaceContextHeaders } from "@/lib/workspace-context";

type DrillPoint = { fundId: string; fund: string; period: string; snapshotId: string };

function moneyFormatter(currency: string | null): (value: number) => string {
  let format: Intl.NumberFormat;
  try { format = new Intl.NumberFormat(undefined, currency ? { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 } : { notation: "compact", maximumFractionDigits: 1 }); }
  catch { format = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }); }
  return (value) => format.format(value);
}

function timeLabel(value: string | null | undefined): string {
  if (!value) return "No successful sync yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function sourceStatusLabel(health: WorkspaceDashboardSummary["sourceHealth"][number]["health"]): string {
  if (health === "action_required") return "Action required";
  if (health === "degraded") return "Degraded";
  if (health === "paused") return "Paused";
  return "Healthy";
}

/**
 * New customer clients can overlap briefly with an older server/demo adapter
 * during rolling deployment. Depth sections must disappear in that window,
 * not crash the whole workspace or offer controls whose persistence endpoint
 * is not yet available.
 */
function isWorkspaceDashboardSummary(summary: WorkspaceSummary | null): summary is WorkspaceDashboardSummary {
  if (!summary) return false;
  const candidate = summary as Partial<WorkspaceDashboardSummary>;
  return Array.isArray(candidate.sourceHealth)
    && Array.isArray(candidate.personalization?.pinnedFundIds)
    && Boolean(candidate.digest && Array.isArray(candidate.digest.items))
    && Array.isArray(candidate.fundTrends)
    && Boolean(candidate.trendContributors && typeof candidate.trendContributors === "object");
}

export function DashboardDepthSections({
  summary,
  observations,
  canAdmin,
  onOpenSnapshotId,
  onOpenPositionFinancials,
  onSummaryChanged,
}: {
  summary: WorkspaceSummary | null;
  observations: ObservationRecord[];
  canAdmin: boolean;
  onOpenSnapshotId: (snapshotId: string | undefined, fund?: string) => void;
  onOpenPositionFinancials: (row: ObservationRecord) => void;
  onSummaryChanged?: () => void;
}) {
  const dashboard = isWorkspaceDashboardSummary(summary) ? summary : null;
  const [pinnedFundIds, setPinnedFundIds] = useState<string[]>(dashboard?.personalization.pinnedFundIds ?? []);
  const [compareFundIds, setCompareFundIds] = useState<string[]>([]);
  const [drill, setDrill] = useState<DrillPoint | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const formatMoney = moneyFormatter(dashboard?.currency ?? null);

  // Re-derive pinned/compare fund selection whenever a *new* dashboard snapshot
  // arrives, without calling setState from inside an effect body (which causes
  // cascading renders). Adjusting state during render, guarded by the snapshot's
  // own generatedAt, is React's documented alternative to a sync effect here.
  const [syncedGeneratedAt, setSyncedGeneratedAt] = useState(dashboard?.generatedAt);
  if (dashboard && dashboard.generatedAt !== syncedGeneratedAt) {
    setSyncedGeneratedAt(dashboard.generatedAt);
    setPinnedFundIds(dashboard.personalization.pinnedFundIds);
    const entitled = new Set(dashboard.fundTrends.map((series) => series.fundId));
    const stillValid = compareFundIds.filter((fundId) => entitled.has(fundId));
    if (stillValid.length < 2) {
      const preferred = dashboard.personalization.pinnedFundIds.filter((fundId) => entitled.has(fundId));
      const fallback = dashboard.fundTrends.map((series) => series.fundId);
      setCompareFundIds([...new Set([...preferred, ...fallback])].slice(0, Math.min(2, fallback.length)));
    }
  }

  // Advance the visit cursor only after the summary has mounted successfully.
  const generatedAt = dashboard?.generatedAt;
  useEffect(() => {
    if (!generatedAt) return;
    const controller = new AbortController();
    void fetch("/api/v1/workspace-preferences", {
      method: "POST",
      signal: controller.signal,
      headers: { ...workspaceContextHeaders(), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ seenAt: generatedAt }),
    }).catch(() => undefined);
    return () => controller.abort();
  }, [generatedAt]);

  const exactRows = useMemo(() => {
    if (!drill) return [];
    return observations.filter((row) =>
      (row.fundId === drill.fundId || (!row.fundId && row.fund === drill.fund)) && row.period === drill.period,
    ).sort((a, b) => `${a.company}:${a.metric}`.localeCompare(`${b.company}:${b.metric}`));
  }, [drill, observations]);

  if (!dashboard) return null;

  const exposureByFund = new Map(dashboard.exposure.items.map((item) => [item.fundId, item]));
  const pinned = pinnedFundIds.map((fundId) => exposureByFund.get(fundId)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const unhealthy = dashboard.sourceHealth.filter((source) => source.health === "degraded" || source.health === "action_required");

  const persistPins = async (next: string[]) => {
    const previous = pinnedFundIds;
    setPinnedFundIds(next);
    setPreferenceError(null);
    try {
      const response = await fetch("/api/v1/workspace-preferences", {
        method: "PUT",
        headers: { ...workspaceContextHeaders(), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ pinnedFundIds: next }),
      });
      if (!response.ok) throw new Error(`Preference update failed (${response.status})`);
      onSummaryChanged?.();
    } catch (reason) {
      setPinnedFundIds(previous);
      setPreferenceError(reason instanceof Error ? reason.message : "Could not save portfolio pins");
    }
  };

  const toggleCompare = (fundId: string) => setCompareFundIds((current) => current.includes(fundId) ? current.filter((id) => id !== fundId) : [...current, fundId]);

  const digestSection = <section className="panel" aria-labelledby="workspace-digest-heading">
    <div className="panel-heading"><div><p className="eyebrow">Since your last visit</p><h2 id="workspace-digest-heading">What changed</h2></div>{dashboard.digest.since && <span className="muted-time">Since {timeLabel(dashboard.digest.since)}</span>}</div>
    {dashboard.digest.since === null ? <div className="empty-row"><strong>Baseline established</strong><span>This is the first acknowledged visit for this workspace. Future visits will show new publishes, reconciliation changes and published value movements since this point.</span></div>
      : dashboard.digest.items.length === 0 ? <div className="empty-row"><strong>Nothing material changed</strong><span>No new fund-period publications, reconciliation exception changes or published value deltas were recorded since your last visit.</span></div>
      : <><p className="chart-description">{dashboard.digest.newPublishes} new publish{dashboard.digest.newPublishes === 1 ? "" : "es"} · {dashboard.digest.exceptionChanges} exception change{dashboard.digest.exceptionChanges === 1 ? "" : "s"} · {dashboard.digest.valueDeltas} value movement{dashboard.digest.valueDeltas === 1 ? "" : "s"}</p><div className="activity-list">{dashboard.digest.items.map((item) => <div className="activity-row" key={item.id}><span className="activity-marker" aria-hidden="true"></span><div><strong>{item.title}</strong><span>{item.detail}</span></div>{item.snapshotId && <button type="button" className="text-button" onClick={() => onOpenSnapshotId(item.snapshotId)}>Open <Icon name="arrow" size={14}/></button>}</div>)}</div></>}
  </section>;

  const sourceSection = <section className="panel" id="source-health" aria-labelledby="source-health-heading">
    <div className="panel-heading"><div><p className="eyebrow">Source health</p><h2 id="source-health-heading">Reporting feeds</h2></div><span className="muted-time">{unhealthy.length ? `${unhealthy.length} need attention` : `${dashboard.sourceHealth.length} healthy/available`}</span></div>
    {dashboard.sourceHealth.length ? <div className="snapshot-list">{dashboard.sourceHealth.map((source) => <div className="snapshot-row" key={source.sourceConnectionId}><div className="fund-mark" aria-hidden="true"><Icon name="database" size={16}/></div><div className="snapshot-main"><strong>{source.connectionLabel}</strong><span>{source.fundIds.length ? `${source.fundIds.length} entitled ${source.fundIds.length === 1 ? "fund" : "funds"}` : "Entitled source"} · last sync {timeLabel(source.lastSuccessAt)}</span></div><StatusPill status={sourceStatusLabel(source.health)} /><span className="muted-time">{source.consecutiveFailures ? `${source.consecutiveFailures} consecutive failure${source.consecutiveFailures === 1 ? "" : "s"}` : "No recent failures"}</span></div>)}</div>
      : <div className="empty-row"><strong>No connected-source history in scope</strong><span>Customer-safe health appears here after an entitled document has been acquired from a configured source. Credentials and secret references are never exposed.</span></div>}
  </section>;

  const adminLanding = canAdmin && <section className="panel" aria-labelledby="admin-landing-heading">
    <div className="panel-heading"><div><p className="eyebrow">Operations landing</p><h2 id="admin-landing-heading">Platform health first</h2></div><a className="text-button" href="#customer-overview">View customer Overview <Icon name="arrow" size={14}/></a></div>
    <div className="metric-grid" aria-label="Platform health summary"><div className={`metric-card ${unhealthy.length ? "warning" : ""}`}><div className="metric-head"><span>Source feeds</span><span className="metric-icon"><Icon name="database"/></span></div><strong>{unhealthy.length}</strong><p>need attention · {dashboard.sourceHealth.length} in customer-safe scope</p></div><div className={`metric-card ${dashboard.attention.counts.blocking_exception ? "warning" : ""}`}><div className="metric-head"><span>Blocking exceptions</span><span className="metric-icon"><Icon name="alert"/></span></div><strong>{dashboard.attention.counts.blocking_exception}</strong><p>across entitled reporting periods</p></div><div className={`metric-card ${dashboard.freshness.staleFunds ? "warning" : ""}`}><div className="metric-head"><span>Stale funds</span><span className="metric-icon"><Icon name="file"/></span></div><strong>{dashboard.freshness.staleFunds}</strong><p>past the {dashboard.freshness.staleAfterDays}-day publication window</p></div></div>
    {sourceSection}
  </section>;

  const myPortfolios = dashboard.exposure.items.length > 0 && <section className="panel" aria-labelledby="my-portfolios-heading">
    <div className="panel-heading"><div><p className="eyebrow">Personalized Overview</p><h2 id="my-portfolios-heading">My portfolios</h2></div><span className="muted-time">{pinned.length} pinned</span></div>
    {preferenceError && <div className="lineage-note tone-warning" role="alert"><Icon name="alert"/><div><strong>Pin was not saved</strong><span>{preferenceError}</span></div></div>}
    {pinned.length ? <div className="snapshot-list">{pinned.map((item) => <div className="snapshot-row" key={item.fundId}><div className="fund-mark" aria-hidden="true">{item.fund.split(" ").slice(0,2).map((word) => word[0]).join("")}</div><div className="snapshot-main"><strong>{item.fund}</strong><span>{item.period} · {item.metricCode === "nav" ? "NAV" : "fair value"}</span></div><b>{formatMoney(item.value)}</b><button type="button" className="text-button" onClick={() => void persistPins(pinnedFundIds.filter((id) => id !== item.fundId))}>Unpin</button></div>)}</div> : <div className="empty-row"><strong>No pinned funds yet</strong><span>Pin the funds you check most often. Pins are stored per signed-in user and workspace.</span></div>}
    <div className="snapshot-list" aria-label="Available funds to pin">{dashboard.exposure.items.filter((item) => !pinnedFundIds.includes(item.fundId)).map((item) => <div className="snapshot-row" key={item.fundId}><div className="snapshot-main"><strong>{item.fund}</strong><span>{item.period} · {formatMoney(item.value)}</span></div><button type="button" className="secondary-button" onClick={() => void persistPins([...pinnedFundIds, item.fundId])}>Pin fund</button></div>)}</div>
  </section>;

  const compareSeries = dashboard.fundTrends.filter((series) => compareFundIds.includes(series.fundId));
  const benchmark = dashboard.fundTrends.length >= 2 && <section className="panel" aria-labelledby="benchmark-heading">
    <div className="panel-heading"><div><p className="eyebrow">Cross-fund benchmark</p><h2 id="benchmark-heading">Compare published fund values</h2></div><span className="muted-time">Select 2+ funds · values are never silently summed</span></div>
    <div className="filter-row" role="group" aria-label="Funds to compare">{dashboard.fundTrends.map((series) => <label className="filter-chip" key={series.fundId}><input type="checkbox" checked={compareFundIds.includes(series.fundId)} onChange={() => toggleCompare(series.fundId)}/><span>{series.fund}</span></label>)}</div>
    {compareFundIds.length < 2 ? <div className="empty-row"><strong>Select at least two funds</strong><span>Each series stays independent; Corvis does not add operating or fund values across unlike entities.</span></div> : <div className="two-column overview-charts">{compareSeries.map((series) => <div className="chart-panel" key={series.fundId}><TimeSeriesChart eyebrow="Published value" title={series.fund} description="Published NAV where available, otherwise the governed fair-value rollup for that fund only." name={series.fund} unit={dashboard.currency ?? undefined} data={series.points.map((point) => ({ period: point.period, label: point.period, value: point.value, status: "final" as const }))} valueFormatter={formatMoney} onSelectPoint={(point) => { const match = series.points.find((candidate) => candidate.period === point.period); if (!match) return; setDrill({ fundId: series.fundId, fund: series.fund, period: match.period, snapshotId: match.snapshotId }); setTimeout(() => document.getElementById("trend-statement-drill")?.scrollIntoView({ block: "start", behavior: "smooth" }),0); }} selectLabel="Inspect exact period rows"/></div>)}</div>}
    {drill && <div id="trend-statement-drill" tabIndex={-1} className="panel attention-panel"><div className="panel-heading"><div><p className="eyebrow">Trend drill-through</p><h3>{drill.fund} · {drill.period}</h3></div><button type="button" className="text-button" onClick={() => onOpenSnapshotId(drill.snapshotId, drill.fund)}>Open aggregate evidence <Icon name="arrow" size={14}/></button></div><p className="chart-description">These are the entitled observation rows for the exact fund/period selected. The portfolio-value point itself is the published fund NAV when present, otherwise the governed fair-value rollup; position statement rows are not claimed to be NAV contributors.</p>{exactRows.length ? <ol className="attention-list">{exactRows.map((row) => <li key={row.id}><button type="button" className="attention-row" onClick={() => row.companyId ? onOpenPositionFinancials(row) : onOpenSnapshotId(row.snapshotId ?? drill.snapshotId, drill.fund)}><span className="snapshot-main"><strong>{row.company} · {row.metric}</strong><span>{row.value} · {row.source}</span></span><StatusPill status={row.state}/><span className="attention-action">{row.companyId ? "Open Position Financials" : "Open Data review"}<Icon name="chevron" size={14}/></span></button></li>)}</ol> : <div className="empty-row"><strong>No row-level observations for this period</strong><span>The published aggregate remains available through Data review evidence; no statement row is fabricated or inferred.</span></div>}</div>}
  </section>;

  if (canAdmin) return <>{adminLanding}{digestSection}{myPortfolios}{benchmark}</>;
  return <>{digestSection}{sourceSection}{myPortfolios}{benchmark}</>;
}
