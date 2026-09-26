"use client";
import { workspaceContextHeaders } from "../../lib/workspace-context.ts";

import { useEffect, useMemo, useState } from "react";
import type { PositionFinancialStatementRow, StatementPeriodicity } from "@/core/contracts";
import { financialAsOf, financialDelta, financialTrustLabel, numericFinancialValue } from "@/core/position-financial-trends";
import type { WorkspaceSummary } from "@/core/workspace-summary";
import type { SourceEvidence } from "@/core/workspace";
import { CompositionChart } from "@/components/ui/charts/composition-chart";
import { Sparkline } from "@/components/ui/charts/sparkline";
import { TimeSeriesChart, type TimeSeriesStatus } from "@/components/ui/charts/time-series-chart";
import { MetricCard } from "@/components/ui/metric-card";
import { Modal } from "@/components/ui/modal";
import { PageHeading } from "@/components/ui/page-heading";
import { SortableDataTable, type SortableColumn } from "@/components/ui/sortable-data-table";
import { TableDensityToggle, type TableDensity } from "@/components/ui/table-density-toggle";
import { deliveryPort } from "@/runtime/delivery-services";
import { workspacePort } from "@/runtime/workspace-services";

type ApiEnvelope = { data?: PositionFinancialStatementRow[]; error?: string };
type Portfolio = { id: string; displayName: string; fundPositionCount: number };
type PortfolioEnvelope = { data?: Portfolio[] };
type DeltaDisplay = "value" | "percent" | "both";
type EvidenceState = { sourceReferenceId: string; evidence: SourceEvidence };
type PeriodColumn = { key: string; label: string; end: string };
type LineGroup = { key: string; label: string; metricCode: string | null; role: string; depth: number; order: number; rows: PositionFinancialStatementRow[] };

/** A drill-through request (e.g. from Data review) to focus one position; a new key re-applies it. */
export type PositionFinancialsFocusRequest = { companyId: string; fundId?: string; holdingId?: string; key: number };

function periodKey(row: PositionFinancialStatementRow): string {
  if (row.periodType === "quarter" && row.fiscalYear && row.fiscalQuarter) return `${row.fiscalYear}-Q${row.fiscalQuarter}`;
  if (row.periodType === "annual" && row.fiscalYear) return `${row.fiscalYear}-FY`;
  return [row.periodType ?? "reported", row.periodStart ?? "", row.periodEnd ?? row.asOfDate ?? "", row.reportPeriod].join(":");
}

function periodLabel(row: PositionFinancialStatementRow): string {
  if (row.periodType === "quarter" && row.fiscalYear && row.fiscalQuarter) return `Q${row.fiscalQuarter} ${row.fiscalYear}`;
  if (row.periodType === "annual" && row.fiscalYear) return `FY ${row.fiscalYear}`;
  return row.sourceColumnLabel || row.periodEnd || row.asOfDate || row.reportPeriod;
}

function displayValue(row: PositionFinancialStatementRow | undefined): string {
  if (!row || row.valueId == null) return "—";
  if (row.valueString) return row.valueString;
  if (row.valueNumber == null) return row.valueRaw || "—";
  const numeric = Number(row.valueNumber);
  if (!Number.isFinite(numeric)) return row.valueNumber;
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(numeric);
  return row.currency ? `${row.currency} ${formatted}` : formatted;
}

function latest(a: PositionFinancialStatementRow, b: PositionFinancialStatementRow): PositionFinancialStatementRow {
  const left = a.sourceDocumentPeriodEnd ?? a.periodEnd ?? "";
  const right = b.sourceDocumentPeriodEnd ?? b.periodEnd ?? "";
  if (left !== right) return left > right ? a : b;
  if (a.preliminary !== b.preliminary) return a.preliminary ? b : a;
  return a.reportPeriod >= b.reportPeriod ? a : b;
}

