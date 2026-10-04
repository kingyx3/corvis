"use client";
import { useEffect, useState } from "react";
import { displayDate, displayNumberFormatter } from "@/lib/display-format";
import { usePreferences } from "@/features/preferences/preference-provider";
import { workspaceContextHeaders } from "@/lib/workspace-context";
import {
  FUND_SCORECARD_METRICS,
  INVESTMENT_SCORECARD_METRICS,
  NOT_REPORTED,
  cellSortValue,
  figureAsOf,
  formatFigure,
  type FormatNumber,
  type FundRow,
  type InvestmentRow,
  type Scorecard,
  type ScorecardCell,
  type ScorecardFigure,
  type ScorecardMetric,
} from "@/core/performance-scorecard";
import type { SourceEvidence } from "@/core/workspace";
import { PageHeading } from "@/components/ui/page-heading";
import { SortableDataTable, type SortableColumn } from "@/components/ui/sortable-data-table";
import { StatusPill } from "@/components/ui/status-pill";
import { TableDensityToggle, type TableDensity } from "@/components/ui/table-density-toggle";
import { deliveryPort } from "@/runtime/delivery-services";
import { apiUrl } from "@/lib/api-url";
import { friendlyErrorMessage, throwIfUnauthenticated } from "@/lib/api-errors";

type ApiEnvelope = { data?: Scorecard; error?: string };
type OpenSource = (figure: ScorecardFigure, subject: string, metric: ScorecardMetric) => void;

const formatNumber: FormatNumber = (value, options) => displayNumberFormatter(options).format(value);

function sourceEvidence(figure: ScorecardFigure): SourceEvidence {
  const { source } = figure;
  return {
    sourceReferenceId: source.sourceReferenceId,
    documentId: source.documentId,
    ...(source.page != null ? { page: source.page } : {}),
    ...(source.sheetName ? { sheetName: source.sheetName } : {}),
    ...(source.cellRange ? { cellRange: source.cellRange } : {}),
  };
}

function asOfText(figure: ScorecardFigure): string | null {
  const asOf = figureAsOf(figure);
  if (!asOf) return null;
  return asOf.kind === "date" ? `As of ${displayDate(asOf.value)}` : `Period ${asOf.value}`;
}

/**
 * One scorecard cell. Every figure carries its as-of date and Final/Preliminary/Restated flag (plus Derived when
 * Corvis, not the GP, produced it) and, when the caller may open sources, is a single button that opens its source
 * document. A metric the GP did not report is the words "Not reported", never 0 or a blank.
 */
function ScorecardCellView({ cell, subject, openSource }: { cell: ScorecardCell; subject: string; openSource?: OpenSource }) {
  if (cell.figures.length === 0) return <span className="scorecard-not-reported">{NOT_REPORTED}</span>;
  return <div className="scorecard-figures">{cell.figures.map((figure) => {
    const value = formatFigure(figure, cell.metric.kind, formatNumber);
    const asOf = asOfText(figure);
    const asPrinted = figure.valueRaw ? `As printed in the source: ${figure.valueRaw}` : undefined;
    return <div className="scorecard-figure" key={figure.factId}>
      {openSource
        ? <button type="button" className="scorecard-value-button" title={asPrinted} aria-label={`Open source document for ${subject}, ${cell.metric.label}: ${value}`} onClick={() => openSource(figure, subject, cell.metric)}>{value}</button>
        : <span className="scorecard-value" title={asPrinted}>{value}</span>}
      <span className="scorecard-flags">
        <StatusPill status={figure.status}/>
        {figure.derived && <span title={figure.derivationFormula ?? undefined}><StatusPill status="Derived"/></span>}
      </span>
      {asOf && <small className="scorecard-asof">{asOf}</small>}
    </div>;
  })}</div>;
}

