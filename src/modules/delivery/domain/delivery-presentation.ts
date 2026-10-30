/** Plain-language labels Data delivery's history rows show, extracted from delivery-view.tsx so they are testable. */

import type { ExportDeliveryStatus, ExportFormat } from "./delivery.ts";
import type { ExportManifest } from "../../../shared/domain/enterprise.ts";

export const DELIVERY_FORMATS: { value: ExportFormat; label: string; detail: string }[] = [
  { value: "csv", label: "CSV", detail: "Portable tabular delivery for downstream workflows." },
  { value: "xlsx", label: "Excel", detail: "Human-friendly workbook delivery for investment and operations teams." },
  { value: "parquet", label: "Parquet", detail: "Typed analytical delivery for data-platform ingestion." },
];

export type ScopedManifest = ExportManifest & { scopeLabel?: string };
/** History rows an export schedule requested carry its label and trigger (F4). */
export type ListedExport = ExportDeliveryStatus & { schedule?: import("./export-schedule.ts").ScheduledExportMarker };

export function stateLabel(state: string): string {
  return state.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

// Exports created before this field existed have no manifest.source; they were
// all full-tenant requests from Data delivery itself, so that's the honest default.
export function sourceLabel(source: ExportManifest["source"]): string {
  return source === "review" ? "Data review" : "Data delivery";
}

export function scopeLabel(manifest: ExportManifest): string {
  return (manifest as ScopedManifest).scopeLabel || "All entitled published snapshots";
}

export function rowCoverage(manifest: ExportManifest): string {
  const positionRows = manifest.rowCounts.positionFinancials;
  const scorecardRows = manifest.rowCounts.performanceScorecard;
  if (scorecardRows != null) return `${scorecardRows} scorecard rows · ${manifest.snapshotIds.length} snapshots`;
  if (positionRows != null) return `${positionRows} financial rows · ${manifest.snapshotIds.length} snapshots`;
  return `${manifest.rowCounts.observations ?? 0} observations · ${manifest.snapshotIds.length} snapshots`;
}

// Exports created before this field existed (#182 D16) carry no per-snapshot
// review state; that's a fact about the export, not something to hide.
export function reviewStateLabel(manifest: ExportManifest): string {
  const state = manifest.snapshotState;
  if (!state || state.length === 0) return "Not recorded";
  const openExceptions = state.reduce((sum, entry) => sum + entry.openExceptionCount, 0);
  const versions = [...new Set(state.map((entry) => entry.version))].sort((a, b) => a - b);
  const versionLabel = versions.length === 1 ? `v${versions[0]}` : `v${versions[0]}–v${versions[versions.length - 1]}`;
  const exceptionLabel = openExceptions === 0 ? "no open exceptions" : `${openExceptions} open exception${openExceptions === 1 ? "" : "s"}`;
  return `${versionLabel} · ${exceptionLabel}`;
}
