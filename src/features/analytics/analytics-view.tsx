"use client";
import { useState } from "react";
import type { SourceEvidence } from "@/core/workspace";
import { PerformanceScorecardView } from "@/features/analytics/performance-scorecard-view";
import { PositionFinancialsView, type PositionFinancialsFocusRequest } from "@/features/analytics/position-financials-view";

type AnalyticsLens = "financials" | "scorecard";

const LENSES: ReadonlyArray<{ id: AnalyticsLens; label: string }> = [
  { id: "financials", label: "Position financials" },
  { id: "scorecard", label: "Performance scorecard" },
];

/**
 * The Portfolio analytics module: one navigation entry, two lenses. Position financials is the default (and what a
 * drill-through from Data review or the Overview focuses); the performance scorecard (F1) shows what each GP reported
 * for every fund and its underlying investments. Switching lenses never changes what either one shows.
 */
export function AnalyticsView({ canReadSources = false, onOpenDocument, focusRequest, canExport = false }: {
  canReadSources?: boolean;
  onOpenDocument?: (documentId: string, location?: SourceEvidence) => void;
  focusRequest?: PositionFinancialsFocusRequest | null;
  canExport?: boolean;
}) {
  const [lens, setLens] = useState<AnalyticsLens>("financials");
  const [appliedFocusKey, setAppliedFocusKey] = useState(focusRequest?.key);
  // A drill-through focus is spent once the reader leaves Position financials, so coming back never re-applies a stale period.
  const [focusActive, setFocusActive] = useState(focusRequest != null);
  // A drill-through to a position always lands on Position financials, even if the scorecard was open.
  if (focusRequest && focusRequest.key !== appliedFocusKey) { setAppliedFocusKey(focusRequest.key); setFocusActive(true); setLens("financials"); }
  const choose = (next: AnalyticsLens) => { if (next === "scorecard") setFocusActive(false); setLens(next); };
  return <div className="analytics-module">
    <fieldset className="analytics-lens-switch">
      <legend className="visually-hidden">Analytics view</legend>
      {LENSES.map((item) => <button type="button" key={item.id} aria-pressed={lens === item.id} className={lens === item.id ? "active" : ""} onClick={() => choose(item.id)}>{item.label}</button>)}
    </fieldset>
    {lens === "financials"
      ? <PositionFinancialsView canExport={canExport} canReadSources={canReadSources} onOpenDocument={onOpenDocument} focusRequest={focusActive ? focusRequest : null}/>
      : <PerformanceScorecardView canReadSources={canReadSources} onOpenDocument={onOpenDocument} canExport={canExport}/>}
  </div>;
}
