"use client";

import { useCallback, useEffect, useState } from "react";
import type { ExportDeliveryStatus, ExportFormat } from "@/core/delivery";
import type { ExportManifest } from "@/core/enterprise";
import { deliveryPort } from "@/runtime/delivery-services";
import { Icon } from "@/components/ui/icon";

const formats: { value: ExportFormat; label: string; detail: string }[] = [
  { value: "csv", label: "CSV", detail: "Portable tabular delivery for downstream workflows." },
  { value: "xlsx", label: "Excel", detail: "Human-friendly workbook delivery for investment and operations teams." },
  { value: "parquet", label: "Parquet", detail: "Typed analytical delivery for data-platform ingestion." },
];

function stateLabel(state: string): string {
  return state.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

export function DeliveryView({ publishedSnapshots }: { publishedSnapshots: number }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [exports, setExports] = useState<ExportDeliveryStatus[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      setExports(await deliveryPort.listExports());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export history could not be loaded");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void deliveryPort.listExports()
      .then((items) => {
        if (!active) return;
        setExports(items);
        setError(null);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Export history could not be loaded");
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!exports.some((item) => ["queued", "delivering", "retryable"].includes(item.state))) return;
    const timer = window.setInterval(() => void refreshHistory(), 5000);
    return () => window.clearInterval(timer);
  }, [exports, refreshHistory]);

  const requestExport = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      setManifest(await deliveryPort.createExport(format));
      await refreshHistory();
    } catch (caught) {
      setManifest(null);
      setError(caught instanceof Error ? caught.message : "Export request failed");
    } finally {
      setBusy(null);
    }
  };

  return <>
    <section className="page-heading"><div><p className="eyebrow">DATA DELIVERY</p><h1>Deliver structured data</h1><p className="lede">Request, track and download governed tenant-safe outputs from published fund-period snapshots.</p></div><button className="secondary-button" disabled={historyLoading} onClick={() => void refreshHistory()}>Refresh history</button></section>
    <div className="panel">
      <div className="panel-heading"><div><p className="eyebrow">EXPORT CONTRACT</p><h2>{publishedSnapshots} published snapshot{publishedSnapshots === 1 ? "" : "s"} available</h2></div></div>
      <div className="review-summary">{formats.map((format) => <div key={format.value}><span>{format.label}</span><strong>{format.value.toUpperCase()}</strong><p>{format.detail}</p><button className="secondary-button" disabled={busy !== null || publishedSnapshots === 0} onClick={() => void requestExport(format.value)}><Icon name="download" size={15}/>{busy === format.value ? "Requesting…" : `Request ${format.label}`}</button></div>)}</div>
    </div>
    {error && <div className="lineage-note" role="alert"><Icon name="alert"/><div><strong>Delivery module needs attention</strong><span>{error}. Existing workspace data remains available.</span></div></div>}
    {manifest && <div className="lineage-note" role="status" aria-label="Export requested"><Icon name="check"/><div><strong>Structured export requested</strong><span>{manifest.format.toUpperCase()} · {manifest.rowCounts.observations ?? 0} observations · {manifest.snapshotIds.length} snapshots</span><span>Export ID {manifest.exportId} · checksum {manifest.checksumSha256.slice(0, 16)}…</span></div></div>}

    <section className="panel" aria-labelledby="export-history-heading">
      <div className="panel-heading"><div><p className="eyebrow">DELIVERY HISTORY</p><h2 id="export-history-heading">Recent exports</h2></div></div>
      <div className="table-card" tabIndex={0} role="region" aria-label="Recent export history"><table className="data-table"><thead><tr><th>Requested</th><th>Format</th><th>Status</th><th>Coverage</th><th>Checksum</th><th>Expiry</th><th>Delivery</th></tr></thead><tbody>
        {historyLoading && <tr><td colSpan={7}>Loading governed export history…</td></tr>}
        {!historyLoading && exports.length === 0 && <tr><td colSpan={7}>No export requests have been made for this signed-in user.</td></tr>}
        {exports.map((item) => <tr key={item.exportId}><td><strong>{new Date(item.createdAt).toLocaleString()}</strong><span className="table-secondary">{item.exportId}</span></td><td>{item.format.toUpperCase()}</td><td><span className={`quality quality-${item.state === "complete" ? "high" : item.state === "failed" ? "medium" : "pending"}`}>{stateLabel(item.state)}</span></td><td>{item.manifest.rowCounts.observations ?? 0} observations · {item.manifest.snapshotIds.length} snapshots</td><td><code>{(item.checksumSha256 || item.manifest.checksumSha256).slice(0, 16)}…</code></td><td>{item.expiresAt ? new Date(item.expiresAt).toLocaleString() : "—"}</td><td>{item.downloadUrl ? <a className="secondary-button" href={item.downloadUrl}>Download {item.format.toUpperCase()}</a> : <span>{item.state === "complete" ? "Unavailable or expired" : "Not ready"}</span>}</td></tr>)}
      </tbody></table></div>
    </section>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Only governed published data is delivered.</strong><span>Exports carry snapshot/schema/taxonomy metadata, immutable checksum lineage and time-bounded download grants. API, webhooks and optional warehouse sharing reuse the same serving contract.</span></div></div>
  </>;
}
