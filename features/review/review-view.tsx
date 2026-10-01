"use client";
import { displayValue as formatValue, displayNumberFormatter, displayDate } from "@/lib/display-format";
import { usePreferences } from "@/features/preferences/preference-provider";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FundSnapshot, ObservationRecord } from "@/core/contracts";
import type { ReconciliationException, ReconciliationResolutionAction } from "@/core/enterprise";
import { scopeObservationsToSnapshot } from "@/core/review-scope";
import type { SourceEvidence } from "@/core/workspace";
import { safeGetItem, safeSetItem } from "@/lib/safe-storage";
import { workspaceStorageKey } from "@/lib/workspace-context";
import { deliveryPort } from "@/runtime/delivery-services";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { comparePeriods } from "@/core/workspace-summary";
import { SavedViews } from "@/features/preferences/saved-views";
import { VIEW_COLUMNS, type ViewConfiguration } from "@/core/saved-views";
import { TimeSeriesChart, type TimeSeriesPoint } from "@/components/ui/charts/time-series-chart";
import { displayValue } from "@/lib/display-format";
import { StatusPill } from "@/components/ui/status-pill";

const URGENT_REVIEW_DAYS = 3;
type MaterialityFilter = "all" | ReconciliationException["materiality"];
type ReviewPriority = { materiality: ReconciliationException["materiality"]; deadlineAt?: string; daysToDeadline?: number };

