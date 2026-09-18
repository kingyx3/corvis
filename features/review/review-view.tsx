"use client";

import { useState } from "react";
import type { ObservationRecord } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

export function ReviewView({ observations }: { observations: ObservationRecord[] }) {
  const [onlyReview, setOnlyReview] = useState(false);
  const visible = onlyReview ? observations.filter((row) => row.state === "Needs review") : observations;
  const exportCsv = () => {
    const header = ["Company","Metric","Value","Period","Source","Confidence","State"];
    const rows = observations.map((row) => [row.company,row.metric,row.value,row.period,row.source,`${row.confidence}%`,row.state]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "corvis-advent-viii-q2-2026.csv"; link.click(); URL.revokeObjectURL(url);
  };
  const needsReview = observations.filter((row) => row.state === "Needs review").length;
  return <>
    <section className="page-heading"><div><p className="eyebrow">TRUSTED DATA</p><h1>Data review</h1><p className="lede">Advent International GPE VIII · Q2 2026 · Snapshot v2</p></div><div className="heading-actions"><button className="secondary-button" onClick={exportCsv}><Icon name="download"/>Export CSV</button><button className="primary-button"><Icon name="check"/>Publish snapshot</button></div></section>
    <div className="review-summary"><div><span>Observations</span><strong>486</strong></div><div><span>Approved</span><strong>482</strong></div><div><span>Needs review</span><strong className="amber">{needsReview}</strong></div><div><span>Holdings</span><strong>37</strong></div><div><span>Source coverage</span><strong>99.4%</strong></div></div>
    <div className="toolbar"><div className="segmented"><button className={!onlyReview ? "active" : ""} onClick={() => setOnlyReview(false)}>All observations</button><button className={onlyReview ? "active" : ""} onClick={() => setOnlyReview(true)}>Needs review <span className="count-badge">{needsReview}</span></button></div><div className="toolbar-spacer"/><button className="filter-button">All companies <span>⌄</span></button><button className="filter-button">All metrics <span>⌄</span></button></div>
    <div className="table-card"><table className="data-table review-table"><thead><tr><th>Company</th><th>Metric</th><th>Value</th><th>Period</th><th>Change</th><th>Confidence</th><th>Source evidence</th><th>State</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><strong>{row.company}</strong></td><td>{row.metric}</td><td><strong className="value-cell">{row.value}</strong></td><td>{row.period}</td><td className={row.delta.startsWith("+") ? "positive" : ""}>{row.delta}</td><td><div className="confidence"><span>{row.confidence}%</span><div><i style={{width:`${row.confidence}%`}}/></div></div></td><td><button className="source-link"><Icon name="source" size={14}/>{row.source}</button></td><td><StatusPill status={row.state}/></td></tr>)}</tbody></table></div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Every value is traceable.</strong><span>Snapshot → consolidated fact → reviewed observation → source reference → original document.</span></div><button className="text-button">View lineage model <Icon name="arrow" size={14}/></button></div>
  </>;
}
