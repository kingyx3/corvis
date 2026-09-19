"use client";

import { useEffect, useState } from "react";
import type { FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { ReconciliationException, ReconciliationResolutionAction } from "@/core/enterprise";
import type { SourceEvidence } from "@/core/workspace";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

function actionLabel(action: ReconciliationResolutionAction): string {
  if (action === "select_source") return "Select authoritative source";
  if (action === "mark_immaterial") return "Mark immaterial";
  return "Accept reconciliation";
}

export function ReviewView({
  observations,
  snapshot,
  onObservationUpdated,
  onPublished,
}: {
  observations: ObservationRecord[];
  snapshot?: FundSnapshot;
  onObservationUpdated?: (observation: ObservationRecord) => void;
  onPublished?: (snapshot: FundSnapshot) => void;
}) {
  const [onlyReview, setOnlyReview] = useState(false);
  const [rows, setRows] = useState(observations);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<SourceEvidence | null>(null);
  const [exceptions, setExceptions] = useState<ReconciliationException[]>([]);
  const [exceptionsLoaded, setExceptionsLoaded] = useState(false);
  const [selectedSources, setSelectedSources] = useState<Record<string, string>>({});
  const snapshotId = snapshot?.id;
  const snapshotVersion = snapshot?.version;

  useEffect(() => {
    let active = true;
    setExceptions([]);
    setExceptionsLoaded(false);
    setSelectedSources({});
    if (!snapshotId || !snapshotVersion) {
      setExceptionsLoaded(true);
      return () => { active = false; };
    }
    void workspacePort.listReconciliationExceptions(snapshotId, snapshotVersion)
      .then((items) => { if (active) setExceptions(items); })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "Reconciliation exceptions could not be loaded"); })
      .finally(() => { if (active) setExceptionsLoaded(true); });
    return () => { active = false; };
  }, [snapshotId, snapshotVersion]);

  const hasSnapshotScopedRows = Boolean(snapshot?.id && rows.some((row) => row.snapshotId === snapshot.id));
  const scopedRows = hasSnapshotScopedRows ? rows.filter((row) => row.snapshotId === snapshot?.id) : rows;
  const visible = onlyReview ? scopedRows.filter((row) => row.state === "Needs review") : scopedRows;
  const needsReview = scopedRows.filter((row) => row.state === "Needs review").length;
  const approved = scopedRows.filter((row) => row.state === "Approved").length;
  const openExceptions = exceptions.filter((item) => item.status === "open");
  const useGovernedExceptionCount = exceptionsLoaded && (exceptions.length > 0 || (snapshot?.blockingExceptions ?? 0) === 0);
  const blockingExceptions = useGovernedExceptionCount ? openExceptions.length : snapshot?.blockingExceptions ?? 0;
  const publishBlocked = !snapshot?.id || !snapshot.version || needsReview > 0 || blockingExceptions > 0;

  const exportCsv = () => {
    const header = ["Company","Metric","Value","Period","Source","Confidence","State"];
    const csvRows = scopedRows.map((row) => [row.company,row.metric,row.value,row.period,row.source,`${row.confidence}%`,row.state]);
    const csv = [header, ...csvRows].map((row) => row.map((value) => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "corvis-reviewed-observations.csv"; link.click(); URL.revokeObjectURL(url);
  };

  const decide = async (row: ObservationRecord, decision: "approve" | "reject" | "correct") => {
    let correctedValue: string | undefined;
    const reasonCode = decision === "approve" ? "reviewer_verified" : decision === "reject" ? "reviewer_rejected" : "reviewer_corrected";
    if (decision === "correct") {
      correctedValue = window.prompt(`Correct ${row.metric} for ${row.company}`, row.value) ?? undefined;
      if (correctedValue == null || correctedValue.trim() === "") return;
    }
    setBusy(row.id); setMessage(null);
    try {
      const outcome = await workspacePort.review({ observationId: row.id, decision, reasonCode, correctedValue, expectedVersion: row.version || 1 });
      const updated: ObservationRecord = {
        ...row,
        value: decision === "correct" && correctedValue ? correctedValue : row.value,
        state: outcome.nextState === "approved" ? "Approved" : outcome.nextState === "rejected" ? "Rejected" : "Needs review",
        version: outcome.newVersion,
      };
      setRows((current) => current.map((item) => item.id === row.id ? updated : item));
      onObservationUpdated?.(updated);
      if (decision === "approve" && outcome.nextState === "review_required") {
        setMessage("First critical approval recorded; an independent second reviewer is still required.");
      } else {
        setMessage(decision === "approve" ? "Observation approval recorded." : decision === "reject" ? "Observation rejected and retained in review history." : "Correction recorded; the corrected observation remains review-required until approved.");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Review failed"); }
    finally { setBusy(null); }
  };

  const showSourceReference = async (sourceReferenceId: string, busyKey: string) => {
    setBusy(busyKey); setMessage(null);
    try { setEvidence(await workspacePort.sourceEvidence(sourceReferenceId)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Source evidence could not be opened"); }
    finally { setBusy(null); }
  };

  const showEvidence = async (row: ObservationRecord) => {
    if (!row.sourceReferenceId) return;
    await showSourceReference(row.sourceReferenceId, `source:${row.id}`);
  };

  const resolveException = async (item: ReconciliationException, action: ReconciliationResolutionAction) => {
    const selectedSourceReferenceId = action === "select_source"
      ? selectedSources[item.exceptionId] || item.sourceReferences[0]?.sourceReferenceId
      : undefined;
    if (action === "select_source" && !selectedSourceReferenceId) {
      setMessage("No entitled competing source is available for this source-authority decision.");
      return;
    }
    const note = window.prompt(`Resolution note for: ${item.summary}`, "") ?? undefined;
    if (note === undefined) return;
    setBusy(`exception:${item.exceptionId}`); setMessage(null);
    try {
      const outcome = await workspacePort.resolveReconciliation({
        exceptionId: item.exceptionId,
        expectedVersion: item.version,
        action,
        reasonCode: `reviewer_${action}`,
        selectedSourceReferenceId,
        note,
      });
      setExceptions((current) => current.map((exception) => exception.exceptionId === item.exceptionId
        ? { ...exception, status: "resolved", version: outcome.newVersion, resolvedAt: new Date().toISOString() }
        : exception));
      setMessage(`Reconciliation exception resolved: ${actionLabel(action)}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Reconciliation resolution failed"); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!snapshot?.id || !snapshot.version || publishBlocked) return;
    setBusy("publish"); setMessage(null);
    try {
      await workspacePort.publish({ snapshotId: snapshot.id, action: "publish", expectedVersion: snapshot.version });
      const published: FundSnapshot = { ...snapshot, status: "Published", version: snapshot.version + 1, changed: "Just now", blockingExceptions: 0 };
      onPublished?.(published);
      setMessage("Snapshot publication accepted and recorded in the serving audit trail.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Publication failed"); }
    finally { setBusy(null); }
  };

  return <>
    <section className="page-heading"><div><p className="eyebrow">TRUSTED DATA</p><h1>Data review</h1><p className="lede">{snapshot ? `${snapshot.fund} · ${snapshot.period}${snapshot.version ? ` · Snapshot v${snapshot.version}` : ""}` : "Select a review-ready fund-period snapshot"}</p></div><div className="heading-actions"><button className="secondary-button" onClick={exportCsv}><Icon name="download"/>Export CSV</button><button className="primary-button" disabled={publishBlocked || busy === "publish"} onClick={() => void publish()}><Icon name="check"/>{busy === "publish" ? "Publishing…" : "Publish snapshot"}</button></div></section>
    {message && <div className="lineage-note" role="status"><Icon name="shield"/><div><strong>Workflow status</strong><span>{message}</span></div></div>}
    {evidence && <div className="lineage-note" role="region" aria-label="Source evidence"><Icon name="source"/><div><strong>Exact source evidence</strong><span>{`Document ${evidence.documentId}${evidence.page ? ` · page ${evidence.page}` : ""}${evidence.sheetName ? ` · ${evidence.sheetName}` : ""}${evidence.cellRange ? ` · ${evidence.cellRange}` : ""}`}</span>{evidence.excerpt && <span>{evidence.excerpt}</span>}</div><button className="text-button" onClick={() => setEvidence(null)}>Close</button></div>}
    <div className="review-summary"><div><span>Observations</span><strong>{scopedRows.length}</strong></div><div><span>Approved</span><strong>{approved}</strong></div><div><span>Needs review</span><strong className="amber">{needsReview}</strong></div><div><span>Holdings</span><strong>{snapshot?.holdings ?? "—"}</strong></div><div><span>Blocking exceptions</span><strong>{blockingExceptions}</strong></div></div>

    {snapshot?.id && <div className="table-card"><table className="data-table"><thead><tr><th>Exception</th><th>Context</th><th>Competing evidence</th><th>Status</th><th>Resolution</th></tr></thead><tbody>
      {!exceptionsLoaded && <tr><td colSpan={5}>Loading reconciliation exceptions…</td></tr>}
      {exceptionsLoaded && exceptions.length === 0 && <tr><td colSpan={5}>No governed reconciliation exceptions are recorded for this snapshot version.</td></tr>}
      {exceptions.map((item) => {
        const selectedSource = selectedSources[item.exceptionId] || (item.sourceReferences.length === 1 ? item.sourceReferences[0]?.sourceReferenceId ?? "" : "");
        return <tr key={item.exceptionId}>
          <td><strong>{item.type.replaceAll("_", " ")}</strong><div>{item.summary}</div></td>
          <td>{[item.subjectType, item.subjectId, item.metricCode, item.materiality !== "unknown" ? item.materiality : undefined].filter(Boolean).join(" · ") || "Snapshot-level blocker"}</td>
          <td>{item.sourceReferences.length ? <div className="heading-actions">{item.sourceReferences.map((source) => <button key={source.sourceReferenceId} className="source-link" disabled={busy === `exception-source:${source.sourceReferenceId}`} onClick={() => void showSourceReference(source.sourceReferenceId, `exception-source:${source.sourceReferenceId}`)}><Icon name="source" size={14}/>{source.page ? `Page ${source.page}` : source.sheetName || source.documentId}</button>)}</div> : "No entitled source excerpt available"}</td>
          <td>{item.status === "open" ? <StatusPill status="Needs review"/> : <StatusPill status="Approved"/>}</td>
          <td>{item.status === "open" ? <div className="heading-actions">
            {item.type === "source_authority" && <select aria-label={`Authoritative source for ${item.summary}`} value={selectedSource} onChange={(event) => setSelectedSources((current) => ({ ...current, [item.exceptionId]: event.target.value }))}><option value="">Choose source</option>{item.sourceReferences.map((source) => <option key={source.sourceReferenceId} value={source.sourceReferenceId}>{source.page ? `Page ${source.page}` : source.documentId}</option>)}</select>}
            {item.allowedActions.map((action) => <button key={action} className="secondary-button" disabled={busy === `exception:${item.exceptionId}` || (action === "select_source" && !selectedSource)} onClick={() => void resolveException(item, action)}>{actionLabel(action)}</button>)}
          </div> : <span>Resolved {item.resolvedAt ? new Date(item.resolvedAt).toLocaleString() : ""}</span>}</td>
        </tr>;
      })}
    </tbody></table></div>}

    <div className="toolbar"><div className="segmented"><button className={!onlyReview ? "active" : ""} onClick={() => setOnlyReview(false)}>All observations</button><button className={onlyReview ? "active" : ""} onClick={() => setOnlyReview(true)}>Needs review <span className="count-badge">{needsReview}</span></button></div><div className="toolbar-spacer"/></div>
    <div className="table-card"><table className="data-table review-table"><thead><tr><th>Company</th><th>Metric</th><th>Value</th><th>Period</th><th>Change</th><th>Confidence</th><th>Source evidence</th><th>State / action</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><strong>{row.company}</strong></td><td>{row.metric}</td><td><strong className="value-cell">{row.value}</strong></td><td>{row.period}</td><td className={row.delta.startsWith("+") ? "positive" : ""}>{row.delta}</td><td><div className="confidence"><span>{row.confidence}%</span><div><i style={{width:`${row.confidence}%`}}/></div></div></td><td><button className="source-link" disabled={!row.sourceReferenceId || busy === `source:${row.id}`} onClick={() => void showEvidence(row)}><Icon name="source" size={14}/>{row.sourceReferenceId ? row.source : "No entitled source reference"}</button></td><td>{row.state === "Needs review" ? <div className="heading-actions"><button className="secondary-button" disabled={busy === row.id} onClick={() => void decide(row,"approve")}>Approve</button><button className="text-button" disabled={busy === row.id} onClick={() => void decide(row,"correct")}>Correct</button><button className="text-button" disabled={busy === row.id} onClick={() => void decide(row,"reject")}>Reject</button></div> : <StatusPill status={row.state}/>}</td></tr>)}</tbody></table></div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Every published value must be traceable.</strong><span>Snapshot → consolidated fact → reviewed observation → source reference → original document. Exception resolutions are versioned and attributable.</span></div></div>
  </>;
}
