"use client";

import { useMemo, useState } from "react";
import type { ObservationRecord } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

export function ReviewView({
  observations,
  snapshotId,
  onReview,
  onPublish,
  onExport,
  onOpenSource,
}: {
  observations: ObservationRecord[];
  snapshotId?: string;
  onReview: (observationId: string, decision: "approve" | "reject") => Promise<void>;
  onPublish: (snapshotId: string) => Promise<void>;
  onExport: (snapshotId: string) => Promise<void>;
  onOpenSource: (sourceReferenceId: string) => void;
}) {
  const [onlyReview, setOnlyReview] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = onlyReview ? observations.filter((row) => row.state === "Needs review") : observations;
  const needsReview = observations.filter((row) => row.state === "Needs review").length;
  const approved = observations.filter((row) => row.state === "Approved").length;
  const sourceCoverage = useMemo(() => observations.length ? Math.round((observations.filter((row) => row.source).length / observations.length) * 1000) / 10 : 0, [observations]);

  const act = async (id: string, decision: "approve" | "reject") => {
    setPending(id); setError(null);
    try { await onReview(id, decision); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Review action failed"); }
    finally { setPending(null); }
  };

  const publish = async () => {
    if (!snapshotId) return setError("No snapshot is selected for publication.");
    setPending("publish"); setError(null);
    try { await onPublish(snapshotId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Snapshot publication failed"); }
    finally { setPending(null); }
  };

  const exportData = async () => {
    if (!snapshotId) return setError("No snapshot is selected for export.");
    setPending("export"); setError(null);
    try { await onExport(snapshotId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Export failed"); }
    finally { setPending(null); }
  };

  return <>
    <section className="page-heading"><div><p className="eyebrow">TRUSTED DATA</p><h1>Data review</h1><p className="lede">Review observations against source evidence before publishing a fund-period snapshot.</p></div><div className="heading-actions"><button className="secondary-button" disabled={pending !== null} onClick={() => void exportData()}><Icon name="download"/>Export governed data</button><button className="primary-button" disabled={pending !== null || needsReview > 0 || !snapshotId} onClick={() => void publish()}><Icon name="check"/>{pending === "publish" ? "Publishing…" : "Publish snapshot"}</button></div></section>
    {error && <div className="lineage-note" role="alert"><Icon name="alert"/><div><strong>Action could not be completed.</strong><span>{error}</span></div></div>}
    <div className="review-summary"><div><span>Observations</span><strong>{observations.length}</strong></div><div><span>Approved</span><strong>{approved}</strong></div><div><span>Needs review</span><strong className="amber">{needsReview}</strong></div><div><span>Material blockers</span><strong>{observations.filter((row) => row.materiality === "material" && row.state !== "Approved").length}</strong></div><div><span>Source coverage</span><strong>{sourceCoverage}%</strong></div></div>
    <div className="toolbar"><div className="segmented"><button className={!onlyReview ? "active" : ""} onClick={() => setOnlyReview(false)}>All observations</button><button className={onlyReview ? "active" : ""} onClick={() => setOnlyReview(true)}>Needs review <span className="count-badge">{needsReview}</span></button></div><div className="toolbar-spacer"/></div>
    <div className="table-card"><table className="data-table review-table"><thead><tr><th>Company</th><th>Metric</th><th>Value</th><th>Period</th><th>Change</th><th>Confidence</th><th>Source evidence</th><th>State / action</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><strong>{row.company}</strong></td><td>{row.metric}</td><td><strong className="value-cell">{row.value}</strong></td><td>{row.period}</td><td className={row.delta.startsWith("+") ? "positive" : ""}>{row.delta}</td><td><div className="confidence"><span>{row.confidence}%</span><div><i style={{width:`${row.confidence}%`}}/></div></div></td><td>{row.sourceReferenceId ? <button className="source-link" onClick={() => onOpenSource(row.sourceReferenceId!)}><Icon name="source" size={14}/>{row.source || "Open evidence"}</button> : <span>{row.source || "—"}</span>}</td><td>{row.state === "Needs review" ? <div className="review-actions"><button disabled={pending !== null} onClick={() => void act(row.id, "approve")}>Approve</button><button disabled={pending !== null} onClick={() => void act(row.id, "reject")}>Reject</button></div> : <StatusPill status={row.state}/>}</td></tr>)}</tbody></table></div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Every value is traceable.</strong><span>Snapshot → consolidated fact → reviewed observation → source reference → immutable source artifact.</span></div></div>
  </>;
}