function metricColumns<Row extends { cells: ScorecardCell[] }>(metrics: readonly ScorecardMetric[], subject: (row: Row) => string, openSource?: OpenSource): SortableColumn<Row>[] {
  return metrics.map((metric): SortableColumn<Row> => ({
    id: metric.code,
    header: metric.label,
    align: "end",
    sortValue: (row) => cellSortValue(row.cells.find((cell) => cell.metric.code === metric.code)!),
    render: (row) => <ScorecardCellView cell={row.cells.find((cell) => cell.metric.code === metric.code)!} subject={subject(row)} openSource={openSource}/>,
  }));
}

function InvestmentsTable({ fund, density, openSource }: { fund: FundRow; density: TableDensity; openSource?: OpenSource }) {
  if (fund.investments.length === 0) return <p className="scorecard-empty-investments">No underlying investments have a published figure for {fund.fund} yet.</p>;
  const columns: SortableColumn<InvestmentRow>[] = [
    { id: "investment", header: "Investment", rowHeader: true, sortValue: (row) => row.investment, render: (row) => <span>{row.investment}</span> },
    ...metricColumns<InvestmentRow>(INVESTMENT_SCORECARD_METRICS, (row) => `${row.investment} in ${fund.fund}`, openSource),
  ];
  return <div className="data-table-wrap" role="region" aria-label={`Underlying investments of ${fund.fund}`}>
    <SortableDataTable caption={`Underlying investments of ${fund.fund}`} rows={fund.investments} columns={columns} rowKey={(row) => row.key} density={density} className="scorecard-table scorecard-investments-table"/>
  </div>;
}

