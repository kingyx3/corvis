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

type ScopedManifest = ExportManifest & { scopeLabel?: string };

function stateLabel(state: string): string {
  return state.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

// Exports created before this field existed have no manifest.source; they were
// all full-tenant requests from Data delivery itself, so that's the honest default.
function sourceLabel(source: ExportManifest["source"]): string {
  return source === "review" ? "Data review" : "Data delivery";
}
function scopeLabel(manifest: ExportManifest): string {
  return (manifest as ScopedManifest).scopeLabel || "All entitled published snapshots";
}
function rowCoverage(manifest: ExportManifest): string {
  const positionRows = manifest.rowCounts.positionFinancials;
  if (positionRows != null) return `${positionRows} financial rows · ${manifest.snapshotIds.length} snapshots`;
  return `${manifest.rowCounts.observations ?? 0} observations · ${manifest.snapshotIds.length} snapshots`;
}

export function DeliveryView({ publishedSnapshots }: { publishedSnapshots: number }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [exports, setExports] = useState<ExportDeliveryStatus[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

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
      setManifest(await deliveryPort.createExport(format, { source: "delivery" }));
      await refreshHistory();
    } catch (caught) {
      setManifest(null);
      setError(caught instanceof Error ? caught.message : "Export request failed");
    } finally {
      setBusy(null);
    }
  };

  // History never carries download links: a short-lived grant is issued only
  // when the user asks to download, so polling stays read-only and a link can
  // never be stale by the time it is clicked.
  const download = async (item: ExportDeliveryStatus) => {
    setDownloading(item.exportId);
    setError(null);
    try {
      const status = await deliveryPort.prepareDownload(item.exportId);
      setExports((current) => current.map((entry) => entry.exportId === status.exportId ? { ...status, downloadUrl: undefined, downloadExpiresAt: undefined } : entry));
      if (!status.downloadUrl) {
        setError("This export is no longer available for download");
        return;
      }
      window.location.assign(status.downloadUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Download could not be prepared");
    } finally {
      setDownloading(null);
    }
  };

  return <>
    <section className="page-heading"><div><p className="eyebrow">Data delivery</p><h1>Deliver structured data</h1><p className="lede">Request, track and download governed tenant-safe outputs from published fund-period snapshots.</p></div><button className="secondary-button" disabled={historyLoading} onClick={() => void refreshHistory()}><Icon name="clock" size={15}/>Refresh history</button></section>
    <div className="panel">
      <div className="panel-heading"><div><p className="eyebrow">Export contract</p><h2>{publishedSnapshots} published snapshot{publishedSnapshots === 1 ? "" : "s"} available</h2></div></div>
      <div className="format-grid">{formats.map((format) => <div className="format-card" key={format.value}><h3>{format.label}<span>.{format.value}</span></h3><p>{format.detail}</p><button className="secondary-button" disabled={busy !== null || publishedSnapshots === 0} onClick={() => void requestExport(format.value)}><Icon name="download" size={15}/>{busy === format.value ? "Requesting…" : `Request ${format.label}`}</button></div>)}</div>
    </div>
    {error && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Delivery module needs attention</strong><span>{error}. Existing workspace data remains available.</span></div></div>}
    {manifest && <div className="lineage-note tone-success" role="status" aria-label="Export requested"><Icon name="check"/><div><strong>Structured export requested</strong><span>{manifest.format.toUpperCase()} · {rowCoverage(manifest)}</span><span>Export ID {manifest.exportId} · checksum {manifest.checksumSha256.slice(0, 16)}…</span></div></div>}

    <section className="panel" aria-labelledby="export-history-heading">
      <div className="panel-heading"><div><p className="eyebrow">Delivery history</p><h2 id="export-history-heading">Recent exports</h2></div></div>
      <div className="table-card" tabIndex={0} role="region" aria-label="Recent export history"><table className="data-table history-table"><thead><tr><th>Requested</th><th>Requested from</th><th>Scope</th><th>Format</th><th>Status</th><th>Coverage</th><th>Checksum</th><th>Expiry</th><th>Delivery</th></tr></thead><tbody>
        {historyLoading && <tr><td colSpan={9} className="empty-cell">Loading governed export history…</td></tr>}
        {!historyLoading && exports.length === 0 && <tr><td colSpan={9} className="empty-cell">No exports yet. Request a format above to create your first governed delivery.</td></tr>}
        {exports.map((item) => <tr key={item.exportId}><td><strong className="nowrap">{new Date(item.createdAt).toLocaleString()}</strong><span className="table-secondary">{item.exportId}</span></td><td>{sourceLabel(item.manifest.source)}</td><td>{scopeLabel(item.manifest)}</td><td>{item.format.toUpperCase()}</td><td><span className={`quality quality-${item.state === "complete" ? "high" : item.state === "failed" ? "failed" : "pending"}`}>{stateLabel(item.state)}</span></td><td>{rowCoverage(item.manifest)}</td><td><code>{(item.checksumSha256 || item.manifest.checksumSha256).slice(0, 16)}…</code></td><td>{item.expiresAt ? new Date(item.expiresAt).toLocaleString() : "—"}</td><td>{item.downloadAvailable ? <button className="secondary-button button-small" disabled={downloading === item.exportId} onClick={() => void download(item)}>{downloading === item.exportId ? "Preparing…" : `Download ${item.format.toUpperCase()}`}</button> : <span className="table-muted">{item.state === "complete" ? "Unavailable or expired" : "Not ready"}</span>}</td></tr>)}
      </tbody></table></div>
    </section>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Only governed published data is delivered.</strong><span>Exports carry snapshot/schema/taxonomy metadata, immutable checksum lineage and time-bounded download grants. API, webhooks and optional warehouse sharing reuse the same serving contract.</span></div></div>
  </>;
}
