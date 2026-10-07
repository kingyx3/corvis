"use client";
import { useEffect, useRef, useState } from "react";
import { displayDate, displayNumberFormatter } from "@/shared/lib/display-format";
import { usePreferences } from "@/modules/workspace/ui/preferences/preference-provider";
import { workspaceContextHeaders } from "@/shared/lib/workspace-context";
import {
  FUND_SCORECARD_METRICS,
  INVESTMENT_SCORECARD_METRICS,
  NOT_REPORTED,
  cellSortValue,
  figureAsOf,
  formatFigure,
  scorecardScopeLabel,
  type FormatNumber,
  type FundRow,
  type InvestmentRow,
  type ScorecardCell,
  type ScorecardFigure,
  type ScorecardFilters,
  type ScorecardFund,
  type ScorecardMetric,
  type ScorecardPage,
} from "@/modules/analytics/domain/performance-scorecard";
import type { PerformanceScorecardExportScope } from "@/modules/delivery/domain/delivery";
import type { SourceEvidence } from "@/shared/domain/workspace";
import { PageHeading } from "@/shared/ui/page-heading";
import { SortableDataTable, type SortableColumn } from "@/shared/ui/sortable-data-table";
import { StatusPill } from "@/shared/ui/status-pill";
import { TableDensityToggle, type TableDensity } from "@/shared/ui/table-density-toggle";
import { deliveryPort } from "@/composition/delivery-services";
import { ScheduleExportButton } from "@/modules/delivery/ui/export-schedules/schedule-export-dialog";
import { apiUrl } from "@/shared/lib/api-url";
import { friendlyErrorMessage, throwIfUnauthenticated } from "@/shared/lib/api-errors";

type ApiEnvelope = { data?: ScorecardPage; nextCursor?: string | null; error?: string };
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