export function PerformanceScorecardView({ canReadSources = false, onOpenDocument, canExport = false }: {
  canReadSources?: boolean;
  onOpenDocument?: (documentId: string, location?: SourceEvidence) => void;
  canExport?: boolean;
}) {
  usePreferences();
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [density, setDensity] = useState<TableDensity>("compact");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    // Loading/error are reset by retryLoad; a successful response clears any earlier failure, and `active` + abort drop stale responses.
    void fetch(apiUrl("/api/v1/performance-scorecard"), { signal: controller.signal, credentials: "include", headers: { ...workspaceContextHeaders(), accept: "application/json" } })
      .then(async (response) => {
        throwIfUnauthenticated(response);
        const payload = await response.json() as ApiEnvelope;
        if (!response.ok || !payload.data) throw new Error(payload.error || `Request failed (${response.status})`);
        return payload.data;
      })
      .then((data) => { if (active) { setScorecard(data); setError(null); setLoading(false); } })
      .catch((reason: unknown) => { if (active && !controller.signal.aborted) { setError(friendlyErrorMessage(reason, "The performance scorecard is temporarily unavailable")); setLoading(false); } });
    return () => { active = false; controller.abort(); };
  }, [reloadKey]);

  const retryLoad = () => { setLoading(true); setError(null); setReloadKey((key) => key + 1); };
  const toggle = (fundId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(fundId)) next.add(fundId);
    return next;
  });
  const sourcesOpenable = canReadSources && onOpenDocument != null;
  const openSource: OpenSource | undefined = sourcesOpenable ? (figure) => onOpenDocument?.(figure.source.documentId, sourceEvidence(figure)) : undefined;
  const requestExport = async () => {
    setExportBusy(true); setExportMessage(null);
    try {
      await deliveryPort.createExport("csv", { source: "delivery", scope: { performanceScorecard: true } });
      setExportMessage({ text: "Governed CSV requested for exactly this scorecard: every fund's latest reported figures with their as-of dates, flags and sources. It will appear in Data delivery history." });
    } catch (reason) {
      setExportMessage({ text: reason instanceof Error ? reason.message : "Export request failed", error: true });
    } finally { setExportBusy(false); }
  };

  const funds = scorecard?.funds ?? [];
  const fundColumns: SortableColumn<FundRow>[] = [
    {
      id: "fund",
      header: "Fund",
      rowHeader: true,
      headerClassName: "scorecard-fund-header",
      sortValue: (row) => row.fund,
      render: (row) => {
        const open = expanded.has(row.fundId);
        return <button type="button" className="scorecard-expand-button" aria-expanded={open} aria-controls={`scorecard-investments-${row.fundId}`} onClick={() => toggle(row.fundId)}>
          <span className="scorecard-expand-icon" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span><span className="scorecard-fund-name">{row.fund}</span><small>{row.investments.length === 0 ? "No underlying investments published" : `${row.investments.length} underlying investment${row.investments.length === 1 ? "" : "s"}`}</small></span>
        </button>;
      },
    },
    ...metricColumns<FundRow>(FUND_SCORECARD_METRICS, (row) => row.fund, openSource),
  ];

  const controls = <div className="scorecard-controls">
    <TableDensityToggle value={density} onChange={setDensity} label="Scorecard table density"/>
    {canExport && <button type="button" className="secondary-button" disabled={exportBusy || funds.length === 0} onClick={() => void requestExport()}>{exportBusy ? "Requesting export…" : "Export this view"}</button>}
  </div>;

  return <section className="scorecard-page" aria-label="Fund performance scorecard">
    <PageHeading className="scorecard-heading" eyebrow="Fund analytics" title="Performance scorecard" description="The performance each GP reported for every entitled fund and, by expanding a fund, for its underlying investments, from the latest published report. Nothing here is recomputed, summed across funds or currencies, or converted." actions={controls}/>
    <div className="position-financials-rule-note"><strong>As reported.</strong> Every figure shows the date it is stated as of and whether it is Final, Preliminary or Restated. A figure Corvis derived rather than the GP printed is labelled Derived. <strong>{NOT_REPORTED}</strong> means the GP did not report that metric; it is never shown as zero.</div>
    {!sourcesOpenable && !loading && !error && funds.length > 0 && <div className="position-financials-rule-note" role="status"><strong>Source documents restricted.</strong> Your role cannot open source documents, so figures are shown without a drill-through.</div>}
    {exportMessage && <div className={exportMessage.error ? "position-financials-inline-error" : "position-financials-rule-note"} role={exportMessage.error ? "alert" : "status"}><strong>{exportMessage.error ? "Export failed. " : "Export requested. "}</strong>{exportMessage.text}</div>}
    {loading && <div className="position-financials-state" aria-busy="true">Loading the performance scorecard…</div>}
    {!loading && error && <div className="position-financials-state" role="alert"><strong>Performance scorecard unavailable</strong><span>{error}</span><button type="button" className="secondary-button" onClick={retryLoad}>Retry</button></div>}
    {!loading && !error && funds.length === 0 && <div className="position-financials-state"><strong>No entitled funds yet</strong><span>Once a fund you are entitled to has a published report, its GP-reported performance appears here.</span></div>}

    {!loading && !error && funds.length > 0 && <>
      <div className="data-table-wrap" role="region" aria-label="Fund performance table">
        <SortableDataTable
          caption="Latest GP-reported performance of each entitled fund. Expand a fund to see its underlying investments."
          rows={funds}
          columns={fundColumns}
          rowKey={(row) => row.fundId}
          density={density}
          className="scorecard-table"
          renderRowDetail={(row) => expanded.has(row.fundId)
            ? <div className="scorecard-investments" id={`scorecard-investments-${row.fundId}`}><InvestmentsTable fund={row} density={density} openSource={openSource}/></div>
            : null}
        />
      </div>
      <details className="scorecard-definitions">
        <summary>Metric definitions and assumptions</summary>
        <dl>
          {[...FUND_SCORECARD_METRICS, ...INVESTMENT_SCORECARD_METRICS].map((metric) => <div key={metric.code}><dt>{metric.label}</dt><dd>{metric.definition}</dd></div>)}
        </dl>
        <p className="position-financials-footnote">The GP&apos;s own definition and calculation always govern. Corvis shows the latest published figure of each metric by its as-of date; a forecast, budget or target is never shown as a result. Preliminary means the GP marked the figure provisional; Restated means the GP flagged it as a restatement. Select a column header to sort.</p>
      </details>
    </>}
  </section>;
}
