"use client";

import { useEffect, useMemo, useState } from "react";
import type { PositionFinancialStatementRow, StatementPeriodicity } from "@/core/contracts";
import styles from "./position-financials.module.css";

type ApiEnvelope = { data?: PositionFinancialStatementRow[]; error?: string };

type PeriodColumn = { key: string; label: string; end: string };
type LineGroup = { key: string; label: string; metricCode: string | null; role: string; depth: number; order: number; rows: PositionFinancialStatementRow[] };

function periodKey(row: PositionFinancialStatementRow): string {
  if (row.periodType === "quarter" && row.fiscalYear && row.fiscalQuarter) return `${row.fiscalYear}-Q${row.fiscalQuarter}`;
  if (row.periodType === "annual" && row.fiscalYear) return `${row.fiscalYear}-FY`;
  return [row.periodType ?? "reported",row.periodStart ?? "",row.periodEnd ?? row.asOfDate ?? "",row.reportPeriod].join(":");
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
  const formatted = new Intl.NumberFormat(undefined,{ maximumFractionDigits: 2 }).format(numeric);
  return row.currency ? `${row.currency} ${formatted}` : formatted;
}

function latest(a: PositionFinancialStatementRow, b: PositionFinancialStatementRow): PositionFinancialStatementRow {
  const left = a.sourceDocumentPeriodEnd ?? a.periodEnd ?? "";
  const right = b.sourceDocumentPeriodEnd ?? b.periodEnd ?? "";
  if (left !== right) return left > right ? a : b;
  if (a.preliminary !== b.preliminary) return a.preliminary ? b : a;
  return a.reportPeriod >= b.reportPeriod ? a : b;
}