async function fetchScorecardPage(filters: ScorecardFilters, cursor: string | null, signal: AbortSignal): Promise<{ page: ScorecardPage; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (filters.fundId) params.set("fundId", filters.fundId);
  if (filters.period) params.set("period", filters.period);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  const response = await fetch(apiUrl(`/api/v1/performance-scorecard${query ? `?${query}` : ""}`), { signal, credentials: "include", headers: { ...workspaceContextHeaders(), accept: "application/json" } });
  await throwIfUnauthenticated(response);
  const payload = await response.json() as ApiEnvelope;
  if (!response.ok || !payload.data) throw new Error(payload.error || `Request failed (${response.status})`);
  return { page: payload.data, nextCursor: payload.nextCursor ?? null };
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
  const [filters, setFilters] = useState<ScorecardFilters>({});
  const [funds, setFunds] = useState<FundRow[]>([]);
  const [fundOptions, setFundOptions] = useState<ScorecardFund[]>([]);
  const [periodOptions, setPeriodOptions] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [density, setDensity] = useState<TableDensity>("compact");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ text: string; error?: boolean } | null>(null);
  // Bumped by every first-page load, so a "load more" that was in flight for an earlier filter never appends to the new one.
  const generation = useRef(0);
  const { fundId, period } = filters;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    generation.current += 1;
    // Loading/error are reset by retryLoad and changeFilters; a successful response clears any earlier failure, and `active` + abort drop stale responses.
    void fetchScorecardPage({ ...(fundId ? { fundId } : {}), ...(period ? { period } : {}) }, null, controller.signal)
      .then(({ page, nextCursor: cursor }) => {
        if (!active) return;
        setFunds(page.funds);
        setFundOptions(page.fundOptions);
        setPeriodOptions(page.periodOptions);
        setNextCursor(cursor);
        setMoreError(null);
        setError(null);
        setLoading(false);
      })
      .catch((reason: unknown) => { if (active && !controller.signal.aborted) { setError(friendlyErrorMessage(reason, "The performance scorecard is temporarily unavailable")); setLoading(false); } });
    return () => { active = false; controller.abort(); };
  }, [reloadKey, fundId, period]);

  const retryLoad = () => { setLoading(true); setError(null); setReloadKey((key) => key + 1); };
  const changeFilters = (next: ScorecardFilters) => {
    setFilters(next);
    setLoading(true);
    setError(null);
    setExpanded(new Set());
    setExportMessage(null);
  };
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const token = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const { page, nextCursor: cursor } = await fetchScorecardPage({ ...(fundId ? { fundId } : {}), ...(period ? { period } : {}) }, nextCursor, new AbortController().signal);
      if (token !== generation.current) return;
      setFunds((current) => [...current, ...page.funds.filter((fund) => !current.some((known) => known.fundId === fund.fundId))]);
      setNextCursor(cursor);
    } catch (reason) {
      if (token === generation.current) setMoreError(friendlyErrorMessage(reason, "More funds could not be loaded"));
    } finally {
      if (token === generation.current) setLoadingMore(false);
    }
  };
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const sourcesOpenable = canReadSources && onOpenDocument != null;
  const openSource: OpenSource | undefined = sourcesOpenable ? (figure) => onOpenDocument?.(figure.source.documentId, sourceEvidence(figure)) : undefined;

  // "Export this view" and "Schedule export" carry exactly the filters the tables are narrowed by.
  const exportScope: PerformanceScorecardExportScope = { performanceScorecard: true, ...(fundId ? { fundId } : {}), ...(period ? { period } : {}) };
  const fundLabel = fundId ? fundOptions.find((fund) => fund.fundId === fundId)?.fund ?? fundId : "every fund";
  const requestExport = async () => {
    setExportBusy(true); setExportMessage(null);
    try {
      await deliveryPort.createExport("csv", { source: "delivery", scope: exportScope });
      setExportMessage({ text: `Governed CSV requested for exactly this scorecard (${scorecardScopeLabel(exportScope).replace("Performance scorecard · ", "")}): ${fundLabel === "every fund" ? "every fund's" : `${fundLabel}'s`} latest reported figures${period ? ` for ${period}` : ""} with their as-of dates, flags and sources, including funds not yet shown on this page. It will appear in Data delivery history with these filters.` });
    } catch (reason) {
      setExportMessage({ text: reason instanceof Error ? reason.message : "Export request failed", error: true });
    } finally { setExportBusy(false); }
  };

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
    {canExport && <button type="button" className="secondary-button" disabled={exportBusy || loading || funds.length === 0} onClick={() => void requestExport()}>{exportBusy ? "Requesting export…" : "Export this view"}</button>}
    {canExport && <ScheduleExportButton scope={!loading && !error && funds.length > 0 ? exportScope : null}/>}
  </div>;

  const filtered = fundId !== undefined || period !== undefined;
  const totalFunds = fundId ? 1 : fundOptions.length;
  const showFilters = fundOptions.length > 0 || filtered;

  return <section className="scorecard-page" aria-label="Fund performance scorecard">
    <PageHeading className="scorecard-heading" eyebrow="Fund analytics" title="Performance scorecard" description="The performance each GP reported for every entitled fund and, by expanding a fund, for its underlying investments, from the latest published report. Nothing here is recomputed, summed across funds or currencies, or converted." actions={controls}/>
    {showFilters && <div className="position-financials-controls scorecard-filters" role="group" aria-label="Scorecard filters">
      <label><span>Fund</span><select value={fundId ?? ""} onChange={(event) => changeFilters({ ...(event.target.value ? { fundId: event.target.value } : {}), ...(period ? { period } : {}) })}>
        <option value="">All entitled funds</option>
        {fundOptions.map((fund) => <option key={fund.fundId} value={fund.fundId}>{fund.fund}</option>)}
      </select></label>
      <label><span>Reporting period</span><select value={period ?? ""} onChange={(event) => changeFilters({ ...(fundId ? { fundId } : {}), ...(event.target.value ? { period: event.target.value } : {}) })}>
        <option value="">Latest reported</option>
        {periodOptions.map((option) => <option key={option} value={option}>{option}</option>)}
      </select></label>
      {filtered && <button type="button" className="secondary-button" onClick={() => changeFilters({})}>Clear filters</button>}
    </div>}
    <div className="position-financials-rule-note"><strong>As reported.</strong> Every figure shows the date it is stated as of and whether it is Final, Preliminary or Restated. A figure Corvis derived rather than the GP printed is labelled Derived. <strong>{NOT_REPORTED}</strong> means the GP did not report that metric; it is never shown as zero.</div>
    {period && <div className="position-financials-rule-note" role="status"><strong>Reporting period {period}.</strong> Each metric shows the latest figure the GP stated for this period. A metric with no figure stated for it is {NOT_REPORTED}, even if a different period reported it.</div>}
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
      <div className="scorecard-paging">
        <span role="status">{nextCursor ? `Showing ${funds.length} of ${totalFunds} funds.` : `Showing all ${funds.length} fund${funds.length === 1 ? "" : "s"}.`}</span>
        {nextCursor && <button type="button" className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading funds…" : "Load more funds"}</button>}
        {moreError && <span className="position-financials-inline-error" role="alert">{moreError}</span>}
      </div>
      <details className="scorecard-definitions">
        <summary>Metric definitions and assumptions</summary>
        <dl>
          {[...FUND_SCORECARD_METRICS, ...INVESTMENT_SCORECARD_METRICS].map((metric) => <div key={metric.code}><dt>{metric.label}</dt><dd>{metric.definition}</dd></div>)}
        </dl>
        <p className="position-financials-footnote">The GP&apos;s own definition and calculation always govern. Corvis shows the latest published figure of each metric by its as-of date; a forecast, budget or target is never shown as a result. Preliminary means the GP marked the figure provisional; Restated means the GP flagged it as a restatement. Select a column header to sort the funds shown.</p>
      </details>
    </>}
  </section>;
}
