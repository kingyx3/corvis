import type { ActivityRecord, FundSnapshot, View } from "@/core/contracts";
import { CompositionChart } from "@/components/ui/charts/composition-chart";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

export function OverviewView({
  snapshots,
  activity,
  onNavigate,
  onUpload,
  onSnapshotSelect,
  canUpload,
  canReadDocuments,
  canReadObservations,
  canResearch,
  canReview,
  canAdmin,
}: {
  snapshots: FundSnapshot[];
  activity: ActivityRecord[];
  onNavigate: (view: View) => void;
  onUpload: () => void;
  onSnapshotSelect: (snapshot: FundSnapshot) => void;
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
  const compositionItems = [...holdingsByFund.values()].map((snapshot) => ({ key: snapshot.fund, label: snapshot.fund, value: snapshot.holdings }));
  const audience = canAdmin ? "admin" : canReview ? "review" : "allocator";
  const reviewFirst = audience !== "allocator";
  const attentionHeadline = review ? `${review} ${review === 1 ? "reporting period needs" : "reporting periods need"} attention` : "All caught up";

  return <>
    <section className="hero-row"><div><p className="eyebrow">Current workspace</p><h1>Reporting overview · {attentionHeadline}</h1><p className="lede">{review ? `${review} ${review === 1 ? "period is" : "periods are"} waiting on review before publication.` : "No reporting periods currently require review."} {blockingExceptions ? `${blockingExceptions} blocking reconciliation ${blockingExceptions === 1 ? "exception is" : "exceptions are"} also open.` : ""} {snapshots.length ? `${published} of ${snapshots.length} fund periods are published (${completion}%).` : "No fund-period snapshots are available yet."}</p></div><div className="heading-actions">{canReadObservations && review > 0 && <button className="primary-button" onClick={() => onNavigate("review")}><Icon name="alert"/>Review now</button>}{canUpload && <button className={review > 0 ? "secondary-button" : "primary-button"} onClick={onUpload}><Icon name="upload" />Upload documents</button>}</div></section>
    <section className="metric-grid" aria-label={`Workspace metrics ordered for ${audience} workflow`}>
      <div className="metric-card" style={{ order: reviewFirst ? 1 : 2 }}><div className="metric-head"><span>Fund periods</span><span className="metric-icon"><Icon name="file" /></span></div><strong>{snapshots.length}</strong><p><b>{published}</b> published</p></div>
      {canReadObservations ? <button className="metric-card" style={{ order: reviewFirst ? 3 : 1 }} onClick={() => onNavigate("review")}><div className="metric-head"><span>Trusted facts</span><span className="metric-icon"><Icon name="database" /></span></div><strong>{factCount.toLocaleString()}</strong><p>Across <b>{holdingCount.toLocaleString()}</b> holdings</p></button> : <div className="metric-card" style={{ order: reviewFirst ? 3 : 1 }}><div className="metric-head"><span>Trusted facts</span><span className="metric-icon"><Icon name="database" /></span></div><strong>{factCount.toLocaleString()}</strong><p>Read-only summary</p></div>}
      {canReadObservations ? <button className={`metric-card ${review || blockingExceptions ? "warning" : ""}`} style={{ order: reviewFirst ? 0 : 3 }} onClick={() => onNavigate("review")}><div className="metric-head"><span>Needs attention</span><span className="metric-icon"><Icon name="alert" /></span></div><strong>{review || "0"}</strong><p>{review ? <><b>{blockingExceptions}</b> blocking exceptions</> : "All caught up"}</p></button> : <div className={`metric-card ${review || blockingExceptions ? "warning" : ""}`} style={{ order: reviewFirst ? 0 : 3 }}><div className="metric-head"><span>Needs attention</span><span className="metric-icon"><Icon name="alert" /></span></div><strong>{review || "0"}</strong><p>{review ? <><b>{blockingExceptions}</b> blocking exceptions</> : "All caught up"}</p></div>}
      <div className="metric-card" style={{ order: reviewFirst ? 2 : 4 }}><div className="metric-head"><span>Published snapshots</span><span className="metric-icon"><Icon name="check" /></span></div><strong>{published}</strong><p><b>{completion}%</b> of current workspace periods</p></div>
    </section>
    {compositionItems.length > 0 && <section className="panel"><CompositionChart eyebrow="Exposure" title="Holdings by fund" description="How your entitled fund holdings break down across the current reporting cycle." items={compositionItems} unitLabel="Holdings" /></section>}
    <section className="two-column"><div className="panel"><div className="panel-heading"><div><p className="eyebrow">Fund periods</p><h2>Current reporting cycle</h2></div>{canReadDocuments && <button className="text-button" onClick={() => onNavigate("documents")}>View documents <Icon name="arrow" size={15}/></button>}</div><div className="snapshot-list">{snapshots.length ? snapshots.map((item) => canReadObservations ? <button className="snapshot-row" key={`${item.id || item.fund}-${item.period}`} onClick={() => onSnapshotSelect(item)} aria-label={`Open ${item.fund} ${item.period}`}><div className="fund-mark" aria-hidden="true">{item.fund.split(" ").slice(0,2).map((word) => word[0]).join("")}</div><div className="snapshot-main"><strong>{item.fund}</strong><span>{item.period} · {item.holdings} holdings · {item.facts} facts</span></div><StatusPill status={item.status}/><span className="muted-time">{item.changed}</span><Icon name="chevron" size={16}/></button> : <div className="snapshot-row" key={`${item.id || item.fund}-${item.period}`}><div className="fund-mark" aria-hidden="true">{item.fund.split(" ").slice(0,2).map((word) => word[0]).join("")}</div><div className="snapshot-main"><strong>{item.fund}</strong><span>{item.period} · {item.holdings} holdings · {item.facts} facts</span></div><StatusPill status={item.status}/><span className="muted-time">{item.changed}</span></div>) : <div className="empty-row"><strong>No snapshots yet</strong><span>{canUpload ? "Upload a source document to start a reporting cycle." : "No entitled fund-period snapshots are available."}</span></div>}</div></div><div className="panel activity-panel"><div className="panel-heading"><div><p className="eyebrow">Activity</p><h2>What changed</h2></div></div><div className="activity-list">{activity.length ? activity.map((item, i) => <div className="activity-row" key={`${item.title}-${item.time}`}><span className={`activity-marker marker-${i % 4}`} aria-hidden="true"></span><div><strong>{item.title}</strong><span>{item.detail}</span></div><time>{item.time}</time></div>) : <div className="activity-row empty"><div><strong>No recent activity</strong><span>Production activity appears here when audit/read-model events are available.</span></div></div>}</div></div></section>
    {canResearch && <button type="button" className="research-callout" onClick={() => onNavigate("research")}><span className="research-symbol" aria-hidden="true"><Icon name="spark" size={22}/></span><span className="research-callout-text"><span className="eyebrow">Ask Corvis</span><span className="research-callout-title">What changed in my portfolio this quarter?</span><span className="research-callout-detail">Query trusted fund data and source documents together, with evidence.</span></span><span className="research-arrow" aria-hidden="true"><Icon name="arrow"/></span></button>}
  </>;
}