export function PositionFinancialsView() {
  const [periodicity,setPeriodicity] = useState<StatementPeriodicity>("quarterly");
  const [rows,setRows] = useState<PositionFinancialStatementRow[]>([]);
  const [selectedPosition,setSelectedPosition] = useState("");
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void fetch(`/api/v1/position-financials?periodicity=${periodicity}&limit=5000`,{ signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json() as ApiEnvelope;
        if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
        return payload.data ?? [];
      })
      .then((data) => { if (active) { setRows(data); setLoading(false); } })
      .catch((reason: unknown) => { if (active && !controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Financial statements are temporarily unavailable"); setLoading(false); } });
    return () => { active = false; controller.abort(); };
  },[periodicity]);

  const positions = useMemo(() => {
    const map = new Map<string,{ key: string; fundId: string; holdingId: string; companyId: string }>();
    for (const row of rows) {
      const key = `${row.fundId}\u001f${row.holdingId}\u001f${row.companyId}`;
      if (!map.has(key)) map.set(key,{ key,fundId: row.fundId,holdingId: row.holdingId,companyId: row.companyId });
    }
    return [...map.values()].sort((a,b) => `${a.companyId}:${a.fundId}`.localeCompare(`${b.companyId}:${b.fundId}`));
  },[rows]);

  const effectiveSelectedPosition = selectedPosition && positions.some((position) => position.key === selectedPosition)
    ? selectedPosition
    : positions[0]?.key ?? "";
  const selectedRows = useMemo(() => rows.filter((row) => `${row.fundId}\u001f${row.holdingId}\u001f${row.companyId}` === effectiveSelectedPosition),[rows,effectiveSelectedPosition]);
  const periods = useMemo<PeriodColumn[]>(() => {
    const map = new Map<string,PeriodColumn>();
    for (const row of selectedRows) {
      if (row.valueId == null) continue;
      const key = periodKey(row);
      const end = row.periodEnd ?? row.asOfDate ?? row.sourceDocumentPeriodEnd ?? row.reportPeriod;
      const existing = map.get(key);
      if (!existing || end > existing.end) map.set(key,{ key,label: periodLabel(row),end });
    }
    return [...map.values()].sort((a,b) => a.end.localeCompare(b.end));
  },[selectedRows]);

  const lines = useMemo<LineGroup[]>(() => {
    const map = new Map<string,LineGroup>();
    for (const row of selectedRows) {
      const key = row.semanticLineKey || row.lineKey;
      const current = map.get(key);
      if (!current) map.set(key,{ key,label: row.sourceLabel,metricCode: row.metricCode,role: row.lineRole,depth: row.depth,order: row.displayOrder,rows: [row] });
      else {
        current.rows.push(row);
        if (row.displayOrder < current.order) current.order = row.displayOrder;
        if (!current.metricCode && row.metricCode) current.metricCode = row.metricCode;
      }
    }
    return [...map.values()].sort((a,b) => a.order - b.order || a.label.localeCompare(b.label));
  },[selectedRows]);

  const chosen = positions.find((position) => position.key === effectiveSelectedPosition);
  const valueFor = (line: LineGroup, period: PeriodColumn): PositionFinancialStatementRow | undefined => {
    const matching = line.rows.filter((row) => row.valueId != null && periodKey(row) === period.key);
    return matching.reduce<PositionFinancialStatementRow | undefined>((best,row) => best ? latest(best,row) : row,undefined);
  };
  const changePeriodicity = (value: StatementPeriodicity) => {
    if (value === periodicity) return;
    setLoading(true);
    setError(null);
    setPeriodicity(value);
  };

  return <section className={styles.page} aria-label="Position financial statements">
    <div className={styles.heading}>
      <div><p className="eyebrow">Portfolio analytics</p><h1>Position financials</h1><p className="lede">Compare every disclosed income-statement line across published reporting periods, with source presentation and governed metric mappings preserved side by side.</p></div>
      <div className={styles.controls}>
        <label><span>Position</span><select value={effectiveSelectedPosition} onChange={(event) => setSelectedPosition(event.target.value)} disabled={!positions.length}>{positions.length ? positions.map((position) => <option key={position.key} value={position.key}>{position.companyId} · {position.fundId}</option>) : <option>No published statements</option>}</select></label>
        <fieldset className={styles.segmented}><legend>Periodicity</legend>{(["quarterly","annual","reported"] as const).map((value) => <button type="button" key={value} aria-pressed={periodicity === value} className={periodicity === value ? styles.active : ""} onClick={() => changePeriodicity(value)}>{value === "reported" ? "As reported" : value[0].toUpperCase()+value.slice(1)}</button>)}</fieldset>
      </div>
    </div>

    <div className={styles.ruleNote}><strong>Aggregation guardrail.</strong> Annual mode prefers a reported annual disclosure. A derived annual value appears only when four explicit, compatible fiscal-quarter flow values exist; YTD, LTM, stock and cumulative values are never silently summed.</div>

    {loading && <div className={styles.state} aria-busy="true">Loading published financial statements…</div>}
    {!loading && error && <div className={styles.state} role="alert"><strong>Financial statements unavailable</strong><span>{error}</span></div>}
    {!loading && !error && !rows.length && <div className={styles.state}><strong>No published position income statements yet</strong><span>Once reviewed statement-line candidates are included in a published fund period, they will appear here without requiring a fixed chart of accounts.</span></div>}
    {!loading && !error && rows.length > 0 && chosen && <>
      <div className={styles.context}><span><strong>Company</strong>{chosen.companyId}</span><span><strong>Holding</strong>{chosen.holdingId}</span><span><strong>Fund</strong>{chosen.fundId}</span><span><strong>Periods</strong>{periods.length}</span></div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th className={styles.lineHeader}>Income statement</th>{periods.map((period) => <th key={period.key}>{period.label}</th>)}</tr></thead>
          <tbody>{lines.map((line) => <tr key={line.key} data-role={line.role}><th scope="row" style={{ paddingLeft: `${16 + line.depth * 16}px` }}><span>{line.label}</span>{line.metricCode && <small>{line.metricCode}</small>}</th>{periods.map((period) => { const row = valueFor(line,period); return <td key={period.key} title={row?.derivationFormula ?? row?.valueRaw ?? undefined}><span>{displayValue(row)}</span>{row?.isDerived && <small>derived</small>}{row?.isRestatement && <small>restated</small>}{row?.preliminary && <small>prelim</small>}</td>; })}</tr>)}</tbody>
        </table>
      </div>
      <p className={styles.footnote}>Source labels, row order, hierarchy and unmapped disclosures are intentionally retained. Canonical metric codes are supplemental semantic mappings, not a replacement for the source statement.</p>
    </>}
  </section>;
}
