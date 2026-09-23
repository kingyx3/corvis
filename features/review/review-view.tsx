"use client";

import { useEffect, useMemo, useState } from "react";
import type { FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { ReconciliationException, ReconciliationResolutionAction } from "@/core/enterprise";
import type { SourceEvidence } from "@/core/workspace";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { StatusPill } from "@/components/ui/status-pill";
import { toCsv } from "@/lib/csv";

function actionLabel(action: ReconciliationResolutionAction): string {
  if (action === "select_source") return "Select authoritative source";
  if (action === "mark_immaterial") return "Mark immaterial";
  return "Accept reconciliation";
}

type ReviewDialog = { row: ObservationRecord; decision: "correct" | "reject" };
type ExceptionDialog = { item: ReconciliationException; action: ReconciliationResolutionAction };

export function ReviewView({
  observations,
  snapshot,
  onObservationUpdated,
  onPublished,
  canReview,
  canPublish,
  canReadSources,
}: {
  observations: ObservationRecord[];
  snapshot?: FundSnapshot;
  onObservationUpdated?: (observation: ObservationRecord) => void;
  onPublished?: (snapshot: FundSnapshot) => void;
  canReview: boolean;
  canPublish: boolean;
  canReadSources: boolean;
}) {
  const [stateFilter, setStateFilter] = useState<"all" | ObservationRecord["state"]>("all");
  const [query, setQuery] = useState("");
  const [confidenceFilter, setConfidenceFilter] = useState<"all" | "under90" | "under75">("all");
  const [sortMode, setSortMode] = useState<"risk" | "company" | "confidence">("risk");
  const [overrides, setOverrides] = useState<Record<string, ObservationRecord>>({});
  const rows = observations.map((row) => {
    const override = overrides[row.id];
    return override && (override.version ?? 0) > (row.version ?? 0) ? override : row;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<SourceEvidence | null>(null);
  const [exceptionState, setExceptionState] = useState<{ key: string; items: ReconciliationException[] }>({ key: "", items: [] });
  const [selectedSources, setSelectedSources] = useState<Record<string, string>>({});
  const [reviewDialog, setReviewDialog] = useState<ReviewDialog | null>(null);
  const [reviewValue, setReviewValue] = useState("");
  const [reviewReason, setReviewReason] = useState("reviewer_corrected");
  const [exceptionDialog, setExceptionDialog] = useState<ExceptionDialog | null>(null);
  const [exceptionNote, setExceptionNote] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const snapshotId = snapshot?.id;
  const snapshotVersion = snapshot?.version;
  const exceptionKey = snapshotId && snapshotVersion ? `${snapshotId}:${snapshotVersion}` : "";

  useEffect(() => {
    if (!canReview || !snapshotId || !snapshotVersion || !exceptionKey) return;
    let active = true;
    void workspacePort.listReconciliationExceptions(snapshotId, snapshotVersion)
      .then((items) => { if (active) setExceptionState({ key: exceptionKey, items }); })
      .catch((error) => {
        if (!active) return;
        setExceptionState({ key: exceptionKey, items: [] });
        setMessage(error instanceof Error ? error.message : "Reconciliation exceptions could not be loaded");
      });
    return () => { active = false; };
  }, [canReview, snapshotId, snapshotVersion, exceptionKey]);

  const exceptions = canReview && exceptionState.key === exceptionKey ? exceptionState.items : [];
  const exceptionsLoaded = !canReview || !exceptionKey || exceptionState.key === exceptionKey;
  const hasSnapshotScopedRows = Boolean(snapshot?.id && rows.some((row) => row.snapshotId === snapshot.id));
  const scopedRows = hasSnapshotScopedRows ? rows.filter((row) => row.snapshotId === snapshot?.id) : rows;
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = scopedRows.filter((row) => {
      if (stateFilter !== "all" && row.state !== stateFilter) return false;
      if (confidenceFilter === "under90" && row.confidence >= 90) return false;
      if (confidenceFilter === "under75" && row.confidence >= 75) return false;
      if (normalized && !`${row.company} ${row.metric} ${row.value} ${row.period} ${row.source}`.toLowerCase().includes(normalized)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sortMode === "company") return `${a.company}:${a.metric}`.localeCompare(`${b.company}:${b.metric}`);
      if (sortMode === "confidence") return a.confidence - b.confidence;
      const stateWeight = (row: ObservationRecord) => row.state === "Needs review" ? 0 : row.state === "Rejected" ? 1 : 2;
      return stateWeight(a) - stateWeight(b) || a.confidence - b.confidence || a.company.localeCompare(b.company);
    });
  }, [confidenceFilter, query, scopedRows, sortMode, stateFilter]);
  const needsReview = scopedRows.filter((row) => row.state === "Needs review").length;
  const approved = scopedRows.filter((row) => row.state === "Approved").length;
  const openExceptions = exceptions.filter((item) => item.status === "open");
  const useGovernedExceptionCount = canReview && exceptionsLoaded && (exceptions.length > 0 || (snapshot?.blockingExceptions ?? 0) === 0);
  const blockingExceptions = useGovernedExceptionCount ? openExceptions.length : snapshot?.blockingExceptions ?? 0;
  const publishBlocked = !snapshot?.id || !snapshot.version || needsReview > 0 || blockingExceptions > 0;
  const clampedFocusedIndex = Math.min(focusedIndex, Math.max(visible.length - 1, 0));
  const focused = visible[clampedFocusedIndex];

  const exportCsv = () => {
    const header = ["Company","Metric","Value","Period","Source","Confidence","State"];
    const csvRows = scopedRows.map((row) => [row.company,row.metric,row.value,row.period,row.source,`${row.confidence}%`,row.state]);
    const csv = toCsv([header, ...csvRows]);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "corvis-reviewed-observations.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const applyDecision = async (row: ObservationRecord, decision: "approve" | "reject" | "correct", correctedValue?: string, reasonCode?: string) => {
    if (!canReview) return;
    setBusy(row.id); setMessage(null);
    try {
      const outcome = await workspacePort.review({ observationId: row.id, decision, reasonCode: reasonCode || (decision === "approve" ? "reviewer_verified" : decision === "reject" ? "reviewer_rejected" : "reviewer_corrected"), correctedValue, expectedVersion: row.version || 1 });
      const updated: ObservationRecord = { ...row, value: decision === "correct" && correctedValue ? correctedValue : row.value, state: outcome.nextState === "approved" ? "Approved" : outcome.nextState === "rejected" ? "Rejected" : "Needs review", version: outcome.newVersion };
      setOverrides((current) => ({ ...current, [row.id]: updated }));
      onObservationUpdated?.(updated);
      if (decision === "approve" && outcome.nextState === "review_required") setMessage("First critical approval recorded; an independent second reviewer is still required.");
      else setMessage(decision === "approve" ? "Observation approval recorded." : decision === "reject" ? "Observation rejected and retained in review history." : "Correction recorded; the corrected observation remains review-required until approved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Review failed"); }
    finally { setBusy(null); }
  };

  const openReviewDialog = (row: ObservationRecord, decision: "correct" | "reject") => {
    setReviewDialog({ row, decision });
    setReviewValue(row.value);
    setReviewReason(decision === "correct" ? "reviewer_corrected" : "reviewer_rejected");
  };

  const submitReviewDialog = async () => {
    if (!reviewDialog) return;
    const value = reviewDialog.decision === "correct" ? reviewValue.trim() : undefined;
    if (reviewDialog.decision === "correct" && !value) return;
    const dialog = reviewDialog;
    setReviewDialog(null);
    await applyDecision(dialog.row, dialog.decision, value, reviewReason);
  };

  const showSourceReference = async (sourceReferenceId: string, busyKey: string) => {
    if (!canReadSources) return;
    setBusy(busyKey); setMessage(null);
    try { setEvidence(await workspacePort.sourceEvidence(sourceReferenceId)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Source evidence could not be opened"); }
    finally { setBusy(null); }
  };

  const resolveException = async (item: ReconciliationException, action: ReconciliationResolutionAction, note: string) => {
    if (!canReview) return;
    const selectedSourceReferenceId = action === "select_source" ? selectedSources[item.exceptionId] || item.sourceReferences[0]?.sourceReferenceId : undefined;
    if (action === "select_source" && !selectedSourceReferenceId) { setMessage("No entitled competing source is available for this source-authority decision."); return; }
    setBusy(`exception:${item.exceptionId}`); setMessage(null);
    try {
      const outcome = await workspacePort.resolveReconciliation({ exceptionId: item.exceptionId, expectedVersion: item.version, action, reasonCode: `reviewer_${action}`, selectedSourceReferenceId, note: note.trim() || undefined });
      setExceptionState((current) => current.key !== exceptionKey ? current : { key: current.key, items: current.items.map((exception) => exception.exceptionId === item.exceptionId ? { ...exception, status: "resolved", version: outcome.newVersion, resolvedAt: new Date().toISOString() } : exception) });
      setMessage(`Reconciliation exception resolved: ${actionLabel(action)}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Reconciliation resolution failed"); }
    finally { setBusy(null); }
  };

  const openExceptionDialog = (item: ReconciliationException, action: ReconciliationResolutionAction) => { setExceptionDialog({ item, action }); setExceptionNote(""); };
  const submitExceptionDialog = async () => { if (!exceptionDialog) return; const dialog = exceptionDialog; setExceptionDialog(null); await resolveException(dialog.item, dialog.action, exceptionNote); };

  const publish = async () => {
    if (!canPublish || !snapshot?.id || !snapshot.version || publishBlocked) return;
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
    <section className="page-heading"><div><p className="eyebrow">TRUSTED DATA</p><h1>Data review</h1><p className="lede">{snapshot ? `${snapshot.fund} · ${snapshot.period}${snapshot.version ? ` · Snapshot v${snapshot.version}` : ""}` : "Select a review-ready fund-period snapshot"}</p></div><div className="heading-actions"><button className="secondary-button" onClick={exportCsv}><Icon name="download"/>Export CSV</button>{canPublish && <button className="primary-button" disabled={publishBlocked || busy === "publish"} onClick={() => void publish()}><Icon name="check"/>{busy === "publish" ? "Publishing…" : "Publish snapshot"}</button>}</div></section>
    {canPublish && publishBlocked && snapshot?.id && <div className="lineage-note" role="status"><Icon name="alert"/><div><strong>Publication gate is closed</strong><span>{needsReview} observations need review and {blockingExceptions} reconciliation exceptions remain open.</span></div></div>}
    {!canReview && <div className="lineage-note" role="status"><Icon name="shield"/><div><strong>Read-only trusted data</strong><span>Your current role can inspect observations but cannot approve, correct or resolve review exceptions.</span></div></div>}
    {message && <div className="lineage-note" role="status"><Icon name="shield"/><div><strong>Workflow status</strong><span>{message}</span></div></div>}
    {evidence && <div className="lineage-note" role="region" aria-label="Source evidence"><Icon name="source"/><div><strong>Exact source evidence</strong><span>{`Document ${evidence.documentId}${evidence.page ? ` · page ${evidence.page}` : ""}${evidence.sheetName ? ` · ${evidence.sheetName}` : ""}${evidence.cellRange ? ` · ${evidence.cellRange}` : ""}`}</span>{evidence.excerpt && <span>{evidence.excerpt}</span>}</div><button className="text-button" onClick={() => setEvidence(null)}>Close</button></div>}
    <div className="review-summary"><div><span>Observations</span><strong>{scopedRows.length}</strong></div><div><span>Approved</span><strong>{approved}</strong></div><div><span>Needs review</span><strong className="amber">{needsReview}</strong></div><div><span>Holdings</span><strong>{snapshot?.holdings ?? "—"}</strong></div><div><span>Blocking exceptions</span><strong>{blockingExceptions}</strong></div></div>

    {canReview && snapshot?.id && <div className="table-card" tabIndex={0} role="region" aria-label="Reconciliation exceptions table"><table className="data-table"><thead><tr><th>Exception</th><th>Context</th><th>Competing evidence</th><th>Status</th><th>Resolution</th></tr></thead><tbody>
      {!exceptionsLoaded && <tr><td colSpan={5}>Loading reconciliation exceptions…</td></tr>}
      {exceptionsLoaded && exceptions.length === 0 && <tr><td colSpan={5}>No governed reconciliation exceptions are recorded for this snapshot version.</td></tr>}
      {exceptions.map((item) => {
        const selectedSource = selectedSources[item.exceptionId] || (item.sourceReferences.length === 1 ? item.sourceReferences[0]?.sourceReferenceId ?? "" : "");
        return <tr key={item.exceptionId}><td><strong>{item.type.replaceAll("_", " ")}</strong><div>{item.summary}</div></td><td>{[item.subjectType, item.subjectId, item.metricCode, item.materiality !== "unknown" ? item.materiality : undefined].filter(Boolean).join(" · ") || "Snapshot-level blocker"}</td><td>{item.sourceReferences.length ? <div className="heading-actions">{item.sourceReferences.map((source) => canReadSources ? <button key={source.sourceReferenceId} className="source-link" disabled={busy === `exception-source:${source.sourceReferenceId}`} onClick={() => void showSourceReference(source.sourceReferenceId, `exception-source:${source.sourceReferenceId}`)}><Icon name="source" size={14}/>{source.page ? `Page ${source.page}` : source.sheetName || source.documentId}</button> : <span key={source.sourceReferenceId}>{source.page ? `Page ${source.page}` : source.documentId}</span>)}</div> : "No entitled source excerpt available"}</td><td>{item.status === "open" ? <StatusPill status="Needs review"/> : <StatusPill status="Approved"/>}</td><td>{item.status === "open" ? <div className="heading-actions">{item.type === "source_authority" && <select aria-label={`Authoritative source for ${item.summary}`} value={selectedSource} onChange={(event) => setSelectedSources((current) => ({ ...current, [item.exceptionId]: event.target.value }))}><option value="">Choose source</option>{item.sourceReferences.map((source) => <option key={source.sourceReferenceId} value={source.sourceReferenceId}>{source.page ? `Page ${source.page}` : source.documentId}</option>)}</select>}{item.allowedActions.map((action) => <button key={action} className="secondary-button" disabled={busy === `exception:${item.exceptionId}` || (action === "select_source" && !selectedSource)} onClick={() => openExceptionDialog(item, action)}>{actionLabel(action)}</button>)}</div> : <span>Resolved {item.resolvedAt ? new Date(item.resolvedAt).toLocaleString() : ""}</span>}</td></tr>;
      })}
    </tbody></table></div>}

    <div className="toolbar" aria-label="Review filters"><label className="search-field"><Icon name="search"/><input aria-label="Search review observations" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search company, metric, value or source"/></label><select className="filter-button" aria-label="Review state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">All states</option><option value="Needs review">Needs review</option><option value="Approved">Approved</option><option value="Rejected">Rejected</option></select><select className="filter-button" aria-label="Confidence risk" value={confidenceFilter} onChange={(event) => setConfidenceFilter(event.target.value as typeof confidenceFilter)}><option value="all">All confidence</option><option value="under90">Under 90%</option><option value="under75">Under 75%</option></select><select className="filter-button" aria-label="Review sort" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="risk">Risk first</option><option value="confidence">Lowest confidence</option><option value="company">Company / metric</option></select><span className="table-muted" role="status">{visible.length} shown</span><div className="toolbar-spacer"/><button className="text-button" disabled={!visible.length || clampedFocusedIndex <= 0} onClick={() => setFocusedIndex(Math.max(0, clampedFocusedIndex - 1))}>Previous</button><button className="text-button" disabled={!visible.length || clampedFocusedIndex >= visible.length - 1} onClick={() => setFocusedIndex(Math.min(visible.length - 1, clampedFocusedIndex + 1))}>Next</button></div>
    {focused && <div className="lineage-note" role="status" aria-label="Focused review item"><Icon name="table"/><div><strong>Review queue {clampedFocusedIndex + 1} of {visible.length}</strong><span>{focused.company} · {focused.metric} · {focused.confidence}% confidence</span></div></div>}
    <div className="table-card" tabIndex={0} role="region" aria-label="Data review observations table"><table className="data-table review-table"><thead><tr><th>Company</th><th>Metric</th><th>Value</th><th>Period</th><th>Change</th><th>Confidence</th><th>Source evidence</th><th>State / action</th></tr></thead><tbody>
      {visible.length === 0 && <tr><td colSpan={8}>No observations match the current review filters.</td></tr>}
      {visible.map((row, index) => <tr key={row.id} aria-current={index === clampedFocusedIndex ? "true" : undefined}><td><strong>{row.company}</strong></td><td>{row.metric}</td><td><strong className="value-cell">{row.value}</strong></td><td>{row.period}</td><td className={row.delta.startsWith("+") ? "positive" : ""}>{row.delta}</td><td><div className="confidence"><span>{row.confidence}%</span><div><i style={{width:`${row.confidence}%`}}/></div></div></td><td>{canReadSources ? <button className="source-link" disabled={!row.sourceReferenceId || busy === `source:${row.id}`} onClick={() => row.sourceReferenceId && void showSourceReference(row.sourceReferenceId, `source:${row.id}`)}><Icon name="source" size={14}/>{row.sourceReferenceId ? row.source : "No entitled source reference"}</button> : <span>{row.source}</span>}</td><td>{row.state === "Needs review" && canReview ? <div className="heading-actions"><button className="secondary-button" disabled={busy === row.id} onClick={() => void applyDecision(row,"approve")}>Approve</button><button className="text-button" disabled={busy === row.id} onClick={() => openReviewDialog(row,"correct")}>Correct</button><button className="text-button" disabled={busy === row.id} onClick={() => openReviewDialog(row,"reject")}>Reject</button></div> : <StatusPill status={row.state}/>}</td></tr>)}
    </tbody></table></div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Every published value must be traceable.</strong><span>Snapshot → consolidated fact → reviewed observation → source reference → original document. Exception resolutions are versioned and attributable.</span></div></div>

    {reviewDialog && <Modal label={`${reviewDialog.decision} observation`} onClose={() => setReviewDialog(null)} width="min(520px, calc(100vw - 32px))"><div style={{ padding:22 }}><h2 style={{ marginTop:0 }}>{reviewDialog.decision === "correct" ? "Correct observation" : "Reject observation"}</h2><p>{reviewDialog.row.company} · {reviewDialog.row.metric}</p>{reviewDialog.decision === "correct" && <label style={{ display:"grid", gap:6, marginBottom:14 }}>Corrected value<input autoFocus value={reviewValue} onChange={(event) => setReviewValue(event.target.value)} style={{ padding:10 }}/></label>}<label style={{ display:"grid", gap:6, marginBottom:18 }}>Reason<select value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} style={{ padding:10 }}><option value={reviewDialog.decision === "correct" ? "reviewer_corrected" : "reviewer_rejected"}>{reviewDialog.decision === "correct" ? "Reviewer correction" : "Reviewer rejection"}</option><option value="source_conflict">Source conflict</option><option value="duplicate">Duplicate disclosure</option><option value="out_of_scope">Out of scope</option><option value="other">Other governed reason</option></select></label><div className="heading-actions"><button className="primary-button" disabled={reviewDialog.decision === "correct" && !reviewValue.trim()} onClick={() => void submitReviewDialog()}>Record decision</button><button className="secondary-button" onClick={() => setReviewDialog(null)}>Cancel</button></div></div></Modal>}
    {exceptionDialog && <Modal label="Resolve reconciliation exception" onClose={() => setExceptionDialog(null)} width="min(560px, calc(100vw - 32px))"><div style={{ padding:22 }}><h2 style={{ marginTop:0 }}>{actionLabel(exceptionDialog.action)}</h2><p>{exceptionDialog.item.summary}</p><label style={{ display:"grid", gap:6, marginBottom:18 }}>Resolution note<textarea autoFocus rows={4} value={exceptionNote} onChange={(event) => setExceptionNote(event.target.value)} placeholder="Optional evidence or rationale" style={{ padding:10 }}/></label><div className="heading-actions"><button className="primary-button" onClick={() => void submitExceptionDialog()}>Resolve exception</button><button className="secondary-button" onClick={() => setExceptionDialog(null)}>Cancel</button></div></div></Modal>}
  </>;
}
