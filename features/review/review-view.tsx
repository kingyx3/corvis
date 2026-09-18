"use client";

import { useMemo, useState } from "react";
import type { FundSnapshot, ObservationRecord } from "@/core/contracts";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

export function ReviewView({ observations, snapshot }: { observations: ObservationRecord[]; snapshot?: FundSnapshot }) {
  const [onlyReview, setOnlyReview] = useState(false);
  const [rows, setRows] = useState(observations);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const visible = onlyReview ? rows.filter((row) => row.state === "Needs review") : rows;
  const needsReview = rows.filter((row) => row.state === "Needs review").length;
  const publishBlocked = !snapshot?.id || !snapshot.version || needsReview > 0 || (snapshot.blockingExceptions || 0) > 0;

  const exportCsv = () => {
    const header = ["Company","Metric","Value","Period","Source","Confidence","State"];
    const csvRows = rows.map((row) => [row.company,row.metric,row.value,row.period,row.source,`${row.confidence}%`,row.state]);
    const csv = [header, ...csvRows].map((row) => row.map((value) => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "corvis-reviewed-observations.csv"; link.click(); URL.revokeObjectURL(url);
  };

  const approve = async (row: ObservationRecord) => {
    setBusy(row.id); setMessage(null);
    try {
      await workspacePort.review({ observationId: row.id, decision: "approve", reasonCode: "reviewer_verified", expectedVersion: row.version || 1 });
      setRows((current) => current.map((item) => item.id === row.id ? { ...item, state: "Approved" } : item));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Review failed"); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!snapshot?.id || !snapshot.version || publishBlocked) return;
    setBusy("publish"); setMessage(null);
    try {
      await workspacePort.publish({ snapshotId: snapshot.id, action: "publish", expectedVersion: snapshot.version });
      setMessage("Snapshot publication accepted and will be audited by the serving layer.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Publication failed"); }
    finally { setBusy(null); }
  };

  const approved = useMemo(() => rows.filter((row) => row.state === "Approved").length, [rows]);

  return <>
    <section className="page-heading"><div><p className="eyebrow">TRUSTED DATA</p><h1>Data review</h1><p className="lede">{snapshot ? `${snapshot.fund} · ${snapshot.period}${snapshot.version ? ` · Snapshot v${snapshot.version}` : ""}` : "Select a review-ready fund-period snapshot"}</p></div><div className="heading-actions"><button className="secondary-button" onClick={exportCsv}><Icon name="download"/>Export CSV</button><button className="primary-button" disabled={publishBlocked || busy === "publish"} onClick={() => void publish()}><Icon name="check"/>{busy === "publish" ? "Publishing…" : "Publish snapshot"}</button></div></section>
    {message && <div className="lineage-note"><Icon name="shield"/><div><strong>Workflow status</strong><span>{message}</span></div></div>}
    <div className="review-summary"><div><span>Observations</span><strong>{rows.length}</strong></div><div><span>Approved</span><strong>{approved}</strong></div><div><span>Needs review</span><strong className="amber">{needsReview}</strong></div><div><span>Holdings</span><strong>{snapshot?.holdings ?? "—"}</strong></div><div><span>Blocking exceptions</span><strong>{snapshot?.blockingExceptions ?? 0}</strong></div></div>
    <div className="toolbar"><div className="segmented"><button className={!onlyReview ? "active" : ""} onClick={() => setOnlyReview(false)}>All observations</button><button className={onlyReview ? "active" : ""} onClick={() => setOnlyReview(true)}>Needs review <span className="count-badge">{needsReview}</span></button></div><div className="toolbar-spacer"/></div>
    <div className="table-card"><table className="data-table review-table"><thead><tr><th>Company</th><th>Metric</th><th>Value</th><th>Period</th><th>Change</th><th>Confidence</th><th>Source evidence</th><th>State / action</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><strong>{row.company}</strong></td><td>{row.metric}</td><td><strong className="value-cell">{row.value}</strong></td><td>{row.period}</td><td className={row.delta.startsWith("+") ? "positive" : ""}>{row.delta}</td><td><div className="confidence"><span>{row.confidence}%</span><div><i style={{width:`${row.confidence}%`}}/></div></div></td><td><button className="source-link" disabled={!row.sourceReferenceId}><Icon name="source" size={14}/>{row.sourceReferenceId ? row.source : "No entitled source reference"}</button></td><td>{row.state === "Needs review" ? <button className="secondary-button" disabled={busy === row.id} onClick={() => void approve(row)}>{busy === row.id ? "Saving…" : "Approve"}</button> : <StatusPill status={row.state}/>}</td></tr>)}</tbody></table></div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Every published value must be traceable.</strong><span>Snapshot → consolidated fact → reviewed observation → source reference → original document.</span></div></div>
  </>;
}