function signedNumber(value: number, maximumFractionDigits = 2): string {
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted}`;
}

function displayDelta(current: PositionFinancialStatementRow | undefined, previous: PositionFinancialStatementRow | undefined, mode: DeltaDisplay): { text: string; direction: "up" | "down" | "flat" } | null {
  const delta = financialDelta(current, previous);
  if (!delta) return null;
  const absolute = `${current?.currency ? `${current.currency} ` : ""}${signedNumber(delta.absolute)}`;
  const percent = delta.percent == null ? "n/a %" : `${signedNumber(delta.percent, 1)}%`;
  return { text: mode === "value" ? absolute : mode === "percent" ? percent : `${absolute} · ${percent}`, direction: delta.direction };
}

function moneyFormatter(currency: string | null): (value: number) => string {
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(undefined, currency ? { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 } : { notation: "compact", maximumFractionDigits: 1 });
  } catch {
    formatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  }
  return (value) => formatter.format(value);
}

export function PositionFinancialsView({ canReadSources = false, onOpenDocument, focusRequest }: { canReadSources?: boolean; onOpenDocument?: (documentId: string) => void; focusRequest?: PositionFinancialsFocusRequest | null }) {
  const [periodicity, setPeriodicity] = useState<StatementPeriodicity>("quarterly");
  const [appliedFocusKey, setAppliedFocusKey] = useState(focusRequest?.key);
  const [portfolioAttributionEnabled, setPortfolioAttributionEnabled] = useState(false);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selectedPortfolio, setSelectedPortfolio] = useState("");
  const [rows, setRows] = useState<PositionFinancialStatementRow[]>([]);
  const [selectedPosition, setSelectedPosition] = useState("");
  const [deltaDisplay, setDeltaDisplay] = useState<DeltaDisplay>("both");
  const [density, setDensity] = useState<TableDensity>("compact");
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceState | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    void workspacePort.capabilities()
      .then((capabilities) => { if (active) setPortfolioAttributionEnabled(capabilities.features?.portfolioAttribution === true); })
      .catch(() => { if (active) setPortfolioAttributionEnabled(false); });
    void workspacePort.workspaceSummary().then((value) => { if (active) setSummary(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!portfolioAttributionEnabled) return;
    const controller = new AbortController();
    void fetch("/api/v1/portfolios?limit=100", { signal: controller.signal, headers: { ...workspaceContextHeaders(), accept: "application/json" } })
      .then(async (response) => response.ok ? await response.json() as PortfolioEnvelope : { data: [] })
      .then((payload) => setPortfolios(payload.data ?? []))
      .catch(() => { if (!controller.signal.aborted) setPortfolios([]); });
    return () => controller.abort();
  }, [portfolioAttributionEnabled]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const portfolio = portfolioAttributionEnabled && selectedPortfolio ? `&portfolioId=${encodeURIComponent(selectedPortfolio)}` : "";
    void fetch(`/api/v1/position-financials?periodicity=${periodicity}&limit=5000${portfolio}`, { signal: controller.signal, headers: { ...workspaceContextHeaders(), accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json() as ApiEnvelope;
        if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
        return payload.data ?? [];
      })
      .then((data) => { if (active) { setRows(data); setLoading(false); } })
      .catch((reason: unknown) => { if (active && !controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Financial statements are temporarily unavailable"); setLoading(false); } });
    return () => { active = false; controller.abort(); };
  }, [periodicity, portfolioAttributionEnabled, selectedPortfolio]);

  const positions = useMemo(() => {
    const map = new Map<string, { key: string; fundId: string; holdingId: string; companyId: string }>();
    for (const row of rows) {
      const key = `${row.fundId}\u001f${row.holdingId}\u001f${row.companyId}`;
      if (!map.has(key)) map.set(key, { key, fundId: row.fundId, holdingId: row.holdingId, companyId: row.companyId });
    }
    return [...map.values()].sort((a, b) => `${a.companyId}:${a.fundId}`.localeCompare(`${b.companyId}:${b.fundId}`));
  }, [rows]);

  if (focusRequest && focusRequest.key !== appliedFocusKey) {
    if (portfolioAttributionEnabled && selectedPortfolio) {
      setSelectedPortfolio("");
    } else {
      const match = positions.find((position) => position.companyId === focusRequest.companyId && (!focusRequest.fundId || position.fundId === focusRequest.fundId) && (!focusRequest.holdingId || position.holdingId === focusRequest.holdingId));
      if (match) { setSelectedPosition(match.key); setAppliedFocusKey(focusRequest.key); }
    }
  }

  const effectiveSelectedPosition = selectedPosition && positions.some((position) => position.key === selectedPosition) ? selectedPosition : positions[0]?.key ?? "";
  const selectedRows = useMemo(() => rows.filter((row) => `${row.fundId}\u001f${row.holdingId}\u001f${row.companyId}` === effectiveSelectedPosition), [rows, effectiveSelectedPosition]);
  const periods = useMemo<PeriodColumn[]>(() => {
    const map = new Map<string, PeriodColumn>();
    for (const row of selectedRows) {
      if (row.valueId == null) continue;
      const key = periodKey(row);
      const end = row.periodEnd ?? row.asOfDate ?? row.sourceDocumentPeriodEnd ?? row.reportPeriod;
      const existing = map.get(key);
      if (!existing || end > existing.end) map.set(key, { key, label: periodLabel(row), end });
    }
    return [...map.values()].sort((a, b) => a.end.localeCompare(b.end));
  }, [selectedRows]);

  const lines = useMemo<LineGroup[]>(() => {
    const map = new Map<string, LineGroup>();
    for (const row of selectedRows) {
      const key = row.semanticLineKey || row.lineKey;
      const current = map.get(key);
      if (!current) map.set(key, { key, label: row.sourceLabel, metricCode: row.metricCode, role: row.lineRole, depth: row.depth, order: row.displayOrder, rows: [row] });
      else {
        current.rows.push(row);
        if (row.displayOrder < current.order) current.order = row.displayOrder;
        if (!current.metricCode && row.metricCode) current.metricCode = row.metricCode;
      }
    }
    return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [selectedRows]);

  const featuredLine = useMemo(() => lines.find((line) => line.rows.some((row) => row.valueId != null)), [lines]);
  const valueFor = (line: LineGroup, period: PeriodColumn): PositionFinancialStatementRow | undefined => {
    const matching = line.rows.filter((row) => row.valueId != null && periodKey(row) === period.key);
    return matching.reduce<PositionFinancialStatementRow | undefined>((best, row) => best ? latest(best, row) : row, undefined);
  };
  const trendPoints = useMemo(() => {
    if (!featuredLine) return [];
    return periods.map((period) => {
      const row = featuredLine.rows.filter((candidate) => candidate.valueId != null && periodKey(candidate) === period.key).reduce<PositionFinancialStatementRow | undefined>((best, candidate) => best ? latest(best, candidate) : candidate, undefined);
      return { period: period.key, label: period.label, value: numericFinancialValue(row), status: (row?.preliminary ? "preliminary" : row?.isRestatement ? "restated" : row?.isDerived ? "derived" : "final") as TimeSeriesStatus };
    });
  }, [featuredLine, periods]);

  const chosen = positions.find((position) => position.key === effectiveSelectedPosition);
  const chosenPortfolio = portfolioAttributionEnabled ? portfolios.find((portfolio) => portfolio.id === selectedPortfolio) : undefined;
  const formatExposure = moneyFormatter(summary?.currency ?? null);
  const latestFeatured = [...trendPoints].reverse().find((point) => point.value != null)?.value ?? null;

  const changePeriodicity = (value: StatementPeriodicity) => {
    if (value === periodicity) return;
    setLoading(true); setError(null); setExportMessage(null); setPeriodicity(value);
  };
  const changePortfolio = (portfolioId: string) => {
    if (!portfolioAttributionEnabled || portfolioId === selectedPortfolio) return;
    setLoading(true); setError(null); setExportMessage(null); setSelectedPosition(""); setSelectedPortfolio(portfolioId);
  };
  const requestExport = async () => {
    if (!chosen || !selectedRows.length) return;
    setExportBusy(true); setExportMessage(null);
    try {
      await deliveryPort.createExport("csv", { source: "delivery", scope: { positionFinancials: { fundId: chosen.fundId, holdingId: chosen.holdingId, companyId: chosen.companyId, periodicity, ...(selectedPortfolio ? { portfolioId: selectedPortfolio } : {}) } } });
      setExportMessage({ text: "Governed CSV requested for exactly this position, portfolio scope and periodicity. It will appear in Data delivery history." });
    } catch (reason) {
      setExportMessage({ text: reason instanceof Error ? reason.message : "Export request failed", error: true });
    } finally { setExportBusy(false); }
  };
  const openEvidence = async (row: PositionFinancialStatementRow) => {
    const sourceReferenceId = row.sourceReferenceIds[0];
    if (!canReadSources || !sourceReferenceId) return;
    setEvidenceBusy(sourceReferenceId); setEvidenceError(null);
    try { setEvidence({ sourceReferenceId, evidence: await workspacePort.sourceEvidence(sourceReferenceId) }); }
    catch (reason) { setEvidenceError(reason instanceof Error ? reason.message : "Source evidence could not be opened"); }
    finally { setEvidenceBusy(null); }
  };

  const tableColumns: SortableColumn<LineGroup>[] = [
    {
      id: "line",
      header: "Income statement",
      headerClassName: "position-financials-line-header",
      rowHeader: true,
      sortValue: (line) => line.label,
      render: (line) => <><span style={{ paddingLeft: `${line.depth * 16}px` }}>{line.label}</span>{line.metricCode && <small>{line.metricCode}</small>}</>,
    },
    ...periods.map((period, index): SortableColumn<LineGroup> => ({
      id: period.key,
      header: <>{period.label}<small>As of {period.end}</small></>,
      align: "end",
      sortValue: (line) => numericFinancialValue(valueFor(line, period)),
      cellTitle: (line) => { const row = valueFor(line, period); return row?.derivationFormula ?? row?.valueRaw ?? undefined; },
      render: (line) => {
        const row = valueFor(line, period);
        const previous = index > 0 ? valueFor(line, periods[index - 1]!) : undefined;
        const delta = displayDelta(row, previous, deltaDisplay);
        const trust = financialTrustLabel(row);
        const asOf = financialAsOf(row);
        const sourceReferenceId = row?.sourceReferenceIds[0];
        return <>
          {row && sourceReferenceId && canReadSources ? <button type="button" className="position-financials-value-button" aria-label={`Open source evidence for ${line.label}, ${period.label}`} disabled={evidenceBusy === sourceReferenceId} onClick={() => void openEvidence(row)}><span>{displayValue(row)}</span></button> : <span>{displayValue(row)}</span>}
          {delta && <small className={`position-financials-delta position-financials-delta-${delta.direction}`} aria-label={`Change from prior period: ${delta.text}`}>{delta.text}</small>}
          {row?.valueId != null && <small className="position-financials-trust">{trust}{asOf ? ` · as of ${asOf}` : ""}</small>}
          {row?.isDerived && <small>derived</small>}{row?.isRestatement && <small>restated</small>}{row?.preliminary && <small>preliminary</small>}
          {row?.valueId != null && !canReadSources && row.sourceReferenceIds.length > 0 && <small>Source evidence restricted by access</small>}
        </>;
      },
    })),
  ];

  const controls = <div className="position-financials-controls">
    {portfolioAttributionEnabled && <label><span>Portfolio</span><select value={selectedPortfolio} onChange={(event) => changePortfolio(event.target.value)}><option value="">All entitled funds</option>{portfolios.map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.displayName} · {portfolio.fundPositionCount} fund position{portfolio.fundPositionCount === 1 ? "" : "s"}</option>)}</select></label>}
    <label><span>Position</span><select value={effectiveSelectedPosition} onChange={(event) => { setSelectedPosition(event.target.value); setExportMessage(null); }} disabled={!positions.length}>{positions.length ? positions.map((position) => <option key={position.key} value={position.key}>{position.companyId} · {position.fundId}</option>) : <option>No published statements</option>}</select></label>
    <fieldset className="position-financials-segmented"><legend>Periodicity</legend>{(["quarterly", "annual", "reported"] as const).map((value) => <button type="button" key={value} aria-pressed={periodicity === value} className={periodicity === value ? "active" : ""} onClick={() => changePeriodicity(value)}>{value === "reported" ? "As reported" : value[0].toUpperCase() + value.slice(1)}</button>)}</fieldset>
    <fieldset className="position-financials-segmented"><legend>Period-over-period change display</legend>{(["value", "percent", "both"] as const).map((value) => <button type="button" key={value} aria-pressed={deltaDisplay === value} className={deltaDisplay === value ? "active" : ""} onClick={() => setDeltaDisplay(value)}>{value === "value" ? "Δ value" : value === "percent" ? "Δ %" : "Δ both"}</button>)}</fieldset>
    <TableDensityToggle value={density} onChange={setDensity} label="Financial table density"/>
    <button type="button" className="secondary-button" disabled={!chosen || !selectedRows.length || exportBusy} onClick={() => void requestExport()}>{exportBusy ? "Requesting export…" : "Export this view"}</button>
  </div>;

  return <section className="position-financials-page" aria-label="Position financial statements">
    <PageHeading className="position-financials-heading" eyebrow={portfolioAttributionEnabled ? "Portfolio analytics" : "Fund analytics"} title="Position financials" description={portfolioAttributionEnabled ? "Optionally scope by a client portfolio, then compare the complete source-reported income statement for each attributed fund position across published reporting periods." : "Compare the complete source-reported income statement for each entitled fund holding across published reporting periods. Portfolio attribution is not required."} actions={controls}/>

    {portfolioAttributionEnabled && <div className="position-financials-rule-note"><strong>Attribution guardrail.</strong> {chosenPortfolio ? `${chosenPortfolio.displayName} scopes which fund holdings appear; ` : "Portfolio filters scope which fund holdings appear; "}company revenue, EBITDA and other operating statement values remain the full source-reported amounts and are never multiplied by ownership stake or position size.</div>}
    <div className="position-financials-rule-note"><strong>Aggregation guardrail.</strong> Annual mode prefers a reported annual disclosure. A derived annual value appears only when four explicit, compatible fiscal-quarter flow values exist; YTD, LTM, stock and cumulative values are never silently summed.</div>
    <div className="position-financials-rule-note"><strong>Trust and change.</strong> Each reported value shows its governed as-of/trust state. Period-over-period movement is computed only from adjacent numeric values in this same disclosed line; no missing period is silently imputed.</div>
    {exportMessage && <div className={exportMessage.error ? "position-financials-inline-error" : "position-financials-rule-note"} role={exportMessage.error ? "alert" : "status"}><strong>{exportMessage.error ? "Export failed. " : "Export requested. "}</strong>{exportMessage.text}</div>}
    {evidenceError && <div className="position-financials-inline-error" role="alert">{evidenceError}</div>}
    {loading && <div className="position-financials-state" aria-busy="true">Loading published financial statements…</div>}
    {!loading && error && <div className="position-financials-state" role="alert"><strong>Financial statements unavailable</strong><span>{error}</span></div>}
    {!loading && !error && !rows.length && <div className="position-financials-state"><strong>No published position income statements yet</strong><span>Once reviewed statement-line candidates are included in a published fund period, they will appear here without requiring a fixed chart of accounts.</span></div>}

    {!loading && !error && rows.length > 0 && chosen && <>
      <section className="position-financials-analytics-grid" aria-label="Position financial metrics">
        <MetricCard label="Statement lines" value={lines.length.toLocaleString()} detail="Source-reported hierarchy retained"/>
        <MetricCard label="Published periods" value={periods.length.toLocaleString()} detail={periodicity === "reported" ? "As reported by the GP" : periodicity}/>
        <MetricCard label={featuredLine ? `Latest ${featuredLine.label}` : "Trend"} value={latestFeatured == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(latestFeatured)} detail={featuredLine ? "Compared across published periods" : "No numeric line available"} trend={featuredLine ? <Sparkline label={`${featuredLine.label} for ${chosen.companyId}`} points={trendPoints}/> : undefined}/>
      </section>

      <div className="position-financials-context">{chosenPortfolio && <span><strong>Portfolio</strong>{chosenPortfolio.displayName}</span>}<span><strong>Company</strong>{chosen.companyId}</span><span><strong>Holding</strong>{chosen.holdingId}</span><span><strong>Fund</strong>{chosen.fundId}</span><span><strong>Periods</strong>{periods.length}</span></div>

      {!selectedPortfolio && summary?.exposure.items.length ? <section className="panel position-financials-chart-panel"><CompositionChart eyebrow="Allocation" title="Workspace exposure by fund" description={`Latest published fund values in the workspace${summary.currency ? ` (${summary.currency})` : ""}. This allocation is governed from published NAV/fair-value facts and is not ownership-weighted.`} items={summary.exposure.items.map((item) => ({ key: item.fundId, label: item.fund, value: item.value }))} valueFormatter={formatExposure} unitLabel={summary.currency ? `Value (${summary.currency})` : "Value"}/></section> : null}
      {featuredLine && <section className="panel position-financials-chart-panel"><TimeSeriesChart eyebrow="Trend" title={`${featuredLine.label} across periods`} description={`${chosen.companyId}'s reported ${featuredLine.label.toLowerCase()} for each published period, most recent last.`} name={featuredLine.label} data={trendPoints}/></section>}

      <div className="data-table-wrap" role="region" aria-label="Position financials table">
        <SortableDataTable caption={`Position financials for ${chosen.companyId}`} rows={lines} columns={tableColumns} rowKey={(line) => line.key} density={density} className="position-financials-table" getRowAttributes={(line) => ({ "data-role": line.role })}/>
      </div>
      <p className="position-financials-footnote">Source labels, row order, hierarchy and unmapped disclosures are intentionally retained. Canonical metric codes are supplemental semantic mappings, not a replacement for the source statement. Select a column header to sort; compact/comfortable density changes presentation only.</p>
    </>}

    {evidence && <Modal label="Source evidence" onClose={() => setEvidence(null)} width="min(720px, 100%)"><div className="position-financials-evidence-panel"><div><p className="eyebrow">Governed source evidence</p><h2>Evidence for reported value</h2></div><dl><div><dt>Document</dt><dd>{evidence.evidence.documentId}</dd></div>{evidence.evidence.page != null && <div><dt>Page</dt><dd>{evidence.evidence.page}</dd></div>}{evidence.evidence.sheetName && <div><dt>Sheet</dt><dd>{evidence.evidence.sheetName}</dd></div>}{evidence.evidence.cellRange && <div><dt>Cells</dt><dd>{evidence.evidence.cellRange}</dd></div>}<div><dt>Source reference</dt><dd>{evidence.sourceReferenceId}</dd></div></dl>{evidence.evidence.excerpt && <blockquote>{evidence.evidence.excerpt}</blockquote>}{onOpenDocument && <button type="button" className="primary-button" onClick={() => { const documentId = evidence.evidence.documentId; setEvidence(null); onOpenDocument(documentId); }}>Open source document</button>}</div></Modal>}
  </section>;
}
