import type { ActivityRecord, FundSnapshot, View } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

export function OverviewView({
  snapshots,
  activity,
  userName,
  documentCount,
  trustedObservations,
  needsReview,
  onNavigate,
  onUpload,
}: {
  snapshots: FundSnapshot[];
  activity: ActivityRecord[];
  userName?: string;
  documentCount: number;
  trustedObservations: number;
  needsReview: number;
  onNavigate: (view: View) => void;
  onUpload: () => void;
}) {
  const published = snapshots.filter((snapshot) => snapshot.status === "Published").length;
  const firstName = userName?.split(/\s+/)[0] || "there";
  const attention = snapshots.filter((snapshot) => snapshot.status === "Review").length;
  const completion = snapshots.length ? Math.round((published / snapshots.length) * 100) : 0;
  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(new Date()).toUpperCase();

  return <>
    <section className="hero-row"><div><p className="eyebrow">{date}</p><h1>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, {firstName}.</h1><p className="lede">Your current reporting cycle is {completion}% published. {attention === 0 ? "No fund periods need publication attention." : `${attention} fund period${attention === 1 ? "" : "s"} still ${attention === 1 ? "needs" : "need"} attention.`}</p></div><button className="primary-button" onClick={onUpload}><Icon name="upload" />Upload documents</button></section>
    <section className="metric-grid">
      <button className="metric-card" onClick={() => onNavigate("documents")}><div className="metric-head"><span>Documents</span><span className="metric-icon"><Icon name="file" /></span></div><strong>{documentCount.toLocaleString()}</strong><p>Current entitled workspace</p></button>
      <button className="metric-card" onClick={() => onNavigate("review")}><div className="metric-head"><span>Trusted observations</span><span className="metric-icon"><Icon name="database" /></span></div><strong>{trustedObservations.toLocaleString()}</strong><p>Approved for use</p></button>
      <button className={`metric-card ${needsReview > 0 ? "warning" : ""}`} onClick={() => onNavigate("review")}><div className="metric-head"><span>Needs review</span><span className="metric-icon"><Icon name="alert" /></span></div><strong>{needsReview.toLocaleString()}</strong><p>Human decisions outstanding</p></button>
      <div className="metric-card"><div className="metric-head"><span>Published snapshots</span><span className="metric-icon"><Icon name="check" /></span></div><strong>{published.toLocaleString()}</strong><p>Versioned fund periods</p></div>
    </section>
    <section className="two-column"><div className="panel"><div className="panel-heading"><div><p className="eyebrow">FUND PERIODS</p><h2>Current reporting cycle</h2></div><button className="text-button" onClick={() => onNavigate("documents")}>View all <Icon name="arrow" size={15}/></button></div><div className="snapshot-list">{snapshots.length === 0 ? <p className="lede">No fund-period snapshots are available yet.</p> : snapshots.map((item) => <div className="snapshot-row" key={item.id || `${item.fund}-${item.period}`}><div className="fund-mark">{item.fund.split(" ").slice(0,2).map((word) => word[0]).join("")}</div><div className="snapshot-main"><strong>{item.fund}</strong><span>{item.period} · {item.holdings} holdings · {item.facts} facts</span></div><StatusPill status={item.status}/><span className="muted-time">{item.changed}</span><Icon name="chevron" size={16}/></div>)}</div></div><div className="panel activity-panel"><div className="panel-heading"><div><p className="eyebrow">ACTIVITY</p><h2>What changed</h2></div></div><div className="activity-list">{activity.length === 0 ? <p className="lede">No recent audited activity.</p> : activity.map((item, i) => <div className="activity-row" key={`${item.title}-${item.time}-${i}`}><span className={`activity-marker marker-${i}`}></span><div><strong>{item.title}</strong><span>{item.detail}</span></div><time>{item.time}</time></div>)}</div></div></section>
    <button className="research-callout" onClick={() => onNavigate("research")}><div className="research-symbol"><Icon name="spark" size={22}/></div><div><p className="eyebrow">ASK CORVIS</p><h3>What changed in my portfolio this quarter?</h3><p>Query governed fund data and permissioned source documents together, with evidence.</p></div><div className="research-arrow"><Icon name="arrow"/></div></button>
  </>;
}
