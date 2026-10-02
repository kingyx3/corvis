import type { FundSnapshot, ObservationRecord, PositionFinancialStatementRow } from "@/core/contracts";
import type { ReportIssueContext } from "@/features/data-issues/report-issue-dialog";

/**
 * What "Report an issue" pins down on each surface that shows published figures. Only published data is reportable:
 * a draft being reviewed is the review workflow's business, not a published figure a customer could be relying on.
 */

/** Overview: any published fund period the person can see. */
export function overviewReportContext(snapshots: readonly FundSnapshot[]): ReportIssueContext | null {
  const published = snapshots.filter((snapshot) => snapshot.status === "Published" && snapshot.id && snapshot.fundId);
  if (published.length === 0) return null;
  return {
    figure: "overview",
    base: {},
    groups: [{
      id: "fundPeriod",
      label: "Fund period",
      options: published.map((snapshot) => ({
        value: `${snapshot.id}:${snapshot.version ?? ""}`,
        label: `${snapshot.fund} · ${snapshot.period}${snapshot.version ? ` · snapshot v${snapshot.version}` : ""}`,
        scope: {
          fundId: snapshot.fundId!, fundLabel: snapshot.fund, reportPeriod: snapshot.period, snapshotId: snapshot.id!,
          ...(snapshot.version ? { snapshotVersion: snapshot.version } : {}),
        },
      })),
    }],
  };
}

/** Position financials: the selected fund position, plus the line item and reporting period the person means. */
export function positionFinancialsReportContext(
  position: { fundId: string; companyId: string } | undefined,
  rows: readonly PositionFinancialStatementRow[],
): ReportIssueContext | null {
  if (!position || rows.length === 0) return null;
  const lines = new Map<string, { label: string; metricCode: string }>();
  for (const row of rows) {
    if (row.valueId == null) continue;
    const key = row.semanticLineKey || row.lineKey;
    if (!lines.has(key)) lines.set(key, { label: row.sourceLabel, metricCode: row.metricCode ?? key });
  }
  const periods = [...new Set(rows.map((row) => row.reportPeriod))].sort().reverse();
  if (periods.length === 0) return null;
  return {
    figure: "position_financials",
    base: { fundId: position.fundId, companyId: position.companyId },
    groups: [
      {
        id: "line",
        label: "Line item",
        optionalLabel: "Whole income statement",
        options: [...lines.entries()].map(([key, line]) => ({ value: key, label: line.label, scope: { metricCode: line.metricCode, metricLabel: line.label } })),
      },
      { id: "period", label: "Reporting period", options: periods.map((period) => ({ value: period, label: period, scope: { reportPeriod: period } })) },
    ],
  };
}

/** Data review: a published snapshot, optionally narrowed to one reviewed observation (the focused one when there is one). */
export function reviewReportContext(snapshot: FundSnapshot | undefined, observations: readonly ObservationRecord[], focusedObservationId?: string): ReportIssueContext | null {
  if (!snapshot || snapshot.status !== "Published" || !snapshot.id || !snapshot.fundId) return null;
  return {
    figure: "review",
    base: {
      fundId: snapshot.fundId, fundLabel: snapshot.fund, reportPeriod: snapshot.period, snapshotId: snapshot.id,
      ...(snapshot.version ? { snapshotVersion: snapshot.version } : {}),
    },
    groups: [{
      id: "observation",
      label: "Figure",
      optionalLabel: "The whole snapshot",
      defaultValue: observations.some((row) => row.id === focusedObservationId) ? focusedObservationId : undefined,
      options: observations.map((row) => ({
        value: row.id,
        label: `${row.company} · ${row.metric}`,
        scope: { companyId: row.companyId ?? row.company, companyLabel: row.company, metricCode: row.metric, metricLabel: row.metric },
      })),
    }],
  };
}
