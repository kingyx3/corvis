"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { ReconciliationException, ReconciliationResolutionAction } from "@/core/enterprise";
import type { SourceEvidence } from "@/core/workspace";
import { deliveryPort } from "@/runtime/delivery-services";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { StatusPill } from "@/components/ui/status-pill";

function actionLabel(action: ReconciliationResolutionAction): string {
  if (action === "select_source") return "Select authoritative source";
  if (action === "mark_immaterial") return "Mark immaterial";
  return "Accept reconciliation";
}

type ReviewDialog = { row: ObservationRecord; decision: "correct" | "reject" };
type ExceptionDialog = { item: ReconciliationException; action: ReconciliationResolutionAction };
/** A drill-through request (e.g. from global search) to focus one observation; a new key re-applies it. */
export type ReviewFocusRequest = { observationId: string; key: number };
// Queue focus is a position (Previous/Next) or a specific observation (drill-through).
type QueueFocus = { index: number } | { observationId: string };

// Review's filters/sort/scroll position outlive navigating away (e.g. via a
// drill-through to Position Financials, per issue #177 D1) so returning to
// Review doesn't force re-deriving the same scope from scratch.
const REVIEW_UI_STATE_KEY = "corvis:review:ui-state";
type PersistedReviewState = { stateFilter: string; query: string; confidenceFilter: string; sortMode: string; focusedObservationId?: string };
function readPersistedReviewState(): PersistedReviewState | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(REVIEW_UI_STATE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as PersistedReviewState; } catch { return null; }
}
function writePersistedReviewState(state: PersistedReviewState): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(REVIEW_UI_STATE_KEY, JSON.stringify(state));
}

