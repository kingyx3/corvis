import type { ActivityRecord, FundSnapshot, View } from "@/core/contracts";
import type { AttentionItem, AttentionTarget, ExposureBreakdownRow, FundFreshness, WorkspaceSummary } from "@/core/workspace-summary";
import { CompositionChart } from "@/components/ui/charts/composition-chart";
import { TimeSeriesChart } from "@/components/ui/charts/time-series-chart";
import { Icon, type IconName } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

const ATTENTION_ICON: Record<AttentionItem["kind"], IconName> = {
  blocking_exception: "alert",
  needs_review: "table",
  stuck_document: "file",
  unhealthy_source: "database",
};
const SEVERITY_LABEL: Record<AttentionItem["severity"], string> = { blocking: "Blocking", high: "High", normal: "Normal" };

function moneyFormatter(currency: string | null): (value: number) => string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(undefined, currency ? { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 } : { notation: "compact", maximumFractionDigits: 1 });
  } catch {
    format = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  }
  return (value) => format.format(value);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function targetLabel(target: AttentionTarget): string {
  if (target.view === "documents") return "Open document";
  if (target.view === "admin") return "Manage in the admin console";
  return target.observationId ? "Review observations" : "Open in Data review";
}

export function OverviewView({
  snapshots,
  summary,
  activity,
  onNavigate,
  onUpload,
  onSnapshotSelect,
  onOpenSnapshotId,
  onOpenAttention,
  canUpload,
  canReadDocuments,
  canReadObservations,
  canResearch,
  canReview,
  canAdmin,
}: {
  snapshots: FundSnapshot[];
  summary: WorkspaceSummary | null;
  activity: ActivityRecord[];
  onNavigate: (view: View) => void;
  onUpload: () => void;
  onSnapshotSelect: (snapshot: FundSnapshot) => void;
  onOpenSnapshotId: (snapshotId: string | undefined, fund?: string) => void;
  onOpenAttention: (target: AttentionTarget) => void;
  canUpload: boolean;
  canReadDocuments: boolean;
  canReadObservations: boolean;
  canResearch: boolean;
  canReview: boolean;
  canAdmin: boolean;
}) {
  const published = snapshots.filter((snapshot) => snapshot.status === "Published").length;
  const review = snapshots.filter((snapshot) => snapshot.status === "Review").length;
  const factCount = snapshots.reduce((sum, snapshot) => sum + snapshot.facts, 0);
  const holdingCount = snapshots.reduce((sum, snapshot) => sum + snapshot.holdings, 0);
  const blockingExceptions = snapshots.reduce((sum, snapshot) => sum + (snapshot.blockingExceptions || 0), 0);
  const completion = snapshots.length ? Math.round((published / snapshots.length) * 100) : 0;
  const holdingsByFund = new Map<string, FundSnapshot>();
  for (const snapshot of snapshots) {
    const current = holdingsByFund.get(snapshot.fund);
    if (!current || snapshot.period > current.period) holdingsByFund.set(snapshot.fund, snapshot);
  }
  const holdingsItems = [...holdingsByFund.values()].map((snapshot) => ({ key: snapshot.fund, label: snapshot.fund, value: snapshot.holdings }));
  const audience = canAdmin ? "admin" : canReview ? "review" : "allocator";
  // Per the UX architecture, each role gets fundamentally different priority
  // content, not the same dashboard reordered: allocators see exposure first
  // (the default order below), Review Analysts see the review queue first
  // (reviewFirst reorders the existing metric cards and leads with the
  // attention surface), and administrators see tenant-wide platform health
  // first (a distinct panel, not a reorder).
  const reviewFirst = audience === "review";
  const statusComposition = [
    { key: "published", label: "Published", value: published },
    { key: "review", label: "In review", value: review },
  ];

  // The unified attention surface (A5) owns the headline count (A6) when the
  // rollup is available, so the number in the headline, the metric card and
  // the ranked list below are one and the same.
  const attention = summary?.attention;
  const attentionTotal = attention?.counts.total ?? review;
  const attentionHeadline = attention
    ? attentionTotal ? `${attentionTotal} ${attentionTotal === 1 ? "item needs" : "items need"} attention` : "All caught up"
    : review ? `${review} ${review === 1 ? "reporting period needs" : "reporting periods need"} attention` : "All caught up";
  const formatMoney = moneyFormatter(summary?.currency ?? null);
  const freshnessByFund = new Map<string, FundFreshness>((summary?.freshness.funds ?? []).map((row) => [row.fund, row]));
  const asOf = summary?.freshness.asOf ?? null;
  const staleFunds = summary?.freshness.staleFunds ?? 0;
  const asOfLabel = asOf ? `As of ${formatDate(asOf)}` : "No published period yet";
  const exposure = summary?.exposure;
  const trend = summary?.valueTrend ?? [];
  const focusAttention = () => {
    const section = document.getElementById("needs-attention");
    section?.scrollIntoView({ block: "start", behavior: "smooth" });
    section?.focus({ preventScroll: true });
  };

  const attentionCounts = attention ? [
    attention.counts.blocking_exception ? `${attention.counts.blocking_exception} blocking` : null,
    attention.counts.needs_review ? `${attention.counts.needs_review} to review` : null,
    attention.counts.stuck_document ? `${attention.counts.stuck_document} stuck ${attention.counts.stuck_document === 1 ? "document" : "documents"}` : null,
    attention.counts.unhealthy_source ? `${attention.counts.unhealthy_source} unhealthy ${attention.counts.unhealthy_source === 1 ? "source" : "sources"}` : null,
  ].filter(Boolean).join(" · ") : "";

  const attentionCard = <><div className="metric-head"><span>Needs attention</span><span className="metric-icon"><Icon name="alert" /></span></div><strong>{attentionTotal || "0"}</strong><p>{attention ? (attentionTotal ? attentionCounts : "All caught up") : review ? <><b>{blockingExceptions}</b> blocking exceptions</> : "All caught up"}</p></>;
  const attentionClassName = `metric-card ${attentionTotal || blockingExceptions ? "warning" : ""}`;

  const attentionSection = attention && <section className="panel attention-panel" id="needs-attention" tabIndex={-1} aria-labelledby="needs-attention-heading">
    <div className="panel-heading"><div><p className="eyebrow">Needs your attention</p><h2 id="needs-attention-heading">{attentionTotal ? `${attentionTotal} ${attentionTotal === 1 ? "item" : "items"}, most urgent first` : "All caught up"}</h2></div></div>
    {attention.items.length ? <ol className="attention-list">{attention.items.map((item) => { const body = <><span className={`attention-icon severity-${item.severity}`} aria-hidden="true"><Icon name={ATTENTION_ICON[item.kind]} size={16} /></span><span className="snapshot-main"><strong>{item.title}</strong><span>{item.detail}</span></span><StatusPill status={SEVERITY_LABEL[item.severity]} /><span className="attention-action">{targetLabel(item.target)}{item.target.view !== "admin" && <Icon name="chevron" size={14} />}</span></>;
      // Source connections are managed in the admin console on its own
      // hostname, so that item states where to act instead of linking.
      return <li key={item.id}>{item.target.view === "admin" ? <div className="attention-row static">{body}</div> : <button type="button" className="attention-row" onClick={() => onOpenAttention(item.target)} aria-label={`${item.title}: ${item.detail} ${targetLabel(item.target)}`}>{body}</button>}</li>; })}</ol>
      : <div className="empty-row"><strong>All caught up</strong><span>No blocking exceptions, observations awaiting review, stuck documents{canAdmin ? " or unhealthy sources" : ""}.</span></div>}
  </section>;

  const exposureSection = exposure && <section className="two-column overview-charts">
    <div className="panel chart-panel"><TimeSeriesChart eyebrow="Portfolio value" title="Published portfolio value" description={`Every fund at its latest published value (NAV, else summed holding fair value)${summary?.currency ? ` in ${summary.currency}` : ""} as of each period; a fund that has not reported a period yet is carried forward and the point is marked derived. Periods still in review are excluded until published.`} name="Portfolio value" unit={summary?.currency ?? undefined} data={trend.map((point) => ({ period: point.period, label: point.carriedForwardFunds ? `${point.period} · ${point.fundCount - point.carriedForwardFunds}/${point.fundCount} reported` : point.period, value: point.value, status: point.carriedForwardFunds ? "derived" as const : "final" as const }))} valueFormatter={formatMoney} onSelectPoint={(point) => { const match = trend.find((row) => row.period === point.period); if (match?.snapshotIds[0]) onOpenSnapshotId(match.snapshotIds[0]); }} selectLabel="Open period" /></div>
    <div className="panel chart-panel">
      {exposure.items.length ? <>
        <CompositionChart eyebrow="Exposure" title="Exposure by fund" description={`Each fund's latest published value; the total ${formatMoney(exposure.total)} is exactly the sum below.${exposure.excludedFundPeriods ? ` ${exposure.excludedFundPeriods} fund ${exposure.excludedFundPeriods === 1 ? "period" : "periods"} in another currency excluded.` : ""}`} items={exposure.items.map((item) => ({ key: item.fundId, label: item.fund, value: item.value }))} valueFormatter={formatMoney} unitLabel={summary?.currency ? `Value (${summary.currency})` : "Value"} />
        <ul className="exposure-list" aria-label="Exposure by fund, drill through to evidence">{exposure.items.map((item) => { const fresh = freshnessByFund.get(item.fund); return <li key={item.fundId}><button type="button" className="exposure-row" onClick={() => onOpenSnapshotId(item.snapshotId, item.fund)} aria-label={`${item.fund}: ${formatMoney(item.value)} as of ${item.period}. Open evidence in Data review`}><span className="snapshot-main"><strong>{item.fund}</strong><span>{item.period} · Final · {item.metricCode === "nav" ? "NAV" : "Sum of fair values"}</span></span><span className="status-stack">{fresh?.stale && <StatusPill status="Stale" />}</span><b>{formatMoney(item.value)}</b><span className="muted-time">{exposure.total ? `${((item.value / exposure.total) * 100).toFixed(0)}%` : "—"}</span><Icon name="chevron" size={14} /></button></li>; })}</ul>
      </> : holdingsItems.length > 0 ? <CompositionChart eyebrow="Exposure" title="Holdings by fund" description="No published fund value yet; showing how entitled holdings break down across the current reporting cycle." items={holdingsItems} unitLabel="Holdings" /> : <p className="chart-empty">No published exposure yet.</p>}
    </div>
  </section>;

  // The not-attributed remainder takes the chart's neutral "other" key so it
  // never reads as one more real category.
  const breakdownPanel = (rows: ExposureBreakdownRow[], eyebrow: string, title: string, description: string) => {
    const notAttributed = rows.find((row) => row.kind === "not_attributed");
    return <div className="panel chart-panel">
      <CompositionChart eyebrow={eyebrow} title={title} description={`${description} Rows sum exactly to the ${formatMoney(exposure?.total ?? 0)} exposure total${notAttributed ? `; ${formatMoney(notAttributed.value)} is not attributed to this dimension by any published fact` : ""}.`} items={rows.filter((row) => row.value > 0).map((row) => ({ key: row.kind === "not_attributed" ? "other" : row.key, label: row.label, value: row.value }))} valueFormatter={formatMoney} unitLabel={summary?.currency ? `Value (${summary.currency})` : "Value"} />
      {notAttributed && notAttributed.value < 0 && <p className="chart-description breakdown-note">Classified holdings exceed reported NAV by {formatMoney(-notAttributed.value)} (fund-level liabilities), shown as a negative not-attributed amount.</p>}
    </div>;
  };
  const breakdownSection = exposure && (exposure.byAssetType.length > 0 || exposure.bySector.length > 0) && <section className="two-column overview-charts" aria-label="Exposure breakdowns">
    {exposure.byAssetType.length > 0 && breakdownPanel(exposure.byAssetType, "Allocation", "Exposure by asset type", "Published holding fair values classified by each holding's governed instrument type.")}
    {exposure.bySector.length > 0 ? breakdownPanel(exposure.bySector, "Allocation", "Exposure by sector", "Sector breakdowns as reported by each GP; Corvis does not assign sectors itself.") : <div className="panel chart-panel"><figure className="chart-figure"><figcaption><p className="eyebrow">Allocation</p><h3>Exposure by sector</h3></figcaption><p className="chart-empty">No published fund reports a sector breakdown yet.</p></figure></div>}
  </section>;

  return <>
    <section className="hero-row"><div><p className="eyebrow">{audience === "admin" ? "Platform health" : "Current workspace"}</p><h1>Reporting overview · {attentionHeadline}</h1><p className="lede">{review ? `${review} ${review === 1 ? "period is" : "periods are"} waiting on review before publication.` : "No reporting periods currently require review."} {blockingExceptions ? `${blockingExceptions} blocking reconciliation ${blockingExceptions === 1 ? "exception is" : "exceptions are"} also open.` : ""} {snapshots.length ? `${published} of ${snapshots.length} fund periods are published (${completion}%).` : "No fund-period snapshots are available yet."}</p>{summary && <p className="freshness-note" role="note"><Icon name="check" size={14} />{asOfLabel} · published (final) data only{staleFunds ? <> · <b>{staleFunds} {staleFunds === 1 ? "fund is" : "funds are"} stale</b> (no period published within {summary.freshness.staleAfterDays} days)</> : ""}</p>}</div><div className="heading-actions">{canReadObservations && review > 0 && <button className="primary-button" onClick={() => onNavigate("review")}><Icon name="alert"/>Review now</button>}{canUpload && <button className={review > 0 ? "secondary-button" : "primary-button"} onClick={onUpload}><Icon name="upload" />Upload documents</button>}</div></section>
    {audience === "admin" && (published > 0 || review > 0) && <section className="panel"><CompositionChart eyebrow="Platform health" title="Fund periods by status" description="How every reporting period across the tenant currently breaks down between review and publication, independent of your own review queue." items={statusComposition} unitLabel="Fund periods" /></section>}
    <section className="metric-grid" aria-label={`Workspace metrics ordered for ${audience} workflow`}>
      {canReadObservations ? <button className="metric-card" style={{ order: reviewFirst ? 1 : 2 }} onClick={() => onNavigate("review")}><div className="metric-head"><span>Fund periods</span><span className="metric-icon"><Icon name="file" /></span></div><strong>{snapshots.length}</strong><p><b>{published}</b> final · <b>{review}</b> preliminary</p></button> : <div className="metric-card" style={{ order: reviewFirst ? 1 : 2 }}><div className="metric-head"><span>Fund periods</span><span className="metric-icon"><Icon name="file" /></span></div><strong>{snapshots.length}</strong><p><b>{published}</b> final · <b>{review}</b> preliminary</p></div>}
      {canReadObservations ? <button className="metric-card" style={{ order: reviewFirst ? 3 : 1 }} onClick={() => onNavigate("review")}><div className="metric-head"><span>{exposure?.items.length ? "Published exposure" : "Trusted facts"}</span><span className="metric-icon"><Icon name="database" /></span></div><strong>{exposure?.items.length ? formatMoney(exposure.total) : factCount.toLocaleString()}</strong><p>{exposure?.items.length ? <>{asOfLabel} · <b>{exposure.items.length}</b> {exposure.items.length === 1 ? "fund" : "funds"}</> : <>Across <b>{holdingCount.toLocaleString()}</b> holdings</>}</p></button> : <div className="metric-card" style={{ order: reviewFirst ? 3 : 1 }}><div className="metric-head"><span>Trusted facts</span><span className="metric-icon"><Icon name="database" /></span></div><strong>{factCount.toLocaleString()}</strong><p>Read-only summary</p></div>}
      {attention ? <button className={attentionClassName} style={{ order: reviewFirst ? 0 : 3 }} onClick={focusAttention} aria-controls="needs-attention">{attentionCard}</button> : canReadObservations ? <button className={attentionClassName} style={{ order: reviewFirst ? 0 : 3 }} onClick={() => onNavigate("review")}>{attentionCard}</button> : <div className={attentionClassName} style={{ order: reviewFirst ? 0 : 3 }}>{attentionCard}</div>}
      {canReadObservations ? <button className="metric-card" style={{ order: reviewFirst ? 2 : 4 }} onClick={() => onNavigate("review")}><div className="metric-head"><span>Published snapshots</span><span className="metric-icon"><Icon name="check" /></span></div><strong>{published}</strong><p><b>{completion}%</b> of current workspace periods{summary ? <> · {asOfLabel}</> : null}</p></button> : <div className="metric-card" style={{ order: reviewFirst ? 2 : 4 }}><div className="metric-head"><span>Published snapshots</span><span className="metric-icon"><Icon name="check" /></span></div><strong>{published}</strong><p><b>{completion}%</b> of current workspace periods</p></div>}
    </section>
    {reviewFirst || audience === "admin" ? <>{attentionSection}{exposureSection}{breakdownSection}</> : <>{exposureSection}{breakdownSection}{attentionSection}</>}
    {!exposure && holdingsItems.length > 0 && <section className="panel"><CompositionChart eyebrow="Exposure" title="Holdings by fund" description="How your entitled fund holdings break down across the current reporting cycle." items={holdingsItems} unitLabel="Holdings" /></section>}
    <section className="two-column"><div className="panel"><div className="panel-heading"><div><p className="eyebrow">Fund periods</p><h2>Current reporting cycle</h2></div>{canReadDocuments && <button className="text-button" onClick={() => onNavigate("documents")}>View documents <Icon name="arrow" size={15}/></button>}</div><div className="snapshot-list">{snapshots.length ? snapshots.map((item) => { const fresh = freshnessByFund.get(item.fund); const stale = item.status === "Published" && fresh?.stale === true && fresh.snapshotId === item.id; const detail = <><strong>{item.fund}</strong><span>{item.period} · {item.status === "Published" ? "Final" : "Preliminary"} · {item.holdings} holdings · {item.facts} facts</span></>; return canReadObservations ? <button className="snapshot-row" key={`${item.id || item.fund}-${item.period}`} onClick={() => onSnapshotSelect(item)} aria-label={`Open ${item.fund} ${item.period}`}><div className="fund-mark" aria-hidden="true">{item.fund.split(" ").slice(0,2).map((word) => word[0]).join("")}</div><div className="snapshot-main">{detail}</div><span className="status-stack"><StatusPill status={item.status}/>{stale && <StatusPill status="Stale"/>}</span><span className="muted-time">{item.changed}</span><Icon name="chevron" size={16}/></button> : <div className="snapshot-row" key={`${item.id || item.fund}-${item.period}`}><div className="fund-mark" aria-hidden="true">{item.fund.split(" ").slice(0,2).map((word) => word[0]).join("")}</div><div className="snapshot-main">{detail}</div><span className="status-stack"><StatusPill status={item.status}/>{stale && <StatusPill status="Stale"/>}</span><span className="muted-time">{item.changed}</span></div>; }) : <div className="empty-row"><strong>No snapshots yet</strong><span>{canUpload ? "Upload a source document to start a reporting cycle." : "No entitled fund-period snapshots are available."}</span></div>}</div></div><div className="panel activity-panel"><div className="panel-heading"><div><p className="eyebrow">Activity</p><h2>What changed</h2></div></div><div className="activity-list">{activity.length ? activity.map((item, i) => <div className="activity-row" key={`${item.title}-${item.time}`}><span className={`activity-marker marker-${i % 4}`} aria-hidden="true"></span><div><strong>{item.title}</strong><span>{item.detail}</span></div><time>{item.time}</time></div>) : <div className="activity-row empty"><div><strong>No recent activity</strong><span>Production activity appears here when audit/read-model events are available.</span></div></div>}</div></div></section>
    {canResearch && <button type="button" className="research-callout" onClick={() => onNavigate("research")}><span className="research-symbol" aria-hidden="true"><Icon name="spark" size={22}/></span><span className="research-callout-text"><span className="eyebrow">Ask Corvis</span><span className="research-callout-title">What changed in my portfolio this quarter?</span><span className="research-callout-detail">Query trusted fund data and source documents together, with evidence.</span></span><span className="research-arrow" aria-hidden="true"><Icon name="arrow"/></span></button>}
  </>;
}
