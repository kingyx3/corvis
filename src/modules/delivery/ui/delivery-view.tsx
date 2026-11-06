"use client";
import { displayDate } from "@/shared/lib/display-format";
import { usePreferences } from "@/modules/workspace/ui/preferences/preference-provider";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExportDeliveryStatus, ExportFormat } from "@/modules/delivery/domain/delivery";
import type { ExportManifest } from "@/shared/domain/enterprise";
import { deliveryPort } from "@/composition/delivery-services";
import { Icon } from "@/shared/ui/icon";
import { ExportSchedulesPanel } from "@/modules/delivery/ui/export-schedules/export-schedules-panel";
import { DELIVERY_FORMATS as formats, reviewStateLabel, rowCoverage, scopeLabel, sourceLabel, stateLabel, type ListedExport } from "@/modules/delivery/domain/delivery-presentation";

export function DeliveryView({ publishedSnapshots, canViewAllSchedules = false }: { publishedSnapshots: number; canViewAllSchedules?: boolean }) {
  usePreferences();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [exports, setExports] = useState<ExportDeliveryStatus[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [scheduleRefresh, setScheduleRefresh] = useState(0);
  const latestHistoryRequest = useRef(0);

  const refreshHistory = useCallback(async () => {
    const requestId = ++latestHistoryRequest.current;
    try {
      const items = await deliveryPort.listExports();
      if (requestId !== latestHistoryRequest.current) return;
      setExports(items);
      setError(null);
    } catch (caught) {
      if (requestId !== latestHistoryRequest.current) return;
      setError(caught instanceof Error ? caught.message : "Export history could not be loaded");
    } finally {
      if (requestId === latestHistoryRequest.current) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestId = ++latestHistoryRequest.current;
    void deliveryPort.listExports()
      .then((items) => {
        if (requestId !== latestHistoryRequest.current) return;
        setExports(items);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (requestId !== latestHistoryRequest.current) return;
        setError(caught instanceof Error ? caught.message : "Export history could not be loaded");
      })
      .finally(() => { if (requestId === latestHistoryRequest.current) setHistoryLoading(false); });
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
    <section className="page-heading"><div><p className="eyebrow">Data delivery</p><h1>Deliver structured data</h1><p className="lede">Request, track and download governed tenant-safe outputs from published fund-period snapshots.</p></div><button className="secondary-button" disabled={historyLoading} onClick={() => { setScheduleRefresh((key) => key + 1); void refreshHistory(); }}><Icon name="clock" size={15}/>Refresh history</button></section>
    <div className="panel">
      <div className="panel-heading"><div><p className="eyebrow">Export contract</p><h2>{publishedSnapshots} published snapshot{publishedSnapshots === 1 ? "" : "s"} available</h2></div></div>
      <div className="format-grid">{formats.map((format) => <div className="format-card" key={format.value}><h3>{format.label}<span>.{format.value}</span></h3><p>{format.detail}</p><button className="secondary-button" disabled={busy !== null || publishedSnapshots === 0} onClick={() => void requestExport(format.value)}><Icon name="download" size={15}/>{busy === format.value ? "Requesting…" : `Request ${format.label}`}</button></div>)}</div>
    </div>
    {error && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Delivery module needs attention</strong><span>{error}. Existing workspace data remains available.</span></div></div>}
    {manifest && <div className="lineage-note tone-success" role="status" aria-label="Export requested"><Icon name="check"/><div><strong>Structured export requested</strong><span>{manifest.format.toUpperCase()} · {rowCoverage(manifest)}</span><span>Export ID {manifest.exportId} · checksum {manifest.checksumSha256.slice(0, 16)}…</span></div></div>}

    <ExportSchedulesPanel canViewAll={canViewAllSchedules} refreshKey={scheduleRefresh}/>

    <section className="panel" aria-labelledby="export-history-heading">
      <div className="panel-heading"><div><p className="eyebrow">Delivery history</p><h2 id="export-history-heading">Recent exports</h2></div></div>
      <div className="table-card" tabIndex={0} role="region" aria-label="Recent export history"><table className="data-table history-table"><thead><tr><th>Requested</th><th>Requested from</th><th>Scope</th><th>Format</th><th>Status</th><th>Coverage</th><th>Review state</th><th>Checksum</th><th>Expiry</th><th>Delivery</th></tr></thead><tbody>
        {historyLoading && <tr><td colSpan={10} className="empty-cell">Loading governed export history…</td></tr>}
        {!historyLoading && exports.length === 0 && <tr><td colSpan={10} className="empty-cell">No exports yet. Request a format above to create your first governed delivery.</td></tr>}
        {exports.map((item: ListedExport) => <tr key={item.exportId}><td><strong className="nowrap">{displayDate(item.createdAt, { timeStyle: "short" })}</strong><span className="table-secondary">{item.exportId}</span></td><td>{item.schedule ? <>Scheduled<span className="table-secondary">{item.schedule.label}</span></> : sourceLabel(item.manifest.source)}</td><td>{scopeLabel(item.manifest)}</td><td>{item.format.toUpperCase()}</td><td><span className={`quality quality-${item.state === "complete" ? "high" : item.state === "failed" ? "failed" : "pending"}`}>{stateLabel(item.state)}</span></td><td>{rowCoverage(item.manifest)}</td><td>{reviewStateLabel(item.manifest)}</td><td><code>{(item.checksumSha256 || item.manifest.checksumSha256).slice(0, 16)}…</code></td><td>{item.expiresAt ? displayDate(item.expiresAt, { timeStyle: "short" }) : "—"}</td><td>{item.downloadAvailable ? <button className="secondary-button button-small" disabled={downloading === item.exportId} onClick={() => void download(item)}>{downloading === item.exportId ? "Preparing…" : `Download ${item.format.toUpperCase()}`}</button> : <span className="table-muted">{item.state === "complete" ? "Unavailable or expired" : "Not ready"}</span>}</td></tr>)}
      </tbody></table></div>
    </section>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Only governed published data is delivered.</strong><span>Exports carry snapshot/schema/taxonomy metadata, immutable checksum lineage and time-bounded download grants. API, webhooks and optional warehouse sharing reuse the same serving contract.</span></div></div>
  </>;
}