export function ReviewView({
  observations,
  snapshot,
  onObservationUpdated,
  onPublished,
  canReview,
  canPublish,
  canReadSources,
  canExport,
  focusRequest,
  onViewPositionFinancials,
}: {
  observations: ObservationRecord[];
  snapshot?: FundSnapshot;
  onObservationUpdated?: (observation: ObservationRecord) => void;
  onPublished?: (snapshot: FundSnapshot) => void;
  canReview: boolean;
  canPublish: boolean;
  canReadSources: boolean;
  canExport: boolean;
  focusRequest?: ReviewFocusRequest | null;
  onViewPositionFinancials?: (row: ObservationRecord) => void;
}) {
  // A fresh drill-through (focusRequest) always starts from a clean scope so the
  // requested observation can't be hidden by a stale filter; otherwise restore
  // whatever was last persisted (e.g. returning from Position Financials).
  const persistedReviewState = focusRequest ? null : readPersistedReviewState();
  const [stateFilter, setStateFilter] = useState<"all" | ObservationRecord["state"]>((persistedReviewState?.stateFilter as "all" | ObservationRecord["state"] | undefined) ?? "all");
  const [query, setQuery] = useState(persistedReviewState?.query ?? "");
  const [confidenceFilter, setConfidenceFilter] = useState<"all" | "under90" | "under75">((persistedReviewState?.confidenceFilter as "all" | "under90" | "under75" | undefined) ?? "all");
  const [sortMode, setSortMode] = useState<"risk" | "company" | "confidence">((persistedReviewState?.sortMode as "risk" | "company" | "confidence" | undefined) ?? "risk");
  const [overrides, setOverrides] = useState<Record<string, ObservationRecord>>({});
  const rows = observations.map((row) => {
    const override = overrides[row.id];
    return override && (override.version ?? 0) > (row.version ?? 0) ? override : row;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [evidence, setEvidence] = useState<SourceEvidence | null>(null);
  const [exceptionState, setExceptionState] = useState<{ key: string; items: ReconciliationException[] }>({ key: "", items: [] });
  const [selectedSources, setSelectedSources] = useState<Record<string, string>>({});
  const [reviewDialog, setReviewDialog] = useState<ReviewDialog | null>(null);
  const [reviewValue, setReviewValue] = useState("");
  const [reviewReason, setReviewReason] = useState("reviewer_corrected");
  const [exceptionDialog, setExceptionDialog] = useState<ExceptionDialog | null>(null);
  const [exceptionNote, setExceptionNote] = useState("");
  const [queueFocus, setQueueFocus] = useState<QueueFocus>(focusRequest ? { observationId: focusRequest.observationId } : persistedReviewState?.focusedObservationId ? { observationId: persistedReviewState.focusedObservationId } : { index: 0 });
  const [appliedFocusKey, setAppliedFocusKey] = useState(focusRequest?.key);
  const [scrollTarget, setScrollTarget] = useState<{ observationId: string; request: number } | null>(focusRequest ? { observationId: focusRequest.observationId, request: focusRequest.key } : persistedReviewState?.focusedObservationId ? { observationId: persistedReviewState.focusedObservationId, request: 0 } : null);
  const evidenceRequestRef = useRef(0);
  // A new drill-through while mounted: clear filters that could hide the
  // requested observation, focus it and scroll it into view.
  if (focusRequest && focusRequest.key !== appliedFocusKey) {
    setAppliedFocusKey(focusRequest.key);
    setQueueFocus({ observationId: focusRequest.observationId });
    setScrollTarget({ observationId: focusRequest.observationId, request: focusRequest.key });
    setQuery("");
    setStateFilter("all");
    setConfidenceFilter("all");
  }
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
        setMessage({ text: error instanceof Error ? error.message : "Reconciliation exceptions could not be loaded", tone: "error" });
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
  const alreadyPublished = snapshot?.status === "Published";
  const publishBlocked = !snapshot?.id || !snapshot.version || alreadyPublished || needsReview > 0 || blockingExceptions > 0;
  const requestedFocusIndex = "observationId" in queueFocus ? visible.findIndex((row) => row.id === queueFocus.observationId) : queueFocus.index;
  const clampedFocusedIndex = Math.min(Math.max(requestedFocusIndex, 0), Math.max(visible.length - 1, 0));
  const focused = visible[clampedFocusedIndex];
  useEffect(() => {
    writePersistedReviewState({ stateFilter, query, confidenceFilter, sortMode, focusedObservationId: focused?.id });
  },[confidenceFilter,focused?.id,query,sortMode,stateFilter]);
  const moveFocus = (delta: number) => {
    const index = Math.min(Math.max(clampedFocusedIndex + delta, 0), Math.max(visible.length - 1, 0));
    const row = visible[index];
    if (!row) return;
    setQueueFocus({ index });
    setScrollTarget((current) => ({ observationId: row.id, request: (current?.request ?? 0) + 1 }));
  };

  useEffect(() => {
    if (!scrollTarget) return;
    document.querySelector(`[data-observation-id="${CSS.escape(scrollTarget.observationId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [scrollTarget]);

  // Routes through the same governed deliveryPort pipeline (manifest, checksum,
  // audit trail) Data delivery uses, scoped to this one snapshot, instead of an
  // ungoverned client-side CSV blob (#177 D3). Async by design: the export is
  // rendered by the same worker Data delivery's exports are, so it's requested
  // here and downloaded from Data delivery once ready, not handed back inline.
  const requestExport = async () => {
    if (!snapshot?.id) return;
    setBusy("export"); setMessage(null);
    try {
      await deliveryPort.createExport("csv", { scope: { snapshotId: snapshot.id }, source: "review" });
      setMessage({ text: "Export requested for this snapshot. Download it from Data delivery once it's ready.", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Export request failed", tone: "error" }); }
    finally { setBusy(null); }
  };

  const applyDecision = async (row: ObservationRecord, decision: "approve" | "reject" | "correct", correctedValue?: string, reasonCode?: string) => {
    if (!canReview) return;
    setBusy(row.id); setMessage(null);
    try {
      const outcome = await workspacePort.review({ observationId: row.id, decision, reasonCode: reasonCode || (decision === "approve" ? "reviewer_verified" : decision === "reject" ? "reviewer_rejected" : "reviewer_corrected"), correctedValue, expectedVersion: row.version || 1 });
      const updated: ObservationRecord = { ...row, value: decision === "correct" && correctedValue ? correctedValue : row.value, state: outcome.nextState === "approved" ? "Approved" : outcome.nextState === "rejected" ? "Rejected" : "Needs review", version: outcome.newVersion };
      setOverrides((current) => ({ ...current, [row.id]: updated }));
      onObservationUpdated?.(updated);
      if (decision === "approve" && outcome.nextState === "review_required") setMessage({ text: "First critical approval recorded; an independent second reviewer is still required.", tone: "success" });
      else setMessage({ text: decision === "approve" ? "Observation approval recorded." : decision === "reject" ? "Observation rejected and retained in review history." : "Correction recorded; the corrected observation remains review-required until approved.", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Review failed", tone: "error" }); }
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

  // Only the latest evidence request may update the panel; a slower earlier
  // response must not replace evidence the reviewer opened afterwards.
  const showSourceReference = async (sourceReferenceId: string, busyKey: string) => {
    if (!canReadSources) return;
    const requestId = ++evidenceRequestRef.current;
    setBusy(busyKey); setMessage(null);
    try {
      const opened = await workspacePort.sourceEvidence(sourceReferenceId);
      if (requestId === evidenceRequestRef.current) setEvidence(opened);
    } catch (error) {
      if (requestId === evidenceRequestRef.current) setMessage({ text: error instanceof Error ? error.message : "Source evidence could not be opened", tone: "error" });
    } finally { setBusy((current) => current === busyKey ? null : current); }
  };

  const resolveException = async (item: ReconciliationException, action: ReconciliationResolutionAction, note: string) => {
    if (!canReview) return;
    const selectedSourceReferenceId = action === "select_source" ? selectedSources[item.exceptionId] || item.sourceReferences[0]?.sourceReferenceId : undefined;
    if (action === "select_source" && !selectedSourceReferenceId) { setMessage({ text: "No entitled competing source is available for this source-authority decision.", tone: "error" }); return; }
    setBusy(`exception:${item.exceptionId}`); setMessage(null);
    try {
      const outcome = await workspacePort.resolveReconciliation({ exceptionId: item.exceptionId, expectedVersion: item.version, action, reasonCode: `reviewer_${action}`, selectedSourceReferenceId, note: note.trim() || undefined });
      setExceptionState((current) => current.key !== exceptionKey ? current : { key: current.key, items: current.items.map((exception) => exception.exceptionId === item.exceptionId ? { ...exception, status: "resolved", version: outcome.newVersion, resolvedAt: new Date().toISOString() } : exception) });
      setMessage({ text: `Reconciliation exception resolved: ${actionLabel(action)}.`, tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Reconciliation resolution failed", tone: "error" }); }
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
      setMessage({ text: "Snapshot publication accepted and recorded in the serving audit trail.", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Publication failed", tone: "error" }); }
    finally { setBusy(null); }
  };

  return <>
    <section className="page-heading"><div><p className="eyebrow">Trusted data</p><h1>Data review</h1><p className="lede">{snapshot ? `${snapshot.fund} · ${snapshot.period}${snapshot.version ? ` · Snapshot v${snapshot.version}` : ""}` : "Select a review-ready fund-period snapshot"}</p></div><div className="heading-actions">{canExport && snapshot?.id && <button className="secondary-button" disabled={!alreadyPublished || busy === "export"} title={alreadyPublished ? undefined : "Publish this snapshot first: the governed export pipeline only exports published, audited data"} onClick={() => void requestExport()}><Icon name="download"/>{busy === "export" ? "Requesting export…" : "Export this snapshot"}</button>}{canPublish && <button className="primary-button" disabled={publishBlocked || busy === "publish"} onClick={() => void publish()}><Icon name="check"/>{busy === "publish" ? "Publishing…" : alreadyPublished ? "Published" : "Publish snapshot"}</button>}</div></section>
    {canPublish && publishBlocked && !alreadyPublished && snapshot?.id && <div className="lineage-note tone-warning" role="status"><Icon name="alert"/><div><strong>Publication gate is closed</strong><span>{needsReview} {needsReview === 1 ? "observation needs" : "observations need"} review and {blockingExceptions} reconciliation {blockingExceptions === 1 ? "exception remains" : "exceptions remain"} open.</span></div></div>}
    {!canReview && <div className="lineage-note" role="status"><Icon name="shield"/><div><strong>Read-only trusted data</strong><span>Your current role can inspect observations but cannot approve, correct or resolve review exceptions.</span></div></div>}
    {message && <div className={`lineage-note ${message.tone === "error" ? "tone-danger" : "tone-success"}`} role={message.tone === "error" ? "alert" : "status"}><Icon name={message.tone === "error" ? "alert" : "shield"}/><div><strong>{message.tone === "error" ? "Workflow action failed" : "Workflow status"}</strong><span>{message.text}</span></div></div>}
    {evidence && <div className="lineage-note" role="region" aria-label="Source evidence"><Icon name="source"/><div><strong>Exact source evidence</strong><span>{`Document ${evidence.documentId}${evidence.page ? ` · page ${evidence.page}` : ""}${evidence.sheetName ? ` · ${evidence.sheetName}` : ""}${evidence.cellRange ? ` · ${evidence.cellRange}` : ""}`}</span>{evidence.excerpt && <span>{evidence.excerpt}</span>}</div><button className="text-button" onClick={() => { evidenceRequestRef.current += 1; setEvidence(null); }}>Close</button></div>}
    <div className="review-summary" role="group" aria-label="Snapshot review summary"><div><span>Observations</span><strong>{scopedRows.length}</strong></div><div><span>Approved</span><strong>{approved}</strong></div><div><span>Needs review</span><strong className="amber">{needsReview}</strong></div><div><span>Holdings</span><strong>{snapshot?.holdings ?? "—"}</strong></div><div><span>Blocking exceptions</span><strong>{blockingExceptions}</strong></div></div>

    {canReview && snapshot?.id && <div className="table-card" tabIndex={0} role="region" aria-label="Reconciliation exceptions table"><table className="data-table"><thead><tr><th>Exception</th><th>Context</th><th>Competing evidence</th><th>Status</th><th>Resolution</th></tr></thead><tbody>
      {!exceptionsLoaded && <tr><td colSpan={5} className="empty-cell">Loading reconciliation exceptions…</td></tr>}
      {exceptionsLoaded && exceptions.length === 0 && <tr><td colSpan={5} className="empty-cell">No governed reconciliation exceptions are recorded for this snapshot version.</td></tr>}
      {exceptions.map((item) => {
        const selectedSource = selectedSources[item.exceptionId] || (item.sourceReferences.length === 1 ? item.sourceReferences[0]?.sourceReferenceId ?? "" : "");
        return <tr key={item.exceptionId}><td><strong className="capitalize">{item.type.replaceAll("_", " ")}</strong><span className="table-secondary">{item.summary}</span></td><td>{[item.subjectType, item.subjectId, item.metricCode, item.materiality !== "unknown" ? item.materiality : undefined].filter(Boolean).join(" · ") || "Snapshot-level blocker"}</td><td>{item.sourceReferences.length ? <div className="heading-actions">{item.sourceReferences.map((source) => canReadSources ? <button key={source.sourceReferenceId} className="source-link" disabled={busy === `exception-source:${source.sourceReferenceId}`} onClick={() => void showSourceReference(source.sourceReferenceId, `exception-source:${source.sourceReferenceId}`)}><Icon name="source" size={14}/>{source.page ? `Page ${source.page}` : source.sheetName || source.documentId}</button> : <span key={source.sourceReferenceId}>{source.page ? `Page ${source.page}` : source.documentId}</span>)}</div> : "No entitled source excerpt available"}</td><td>{item.status === "open" ? <StatusPill status="Needs review"/> : <StatusPill status="Approved"/>}</td><td>{item.status === "open" ? <div className="heading-actions">{item.type === "source_authority" && <select className="filter-button inline-select" aria-label={`Authoritative source for ${item.summary}`} value={selectedSource} onChange={(event) => setSelectedSources((current) => ({ ...current, [item.exceptionId]: event.target.value }))}><option value="">Choose source</option>{item.sourceReferences.map((source) => <option key={source.sourceReferenceId} value={source.sourceReferenceId}>{source.page ? `Page ${source.page}` : source.documentId}</option>)}</select>}{item.allowedActions.map((action) => <button key={action} className="secondary-button button-small" disabled={busy === `exception:${item.exceptionId}` || (action === "select_source" && !selectedSource)} onClick={() => openExceptionDialog(item, action)}>{actionLabel(action)}</button>)}</div> : <span>Resolved {item.resolvedAt ? new Date(item.resolvedAt).toLocaleString() : ""}</span>}</td></tr>;
      })}
    </tbody></table></div>}

    <div className="toolbar" aria-label="Review filters"><label className="search-field"><Icon name="search"/><input aria-label="Search review observations" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search company, metric, value or source"/></label><select className="filter-button" aria-label="Review state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">All states</option><option value="Needs review">Needs review</option><option value="Approved">Approved</option><option value="Rejected">Rejected</option></select><select className="filter-button" aria-label="Confidence risk" value={confidenceFilter} onChange={(event) => setConfidenceFilter(event.target.value as typeof confidenceFilter)}><option value="all">All confidence</option><option value="under90">Under 90%</option><option value="under75">Under 75%</option></select><select className="filter-button" aria-label="Review sort" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="risk">Risk first</option><option value="confidence">Lowest confidence</option><option value="company">Company / metric</option></select><span className="result-count" role="status">{visible.length} shown</span><div className="toolbar-spacer"/><div className="toolbar-group"><button className="text-button" disabled={!visible.length || clampedFocusedIndex <= 0} onClick={() => moveFocus(-1)}>Previous</button><button className="text-button" disabled={!visible.length || clampedFocusedIndex >= visible.length - 1} onClick={() => moveFocus(1)}>Next</button></div></div>
    {focused && <div className="lineage-note" role="status" aria-label="Focused review item"><Icon name="table"/><div><strong>Review queue {clampedFocusedIndex + 1} of {visible.length}</strong><span>{focused.company} · {focused.metric} · {focused.confidence}% confidence</span></div></div>}
    <div className="table-card" tabIndex={0} role="region" aria-label="Data review observations table"><table className="data-table review-table"><thead><tr><th>Company</th><th>Metric</th><th>Value</th><th>Period</th><th>Change</th><th>Confidence</th><th>Source evidence</th><th>State / action</th></tr></thead><tbody>
      {visible.length === 0 && <tr><td colSpan={8} className="empty-cell">{scopedRows.length ? "No observations match the current review filters." : "No observations are available for this snapshot yet."}</td></tr>}
      {visible.map((row, index) => <tr key={row.id} data-observation-id={row.id} aria-current={index === clampedFocusedIndex ? "true" : undefined}><td><div className="cell-stack"><strong>{row.company}</strong>{onViewPositionFinancials && row.companyId && <button type="button" className="inline-link" onClick={() => onViewPositionFinancials(row)}><Icon name="database" size={14}/>View position financials</button>}</div></td><td>{row.metric}</td><td><strong className="value-cell">{row.value}</strong></td><td>{row.period}</td><td className={`value-cell ${row.delta.startsWith("+") ? "positive" : ""}`}>{row.delta}</td><td><div className="confidence"><span>{row.confidence}%</span><div><i style={{width:`${row.confidence}%`}}/></div></div></td><td>{canReadSources ? <button className="source-link" disabled={!row.sourceReferenceId || busy === `source:${row.id}`} onClick={() => row.sourceReferenceId && void showSourceReference(row.sourceReferenceId, `source:${row.id}`)}><Icon name="source" size={14}/>{row.sourceReferenceId ? row.source : "No entitled source reference"}</button> : <span>{row.source}</span>}</td><td>{row.state === "Needs review" && canReview ? <div className="row-actions"><button className="secondary-button button-small" disabled={busy === row.id} onClick={() => void applyDecision(row,"approve")}>Approve</button><button className="text-button" disabled={busy === row.id} onClick={() => openReviewDialog(row,"correct")}>Correct</button><button className="text-button" disabled={busy === row.id} onClick={() => openReviewDialog(row,"reject")}>Reject</button></div> : <StatusPill status={row.state}/>}</td></tr>)}
    </tbody></table></div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Every published value must be traceable.</strong><span>Snapshot → consolidated fact → reviewed observation → source reference → original document. Exception resolutions are versioned and attributable.</span></div></div>

    {reviewDialog && <Modal label={`${reviewDialog.decision} observation`} onClose={() => setReviewDialog(null)} width="min(520px, 100%)"><form className="dialog-body" onSubmit={(event) => { event.preventDefault(); void submitReviewDialog(); }}><h2>{reviewDialog.decision === "correct" ? "Correct observation" : "Reject observation"}</h2><p>{reviewDialog.row.company} · {reviewDialog.row.metric} · currently <strong>{reviewDialog.row.value}</strong></p>{reviewDialog.decision === "correct" && <label className="form-field">Corrected value<input className="input-control" autoFocus value={reviewValue} onChange={(event) => setReviewValue(event.target.value)}/></label>}<label className="form-field">Reason<select value={reviewReason} onChange={(event) => setReviewReason(event.target.value)}><option value={reviewDialog.decision === "correct" ? "reviewer_corrected" : "reviewer_rejected"}>{reviewDialog.decision === "correct" ? "Reviewer correction" : "Reviewer rejection"}</option><option value="source_conflict">Source conflict</option><option value="duplicate">Duplicate disclosure</option><option value="out_of_scope">Out of scope</option><option value="other">Other governed reason</option></select></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setReviewDialog(null)}>Cancel</button><button type="submit" className={reviewDialog.decision === "reject" ? "danger-button" : "primary-button"} disabled={reviewDialog.decision === "correct" && !reviewValue.trim()}>Record decision</button></div></form></Modal>}
    {exceptionDialog && <Modal label="Resolve reconciliation exception" onClose={() => setExceptionDialog(null)} width="min(560px, 100%)"><form className="dialog-body" onSubmit={(event) => { event.preventDefault(); void submitExceptionDialog(); }}><h2>{actionLabel(exceptionDialog.action)}</h2><p>{exceptionDialog.item.summary}</p><label className="form-field">Resolution note<textarea autoFocus rows={4} value={exceptionNote} onChange={(event) => setExceptionNote(event.target.value)} placeholder="Optional evidence or rationale"/><span className="field-hint">Recorded with the versioned, attributable resolution.</span></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setExceptionDialog(null)}>Cancel</button><button type="submit" className="primary-button">Resolve exception</button></div></form></Modal>}
  </>;
}
