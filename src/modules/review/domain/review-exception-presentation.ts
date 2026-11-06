import { displayNumberFormatter } from "../../../shared/lib/display-format.ts";
import type { ObservationRecord } from "../../../shared/domain/contracts.ts";
import type { ReconciliationException, ReconciliationResolutionAction } from "../../../shared/domain/enterprise.ts";
import { awaitingSecondApproval } from "./review-decision.ts";
import { comparePeriods } from "../../workspace/domain/workspace-summary.ts";
import type { TimeSeriesPoint } from "../../../shared/ui/charts/time-series-chart.tsx";

export type ReviewPriority = { materiality: ReconciliationException["materiality"]; deadlineAt?: string; daysToDeadline?: number };

export type ReconciliationValue = { number?: unknown; string?: unknown; raw?: unknown; currency?: unknown; unit?: unknown };
export type PriorPublished = { snapshotId?: string; reportPeriod?: string; publishedAt?: string; value?: ReconciliationValue };
export type CompetingValue = { observationId?: string; sourceReferenceId?: string; value?: ReconciliationValue; riskTier?: string };

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function contextString(item: ReconciliationException, key: string): string | undefined {
  const value = item.context[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
export function priorPublished(item: ReconciliationException): PriorPublished | undefined {
  const value = record(item.context.priorPublished);
  return value as PriorPublished | undefined;
}
export function publishedHistory(item: ReconciliationException): TimeSeriesPoint[] {
  const history = Array.isArray(item.context.publishedHistory) ? item.context.publishedHistory : [];
  return history.flatMap((raw) => { const point = record(raw); const value = record(point?.value); const numeric = numericReconciliationValue(value); if (!point || typeof point.reportPeriod !== "string" || numeric == null) return [];
    return [{ period: point.reportPeriod, label: point.reportPeriod, value: numeric, status: (point.preliminary === true ? "preliminary" : point.restated === true ? "restated" : point.derived === true ? "derived" : "final") as TimeSeriesPoint["status"] }]; }).sort((a, b) => comparePeriods(a.period, b.period)).slice(-4);
}
export function competingValues(item: ReconciliationException): CompetingValue[] {
  return Array.isArray(item.context.competingValues) ? item.context.competingValues.filter((value) => record(value)).map((value) => value as CompetingValue) : [];
}
export function numericReconciliationValue(value: ReconciliationValue | undefined): number | undefined {
  if (!value || value.number == null) return undefined;
  const numeric = Number(value.number);
  return Number.isFinite(numeric) ? numeric : undefined;
}
export function displayReconciliationValue(value: ReconciliationValue | undefined): string {
  if (!value) return "—";
  if (value.string != null && String(value.string).trim()) return String(value.string);
  const numeric = numericReconciliationValue(value);
  if (numeric != null) {
    const formatted = displayNumberFormatter({ maximumFractionDigits: 2 }).format(numeric);
    return `${typeof value.currency === "string" && value.currency ? `${value.currency} ` : ""}${formatted}${typeof value.unit === "string" && value.unit ? ` ${value.unit}` : ""}`;
  }
  return value.raw == null ? "—" : String(value.raw);
}
export function reconciliationDelta(current: ReconciliationValue | undefined, prior: ReconciliationValue | undefined): string | undefined {
  const currentNumber = numericReconciliationValue(current);
  const priorNumber = numericReconciliationValue(prior);
  if (currentNumber == null || priorNumber == null) return undefined;
  const delta = currentNumber - priorNumber;
  const absolute = `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${displayNumberFormatter({ maximumFractionDigits: 2 }).format(Math.abs(delta))}`;
  if (priorNumber === 0) return absolute;
  const percent = delta / Math.abs(priorNumber) * 100;
  return `${absolute} · ${percent > 0 ? "+" : percent < 0 ? "−" : ""}${displayNumberFormatter({ maximumFractionDigits: 1 }).format(Math.abs(percent))}%`;
}
export function deadlinePriority(deadlineAt: string | undefined): Pick<ReviewPriority,"deadlineAt"|"daysToDeadline"> {
  if (!deadlineAt) return {};
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) return {};
  return { deadlineAt, daysToDeadline: Math.ceil((deadline - Date.now()) / 86_400_000) };
}
export function exceptionMatchesObservation(item: ReconciliationException, row: ObservationRecord): boolean {
  if (item.metricCode && item.metricCode !== row.metric) return false;
  if (!item.subjectId) return false;
  return [row.companyId,row.holdingId,row.fundId].filter(Boolean).includes(item.subjectId);
}
export function reviewPriority(row: ObservationRecord, exceptions: ReconciliationException[]): ReviewPriority {
  const open = exceptions.filter((item) => item.status === "open");
  const matches = open.filter((item) => exceptionMatchesObservation(item,row));
  const materiality = matches.some((item) => item.materiality === "material") ? "material"
    : matches.some((item) => item.materiality === "immaterial") ? "immaterial" : "unknown";
  const deadlineAt = matches.map((item) => contextString(item,"reviewDeadlineAt")).find(Boolean)
    ?? open.map((item) => contextString(item,"reviewDeadlineAt")).find(Boolean);
  return { materiality, ...deadlinePriority(deadlineAt) };
}
export function materialityWeight(value: ReviewPriority["materiality"]): number {
  return value === "material" ? 0 : value === "unknown" ? 1 : 2;
}
export function deadlineLabel(priority: ReviewPriority): string {
  if (priority.daysToDeadline == null) return "No deadline set";
  if (priority.daysToDeadline < 0) return `${Math.abs(priority.daysToDeadline)}d overdue`;
  if (priority.daysToDeadline === 0) return "Due today";
  return `${priority.daysToDeadline}d remaining`;
}
export function ruleLabel(item: ReconciliationException): string {
  return (contextString(item,"triggerRule") ?? item.type).replaceAll("_"," ");
}

export function actionLabel(action: ReconciliationResolutionAction): string {
  if (action === "select_source") return "Select authoritative source";
  if (action === "mark_immaterial") return "Mark immaterial";
  return "Accept reconciliation";
}

export function dualControlLabel(row: ObservationRecord): string | undefined {
  if (row.riskTier !== "critical") return undefined;
  if (awaitingSecondApproval(row)) return "1st approval recorded, 2nd required";
  if (row.state === "Needs review") return "Dual control required";
  return undefined;
}