type ReconciliationValue = { number?: unknown; string?: unknown; raw?: unknown; currency?: unknown; unit?: unknown };
type PriorPublished = { snapshotId?: string; reportPeriod?: string; publishedAt?: string; value?: ReconciliationValue };
type CompetingValue = { observationId?: string; sourceReferenceId?: string; value?: ReconciliationValue; riskTier?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function contextString(item: ReconciliationException, key: string): string | undefined {
  const value = item.context[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
function priorPublished(item: ReconciliationException): PriorPublished | undefined {
  const value = record(item.context.priorPublished);
  return value as PriorPublished | undefined;
}
function publishedHistory(item: ReconciliationException): TimeSeriesPoint[] {
  const history = Array.isArray(item.context.publishedHistory) ? item.context.publishedHistory : [];
  return history.flatMap((raw) => { const point = record(raw); const value = record(point?.value); const numeric = numericReconciliationValue(value); if (!point || typeof point.reportPeriod !== "string" || numeric == null) return [];
    return [{ period: point.reportPeriod, label: point.reportPeriod, value: numeric, status: (point.preliminary === true ? "preliminary" : point.restated === true ? "restated" : point.derived === true ? "derived" : "final") as TimeSeriesPoint["status"] }]; }).sort((a, b) => comparePeriods(a.period, b.period)).slice(-4);
}
function competingValues(item: ReconciliationException): CompetingValue[] {
  return Array.isArray(item.context.competingValues) ? item.context.competingValues.filter((value) => record(value)).map((value) => value as CompetingValue) : [];
}
function numericReconciliationValue(value: ReconciliationValue | undefined): number | undefined {
  if (!value || value.number == null) return undefined;
  const numeric = Number(value.number);
  return Number.isFinite(numeric) ? numeric : undefined;
}
function displayReconciliationValue(value: ReconciliationValue | undefined): string {
  if (!value) return "—";
  if (value.string != null && String(value.string).trim()) return String(value.string);
  const numeric = numericReconciliationValue(value);
  if (numeric != null) {
    const formatted = displayNumberFormatter({ maximumFractionDigits: 2 }).format(numeric);
    return `${typeof value.currency === "string" && value.currency ? `${value.currency} ` : ""}${formatted}${typeof value.unit === "string" && value.unit ? ` ${value.unit}` : ""}`;
  }
  return value.raw == null ? "—" : String(value.raw);
}
function reconciliationDelta(current: ReconciliationValue | undefined, prior: ReconciliationValue | undefined): string | undefined {
  const currentNumber = numericReconciliationValue(current);
  const priorNumber = numericReconciliationValue(prior);
  if (currentNumber == null || priorNumber == null) return undefined;
  const delta = currentNumber - priorNumber;
  const absolute = `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${displayNumberFormatter({ maximumFractionDigits: 2 }).format(Math.abs(delta))}`;
  if (priorNumber === 0) return absolute;
  const percent = delta / Math.abs(priorNumber) * 100;
  return `${absolute} · ${percent > 0 ? "+" : percent < 0 ? "−" : ""}${displayNumberFormatter({ maximumFractionDigits: 1 }).format(Math.abs(percent))}%`;
}
function deadlinePriority(deadlineAt: string | undefined): Pick<ReviewPriority,"deadlineAt"|"daysToDeadline"> {
  if (!deadlineAt) return {};
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) return {};
  return { deadlineAt, daysToDeadline: Math.ceil((deadline - Date.now()) / 86_400_000) };
}
function exceptionMatchesObservation(item: ReconciliationException, row: ObservationRecord): boolean {
  if (item.metricCode && item.metricCode !== row.metric) return false;
  if (!item.subjectId) return false;
  return [row.companyId,row.holdingId,row.fundId].filter(Boolean).includes(item.subjectId);
}
function reviewPriority(row: ObservationRecord, exceptions: ReconciliationException[]): ReviewPriority {
  const open = exceptions.filter((item) => item.status === "open");
  const matches = open.filter((item) => exceptionMatchesObservation(item,row));
  const materiality = matches.some((item) => item.materiality === "material") ? "material"
    : matches.some((item) => item.materiality === "immaterial") ? "immaterial" : "unknown";
  const deadlineAt = matches.map((item) => contextString(item,"reviewDeadlineAt")).find(Boolean)
    ?? open.map((item) => contextString(item,"reviewDeadlineAt")).find(Boolean);
  return { materiality, ...deadlinePriority(deadlineAt) };
}
function materialityWeight(value: ReviewPriority["materiality"]): number {
  return value === "material" ? 0 : value === "unknown" ? 1 : 2;
}
function deadlineLabel(priority: ReviewPriority): string {
  if (priority.daysToDeadline == null) return "No deadline set";
  if (priority.daysToDeadline < 0) return `${Math.abs(priority.daysToDeadline)}d overdue`;
  if (priority.daysToDeadline === 0) return "Due today";
  return `${priority.daysToDeadline}d remaining`;
}
function ruleLabel(item: ReconciliationException): string {
  return (contextString(item,"triggerRule") ?? item.type).replaceAll("_"," ");
}

function actionLabel(action: ReconciliationResolutionAction): string {
  if (action === "select_source") return "Select authoritative source";
  if (action === "mark_immaterial") return "Mark immaterial";
  return "Accept reconciliation";
}

// Critical observations require two independent approvals before they leave
// "Needs review" (see corvis_facts.apply_review_decision); this makes that
// dual-control state visible on the row instead of only enforcing it silently
// on the next approve attempt (#182 D6).
function awaitingSecondApproval(row: ObservationRecord): boolean {
  return row.riskTier === "critical" && row.state === "Needs review" && (row.approvedReviewerCount ?? 0) >= 1;
}
function dualControlLabel(row: ObservationRecord): string | undefined {
  if (row.riskTier !== "critical") return undefined;
  if (awaitingSecondApproval(row)) return "1st approval recorded, 2nd required";
  if (row.state === "Needs review") return "Dual control required";
  return undefined;
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
type PersistedReviewState = { stateFilter: string; query: string; confidenceFilter: string; materialityFilter?: string; dualControlFilter?: string; sortMode: string; focusedObservationId?: string };
function readPersistedReviewState(): PersistedReviewState | null {
  const raw = safeGetItem("session", workspaceStorageKey(REVIEW_UI_STATE_KEY));
  if (!raw) return null;
  try { return JSON.parse(raw) as PersistedReviewState; } catch { return null; }
}
function writePersistedReviewState(state: PersistedReviewState): void {
  safeSetItem("session", workspaceStorageKey(REVIEW_UI_STATE_KEY), JSON.stringify(state));
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
  onViewPositionFinancials, snapshots = [], onSelectSnapshot, canResearch = false, onExplainException, onOpenDocument,
}: {
  snapshots?: FundSnapshot[]; onSelectSnapshot?: (id: string) => void; canResearch?: boolean; onExplainException?: (item: ReconciliationException) => void; onOpenDocument?: (id: string, location?: SourceEvidence) => void;
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
  usePreferences();
  const [visibleColumns, setVisibleColumns] = useState(VIEW_COLUMNS.review);
  const [unavailableSavedScope, setUnavailableSavedScope] = useState(false);
  // A fresh drill-through (focusRequest) always starts from a clean scope so the
  // requested observation can't be hidden by a stale filter; otherwise restore
  // whatever was last persisted (e.g. returning from Position Financials).
  const persistedReviewState = focusRequest ? null : readPersistedReviewState();
  const [stateFilter, setStateFilter] = useState<"all" | ObservationRecord["state"]>((persistedReviewState?.stateFilter as "all" | ObservationRecord["state"] | undefined) ?? "all");
  const [query, setQuery] = useState(persistedReviewState?.query ?? "");
  const [confidenceFilter, setConfidenceFilter] = useState<"all" | "under90" | "under75">((persistedReviewState?.confidenceFilter as "all" | "under90" | "under75" | undefined) ?? "all");
  const [materialityFilter, setMaterialityFilter] = useState<MaterialityFilter>((persistedReviewState?.materialityFilter as MaterialityFilter | undefined) ?? "all");
  const [dualControlFilter, setDualControlFilter] = useState<"all" | "awaiting_second">((persistedReviewState?.dualControlFilter as "all" | "awaiting_second" | undefined) ?? "all");
  const [sortMode, setSortMode] = useState<"risk" | "company" | "confidence" | "materiality" | "deadline">((persistedReviewState?.sortMode as "risk" | "company" | "confidence" | "materiality" | "deadline" | undefined) ?? "risk");
  const [overrides, setOverrides] = useState<Record<string, ObservationRecord>>({});
  const rows = useMemo(() => observations.map((row) => {
    const override = overrides[row.id];
    return override && (override.version ?? 0) > (row.version ?? 0) ? override : row;
  }), [observations, overrides]);
  // Each in-flight action is tracked under its own key so finishing one never clears the busy
  // state of another that is still running (e.g. opening evidence while an approval is pending).
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const startBusy = (key: string) => setBusyKeys((current) => new Set(current).add(key));
  const endBusy = (key: string) => setBusyKeys((current) => { const next = new Set(current); next.delete(key); return next; });
  const busy = { has: (key: string) => busyKeys.has(key) };
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [evidence, setEvidence] = useState<SourceEvidence | null>(null);
  const [exceptionState, setExceptionState] = useState<{ key: string; items: ReconciliationException[]; error?: string }>({ key: "", items: [] });
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
    setMaterialityFilter("all");
    setDualControlFilter("all");
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
        const text = error instanceof Error ? error.message : "Reconciliation exceptions could not be loaded";
        setExceptionState({ key: exceptionKey, items: [], error: text });
        setMessage({ text, tone: "error" });
      });
    return () => { active = false; };
  }, [canReview, snapshotId, snapshotVersion, exceptionKey]);

  const exceptions = useMemo(
    () => canReview && exceptionState.key === exceptionKey ? exceptionState.items : [],
    [canReview, exceptionKey, exceptionState],
  );
  const exceptionsError = canReview && exceptionState.key === exceptionKey ? exceptionState.error : undefined;
  const exceptionsLoaded = !canReview || !exceptionKey || exceptionState.key === exceptionKey;
  const savedConfiguration: ViewConfiguration = { stateFilter, query, confidenceFilter, materialityFilter, dualControlFilter, sortMode, snapshotId: snapshot?.id ?? "", columns: visibleColumns };
  const applySavedConfiguration = (v: ViewConfiguration) => {
    setQuery(String(v.query ?? "")); setStateFilter((v.stateFilter ?? "all") as typeof stateFilter); setConfidenceFilter((v.confidenceFilter ?? "all") as typeof confidenceFilter); setMaterialityFilter((v.materialityFilter ?? "all") as typeof materialityFilter); setDualControlFilter((v.dualControlFilter ?? "all") as typeof dualControlFilter); setSortMode((v.sortMode ?? "risk") as typeof sortMode); setVisibleColumns(v.columns as string[] ?? VIEW_COLUMNS.review);
    const requested = String(v.snapshotId ?? ""); setUnavailableSavedScope(!!requested && !snapshots.some((item) => item.id === requested)); if (requested && snapshots.some((item) => item.id === requested)) onSelectSnapshot?.(requested);
  };
  const scopedRows = useMemo(() => unavailableSavedScope ? [] : scopeObservationsToSnapshot(rows, snapshot), [unavailableSavedScope, rows, snapshot]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = scopedRows.filter((row) => {
      const priority = reviewPriority(row,exceptions);
      if (stateFilter !== "all" && row.state !== stateFilter) return false;
      if (confidenceFilter === "under90" && row.confidence >= 90) return false;
      if (confidenceFilter === "under75" && row.confidence >= 75) return false;
      if (materialityFilter !== "all" && priority.materiality !== materialityFilter) return false;
      if (dualControlFilter === "awaiting_second" && !awaitingSecondApproval(row)) return false;
      if (normalized && !`${row.company} ${row.metric} ${row.value} ${row.period} ${row.source}`.toLowerCase().includes(normalized)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sortMode === "company") return `${a.company}:${a.metric}`.localeCompare(`${b.company}:${b.metric}`);
      if (sortMode === "confidence") return a.confidence - b.confidence;
      const aPriority = reviewPriority(a,exceptions);
      const bPriority = reviewPriority(b,exceptions);
      if (sortMode === "materiality") return materialityWeight(aPriority.materiality) - materialityWeight(bPriority.materiality) || a.confidence - b.confidence;
      if (sortMode === "deadline") return (aPriority.daysToDeadline ?? Number.POSITIVE_INFINITY) - (bPriority.daysToDeadline ?? Number.POSITIVE_INFINITY) || materialityWeight(aPriority.materiality) - materialityWeight(bPriority.materiality);
      const stateWeight = (row: ObservationRecord) => row.state === "Needs review" ? 0 : row.state === "Rejected" ? 1 : 2;
      return stateWeight(a) - stateWeight(b) || materialityWeight(aPriority.materiality) - materialityWeight(bPriority.materiality) || a.confidence - b.confidence || a.company.localeCompare(b.company);
    });
  }, [confidenceFilter, dualControlFilter, exceptions, materialityFilter, query, scopedRows, sortMode, stateFilter]);
  const needsReview = scopedRows.filter((row) => row.state === "Needs review").length;
  const approved = scopedRows.filter((row) => row.state === "Approved").length;
  const awaitingSecondReviewer = scopedRows.filter(awaitingSecondApproval).length;
  const openExceptions = exceptions.filter((item) => item.status === "open");
  const useGovernedExceptionCount = canReview && exceptionsLoaded && (exceptions.length > 0 || (snapshot?.blockingExceptions ?? 0) === 0);
  const blockingExceptions = useGovernedExceptionCount ? openExceptions.length : snapshot?.blockingExceptions ?? 0;
  const alreadyPublished = snapshot?.status === "Published";
  const publishBlocked = unavailableSavedScope || !snapshot?.id || !snapshot.version || alreadyPublished || needsReview > 0 || blockingExceptions > 0;
  const requestedFocusIndex = "observationId" in queueFocus ? visible.findIndex((row) => row.id === queueFocus.observationId) : queueFocus.index;
  const clampedFocusedIndex = Math.min(Math.max(requestedFocusIndex, 0), Math.max(visible.length - 1, 0));
  const focused = visible[clampedFocusedIndex];
  useEffect(() => {
    writePersistedReviewState({ stateFilter, query, confidenceFilter, materialityFilter, dualControlFilter, sortMode, focusedObservationId: focused?.id });
  },[confidenceFilter,dualControlFilter,focused?.id,materialityFilter,query,sortMode,stateFilter]);
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
    startBusy("export"); setMessage(null);
    try {
      await deliveryPort.createExport("csv", { snapshotId: snapshot.id });
      setMessage({ text: "Export requested for this snapshot. Download it from Data delivery once it's ready.", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Export request failed", tone: "error" }); }
    finally { endBusy("export"); }
  };

  const applyDecision = async (row: ObservationRecord, decision: "approve" | "reject" | "correct", correctedValue?: string, reasonCode?: string) => {
    if (!canReview) return;
    startBusy(row.id); setMessage(null);
    try {
      const outcome = await workspacePort.review({ observationId: row.id, decision, reasonCode: reasonCode || (decision === "approve" ? "reviewer_verified" : decision === "reject" ? "reviewer_rejected" : "reviewer_corrected"), correctedValue, expectedVersion: row.version || 1 });
      const updated: ObservationRecord = { ...row, value: decision === "correct" && correctedValue ? correctedValue : row.value, state: outcome.nextState === "approved" ? "Approved" : outcome.nextState === "rejected" ? "Rejected" : "Needs review", version: outcome.newVersion };
      setOverrides((current) => ({ ...current, [row.id]: updated }));
      onObservationUpdated?.(updated);
      if (decision === "approve" && outcome.nextState === "review_required") setMessage({ text: "First critical approval recorded; an independent second reviewer is still required.", tone: "success" });
      else setMessage({ text: decision === "approve" ? "Observation approval recorded." : decision === "reject" ? "Observation rejected and retained in review history." : "Correction recorded; the corrected observation remains review-required until approved.", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Review failed", tone: "error" }); }
    finally { endBusy(row.id); }
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
    startBusy(busyKey); setMessage(null);
    try {
      const opened = await workspacePort.sourceEvidence(sourceReferenceId);
      if (requestId === evidenceRequestRef.current) setEvidence(opened);
    } catch (error) {
      if (requestId === evidenceRequestRef.current) setMessage({ text: error instanceof Error ? error.message : "Source evidence could not be opened", tone: "error" });
    } finally { endBusy(busyKey); }
  };

  const resolveException = async (item: ReconciliationException, action: ReconciliationResolutionAction, note: string) => {
    if (!canReview) return;
    const selectedSourceReferenceId = action === "select_source" ? selectedSources[item.exceptionId] || item.sourceReferences[0]?.sourceReferenceId : undefined;
    if (action === "select_source" && !selectedSourceReferenceId) { setMessage({ text: "No entitled competing source is available for this source-authority decision.", tone: "error" }); return; }
    startBusy(`exception:${item.exceptionId}`); setMessage(null);
    try {
      const outcome = await workspacePort.resolveReconciliation({ exceptionId: item.exceptionId, expectedVersion: item.version, action, reasonCode: `reviewer_${action}`, selectedSourceReferenceId, note: note.trim() || undefined });
      setExceptionState((current) => current.key !== exceptionKey ? current : { key: current.key, items: current.items.map((exception) => exception.exceptionId === item.exceptionId ? { ...exception, status: "resolved", version: outcome.newVersion, resolvedAt: new Date().toISOString() } : exception) });
      setMessage({ text: `Reconciliation exception resolved: ${actionLabel(action)}.`, tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Reconciliation resolution failed", tone: "error" }); }
    finally { endBusy(`exception:${item.exceptionId}`); }
  };

  const openExceptionDialog = (item: ReconciliationException, action: ReconciliationResolutionAction) => { setExceptionDialog({ item, action }); setExceptionNote(""); };
  const submitExceptionDialog = async () => { if (!exceptionDialog) return; const dialog = exceptionDialog; setExceptionDialog(null); await resolveException(dialog.item, dialog.action, exceptionNote); };

  const publish = async () => {
    if (!canPublish || !snapshot?.id || !snapshot.version || publishBlocked) return;
    startBusy("publish"); setMessage(null);
    try {
      await workspacePort.publish({ snapshotId: snapshot.id, action: "publish", expectedVersion: snapshot.version });
      const published: FundSnapshot = { ...snapshot, status: "Published", version: snapshot.version + 1, changed: "Just now", blockingExceptions: 0 };
      onPublished?.(published);
      setMessage({ text: "Snapshot publication accepted and recorded in the serving audit trail.", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Publication failed", tone: "error" }); }
    finally { endBusy("publish"); }
  };

  return <>
    <section className="page-heading"><div><p className="eyebrow">Trusted data</p><h1>Data review</h1><p className="lede">{snapshot ? `${snapshot.fund} · ${snapshot.period}${snapshot.version ? ` · Snapshot v${snapshot.version}` : ""}` : "Select a review-ready fund-period snapshot"}</p></div><div className="heading-actions">{canExport && snapshot?.id && <button className="secondary-button" disabled={!alreadyPublished || busy.has("export")} title={alreadyPublished ? undefined : "Publish this snapshot first: the governed export pipeline only exports published, audited data"} onClick={() => void requestExport()}><Icon name="download"/>{busy.has("export") ? "Requesting export…" : "Export this snapshot"}</button>}{canPublish && <button className="primary-button" disabled={publishBlocked || busy.has("publish")} onClick={() => void publish()}><Icon name="check"/>{busy.has("publish") ? "Publishing…" : alreadyPublished ? "Published" : "Publish snapshot"}</button>}</div></section>
    {canPublish && publishBlocked && !alreadyPublished && snapshot?.id && <div className="lineage-note tone-warning" role="status"><Icon name="alert"/><div><strong>Publication gate is closed</strong><span>{formatValue(needsReview)} {needsReview === 1 ? "observation needs" : "observations need"} review and {formatValue(blockingExceptions)} reconciliation {blockingExceptions === 1 ? "exception remains" : "exceptions remain"} open.</span></div></div>}
    {!canReview && <div className="lineage-note" role="status"><Icon name="shield"/><div><strong>Read-only trusted data</strong><span>Your current role can inspect observations but cannot approve, correct or resolve review exceptions.</span></div></div>}
    <SavedViews screen="review" configuration={savedConfiguration} onApply={applySavedConfiguration} onColumns={setVisibleColumns} skipDefault={!!focusRequest}/>
    {unavailableSavedScope && <p role="status">This saved view references a snapshot you cannot currently access. Choose another view or snapshot.</p>}
    {message && <div className={`lineage-note ${message.tone === "error" ? "tone-danger" : "tone-success"}`} role={message.tone === "error" ? "alert" : "status"}><Icon name={message.tone === "error" ? "alert" : "shield"}/><div><strong>{message.tone === "error" ? "Workflow action failed" : "Workflow status"}</strong><span>{message.text}</span></div></div>}
    {evidence && <div className="lineage-note" role="region" aria-label="Source evidence"><Icon name="source"/><div><strong>Exact source evidence</strong><span>{`Document ${evidence.documentId}${evidence.page ? ` · page ${evidence.page}` : ""}${evidence.sheetName ? ` · ${evidence.sheetName}` : ""}${evidence.cellRange ? ` · ${evidence.cellRange}` : ""}`}</span>{onOpenDocument && canReadSources && <button className="secondary-button" onClick={() => onOpenDocument(evidence.documentId, evidence)}>Open full document</button>}{evidence.excerpt && <span>{evidence.excerpt}</span>}</div><button className="text-button" onClick={() => { evidenceRequestRef.current += 1; setEvidence(null); }}>Close</button></div>}
    <div className="review-summary" role="group" aria-label="Snapshot review summary"><div><span>Observations</span><strong>{formatValue(scopedRows.length)}</strong></div><div><span>Approved</span><strong>{formatValue(approved)}</strong></div><div><span>Needs review</span><strong className="amber">{formatValue(needsReview)}</strong></div><div><span>Awaiting 2nd reviewer</span><strong className="amber">{formatValue(awaitingSecondReviewer)}</strong></div><div><span>Holdings</span><strong>{snapshot?.holdings ?? "—"}</strong></div><div><span>Blocking exceptions</span><strong>{formatValue(blockingExceptions)}</strong></div></div>

    {canReview && snapshot?.id && <div className="table-card" tabIndex={0} role="region" aria-label="Reconciliation exceptions table"><table className="data-table"><thead><tr><th>Exception</th><th>Cause / prior published</th><th>Competing evidence</th><th>Status</th><th>Resolution</th></tr></thead><tbody>
      {!exceptionsLoaded && <tr><td colSpan={5} className="empty-cell">Loading reconciliation exceptions…</td></tr>}
      {exceptionsError && <tr><td colSpan={5} className="empty-cell" role="alert">Reconciliation exceptions could not be loaded ({exceptionsError}). Exceptions may exist that are not shown here.</td></tr>}
      {exceptionsLoaded && !exceptionsError && exceptions.length === 0 && <tr><td colSpan={5} className="empty-cell">No governed reconciliation exceptions are recorded for this snapshot version.</td></tr>}
      {exceptions.map((item) => {
        const selectedSource = selectedSources[item.exceptionId] || (item.sourceReferences.length === 1 ? item.sourceReferences[0]?.sourceReferenceId ?? "" : "");
        const prior = priorPublished(item);
        const current = competingValues(item);
        return <tr key={item.exceptionId}>
          <td><strong className="capitalize">{item.type.replaceAll("_", " ")}</strong><span className="table-secondary">{item.summary}</span><span className="table-secondary">{[item.subjectType,item.subjectId,item.metricCode,item.materiality !== "unknown" ? item.materiality : undefined].filter(Boolean).join(" · ") || "Snapshot-level blocker"}</span></td>
          <td><div className="cell-stack"><span><strong>Why flagged:</strong> {ruleLabel(item)}</span>{prior ? <span><strong>Prior published {prior.reportPeriod ?? "period"}:</strong> {displayReconciliationValue(prior.value)}</span> : <span className="table-secondary">No matching prior published value</span>}{contextString(item,"reviewDeadlineAt") && <span><strong>Review deadline:</strong> {displayDate(contextString(item,"reviewDeadlineAt")!, { timeStyle: "short" })}</span>}</div></td>
          <td><div className="cell-stack">{current.length > 0 && current.map((candidate,index) => { const delta = reconciliationDelta(candidate.value,prior?.value); const source = item.sourceReferences.find((entry) => entry.sourceReferenceId === candidate.sourceReferenceId); return <span key={`${candidate.observationId ?? "value"}:${index}`}><strong>{displayReconciliationValue(candidate.value)}</strong>{delta ? ` · Δ ${delta}` : ""}{source && canReadSources ? <> · <button className="source-link" disabled={busy.has(`exception-source:${source.sourceReferenceId}`)} onClick={() => void showSourceReference(source.sourceReferenceId, `exception-source:${source.sourceReferenceId}`)}><Icon name="source" size={14}/>{source.page ? `Page ${source.page}` : source.sheetName || source.documentId}</button></> : candidate.sourceReferenceId ? ` · ${candidate.sourceReferenceId}` : ""}</span>; })}{current.length === 0 && (item.sourceReferences.length ? <div className="heading-actions">{item.sourceReferences.map((source) => canReadSources ? <button key={source.sourceReferenceId} className="source-link" disabled={busy.has(`exception-source:${source.sourceReferenceId}`)} onClick={() => void showSourceReference(source.sourceReferenceId, `exception-source:${source.sourceReferenceId}`)}><Icon name="source" size={14}/>{source.page ? `Page ${source.page}` : source.sheetName || source.documentId}</button> : <span key={source.sourceReferenceId}>{source.page ? `Page ${source.page}` : source.documentId}</span>)}</div> : "No entitled source excerpt available")}</div></td>
          <td>{item.status === "open" ? <StatusPill status="Needs review"/> : <StatusPill status="Approved"/>}</td>
          <td>{canResearch && onExplainException && <button className="text-button" onClick={() => onExplainException(item)}>Explain with Ask Corvis</button>}{item.status === "open" ? <div className="heading-actions">{item.type === "source_authority" && <select className="filter-button inline-select" aria-label={`Authoritative source for ${item.summary}`} value={selectedSource} onChange={(event) => setSelectedSources((currentState) => ({ ...currentState, [item.exceptionId]: event.target.value }))}><option value="">Choose source</option>{item.sourceReferences.map((source) => <option key={source.sourceReferenceId} value={source.sourceReferenceId}>{source.page ? `Page ${source.page}` : source.documentId}</option>)}</select>}{item.allowedActions.map((action) => <button key={action} className="secondary-button button-small" disabled={busy.has(`exception:${item.exceptionId}`) || (action === "select_source" && !selectedSource)} onClick={() => openExceptionDialog(item, action)}>{actionLabel(action)}</button>)}</div> : <span>Resolved {item.resolvedAt ? displayDate(item.resolvedAt, { timeStyle: "short" }) : ""}</span>}</td>
        </tr>;
      })}
    </tbody></table></div>}

    <div className="toolbar" aria-label="Review filters"><label className="search-field"><Icon name="search"/><input aria-label="Search review observations" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search company, metric, value or source"/></label><select className="filter-button" aria-label="Review state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">All states</option><option value="Needs review">Needs review</option><option value="Approved">Approved</option><option value="Rejected">Rejected</option></select><select className="filter-button" aria-label="Confidence risk" value={confidenceFilter} onChange={(event) => setConfidenceFilter(event.target.value as typeof confidenceFilter)}><option value="all">All confidence</option><option value="under90">Under 90%</option><option value="under75">Under 75%</option></select><select className="filter-button" aria-label="Materiality" value={materialityFilter} onChange={(event) => setMaterialityFilter(event.target.value as MaterialityFilter)}><option value="all">All materiality</option><option value="material">Material</option><option value="unknown">Unknown / unclassified</option><option value="immaterial">Immaterial</option></select><select className="filter-button" aria-label="Dual control" value={dualControlFilter} onChange={(event) => setDualControlFilter(event.target.value as typeof dualControlFilter)}><option value="all">All dual control</option><option value="awaiting_second">Awaiting 2nd reviewer</option></select><select className="filter-button" aria-label="Review sort" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="risk">Risk first</option><option value="materiality">Materiality first</option><option value="deadline">Deadline first</option><option value="confidence">Lowest confidence</option><option value="company">Company / metric</option></select><span className="result-count" role="status">{formatValue(visible.length)} shown</span><div className="toolbar-spacer"/><div className="toolbar-group"><button className="text-button" disabled={!visible.length || clampedFocusedIndex <= 0} onClick={() => moveFocus(-1)}>Previous</button><button className="text-button" disabled={!visible.length || clampedFocusedIndex >= visible.length - 1} onClick={() => moveFocus(1)}>Next</button></div></div>
    {focused && (() => { const priority = reviewPriority(focused,exceptions); return <div className="lineage-note" role="status" aria-label="Focused review item"><Icon name="table"/><div><strong>Review queue {clampedFocusedIndex + 1} of {formatValue(visible.length)}</strong><span>{focused.company} · {focused.metric} · {formatValue(focused.confidence)}% confidence · {priority.materiality} · {deadlineLabel(priority)}</span></div></div>; })()}
    <div className="table-card" tabIndex={0} role="region" aria-label="Data review observations table"><table className="data-table review-table" data-hidden-columns={VIEW_COLUMNS.review.map((v, i) => visibleColumns.includes(v) ? "" : String(i + 1)).filter(Boolean).join(" ")}><thead><tr><th>Company</th><th>Metric</th><th>Value</th><th>Period</th><th>Change</th><th>Priority</th><th>Confidence</th><th>Source evidence</th><th>State / action</th></tr></thead><tbody>
      {visible.length === 0 && <tr><td colSpan={9} className="empty-cell">{scopedRows.length ? "No observations match the current review filters." : "No entitled observations are available for this saved scope or snapshot yet."}</td></tr>}
      {visible.map((row, index) => { const priority = reviewPriority(row,exceptions); const urgent = priority.daysToDeadline != null && priority.daysToDeadline <= URGENT_REVIEW_DAYS; const dualControl = dualControlLabel(row); return <tr key={row.id} data-observation-id={row.id} aria-current={index === clampedFocusedIndex ? "true" : undefined}><td><div className="cell-stack"><strong>{row.company}</strong>{onViewPositionFinancials && row.companyId && <button type="button" className="inline-link" onClick={() => onViewPositionFinancials(row)}><Icon name="database" size={14}/>View position financials</button>}</div></td><td>{row.metric}</td><td><strong className="value-cell">{displayValue(row.value)}</strong></td><td>{row.period}</td><td className={`value-cell ${row.delta.startsWith("+") ? "positive" : ""}`}>{displayValue(row.delta)}</td><td><div className="cell-stack"><strong className="capitalize">{priority.materiality}</strong><span className={urgent ? "amber" : "table-secondary"}>{deadlineLabel(priority)}</span></div></td><td><div className="confidence"><span>{displayValue(row.confidence)}%</span><div><i style={{width:`${row.confidence}%`}}/></div></div></td><td>{canReadSources ? <button className="source-link" disabled={!row.sourceReferenceId || busy.has(`source:${row.id}`)} onClick={() => row.sourceReferenceId && void showSourceReference(row.sourceReferenceId, `source:${row.id}`)}><Icon name="source" size={14}/>{row.sourceReferenceId ? row.source : "No entitled source reference"}</button> : <span>{row.source}</span>}</td><td>{row.state === "Needs review" && canReview ? <div className="cell-stack"><div className="row-actions"><button className="secondary-button button-small" disabled={busy.has(row.id)} onClick={() => void applyDecision(row,"approve")}>Approve</button><button className="text-button" disabled={busy.has(row.id)} onClick={() => openReviewDialog(row,"correct")}>Correct</button><button className="text-button" disabled={busy.has(row.id)} onClick={() => openReviewDialog(row,"reject")}>Reject</button></div>{dualControl && <span className="table-secondary" role="status">{dualControl}</span>}</div> : <div className="cell-stack"><StatusPill status={row.state}/>{dualControl && <span className="table-secondary">{dualControl}</span>}</div>}</td></tr>; })}
    </tbody></table></div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Every published value must be traceable.</strong><span>Snapshot → consolidated fact → reviewed observation → source reference → original document. Exception resolutions are versioned and attributable.</span></div></div>

    {reviewDialog && <Modal label={`${reviewDialog.decision} observation`} onClose={() => setReviewDialog(null)} width="min(520px, 100%)"><form className="dialog-body" onSubmit={(event) => { event.preventDefault(); void submitReviewDialog(); }}><h2>{reviewDialog.decision === "correct" ? "Correct observation" : "Reject observation"}</h2><p>{reviewDialog.row.company} · {reviewDialog.row.metric} · currently <strong>{reviewDialog.row.value}</strong></p>{reviewDialog.decision === "correct" && <label className="form-field">Corrected value<input className="input-control" autoFocus value={reviewValue} onChange={(event) => setReviewValue(event.target.value)}/></label>}<label className="form-field">Reason<select value={reviewReason} onChange={(event) => setReviewReason(event.target.value)}><option value={reviewDialog.decision === "correct" ? "reviewer_corrected" : "reviewer_rejected"}>{reviewDialog.decision === "correct" ? "Reviewer correction" : "Reviewer rejection"}</option><option value="source_conflict">Source conflict</option><option value="duplicate">Duplicate disclosure</option><option value="out_of_scope">Out of scope</option><option value="other">Other governed reason</option></select></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setReviewDialog(null)}>Cancel</button><button type="submit" className={reviewDialog.decision === "reject" ? "danger-button" : "primary-button"} disabled={reviewDialog.decision === "correct" && !reviewValue.trim()}>Record decision</button></div></form></Modal>}
    {exceptionDialog && <Modal label="Resolve reconciliation exception" onClose={() => setExceptionDialog(null)} width="min(560px, 100%)"><form className="dialog-body" onSubmit={(event) => { event.preventDefault(); void submitExceptionDialog(); }}><h2>{actionLabel(exceptionDialog.action)}</h2><p>{exceptionDialog.item.summary}</p>{competingValues(exceptionDialog.item).map((candidate, index) => <p key={index}>Competing value {index + 1}: <strong>{displayReconciliationValue(candidate.value)}</strong></p>)}<TimeSeriesChart name="Published metric" title="Recent published history" description={`Published values for the same subject and metric${typeof competingValues(exceptionDialog.item)[0]?.value?.currency === "string" ? ` · ${competingValues(exceptionDialog.item)[0].value!.currency}` : ""}${typeof competingValues(exceptionDialog.item)[0]?.value?.unit === "string" ? ` · ${competingValues(exceptionDialog.item)[0].value!.unit}` : ""}`} data={publishedHistory(exceptionDialog.item)} emptyMessage="No published history"/><label className="form-field">Resolution note<textarea autoFocus rows={4} value={exceptionNote} onChange={(event) => setExceptionNote(event.target.value)} placeholder="Optional evidence or rationale"/><span className="field-hint">Recorded with the versioned, attributable resolution.</span></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setExceptionDialog(null)}>Cancel</button><button type="submit" className="primary-button">Resolve exception</button></div></form></Modal>}
  </>;
}
