"use client";

import { useState } from "react";
import type { ExportFormat } from "@/core/delivery";
import type { ExportManifest } from "@/core/enterprise";
import { deliveryPort } from "@/runtime/delivery-services";
import { Icon } from "@/components/ui/icon";

const formats: { value: ExportFormat; label: string; detail: string }[] = [
  { value: "csv", label: "CSV", detail: "Portable tabular delivery for downstream workflows." },
  { value: "xlsx", label: "Excel", detail: "Human-friendly workbook delivery for investment and operations teams." },
  { value: "parquet", label: "Parquet", detail: "Typed analytical delivery for data-platform ingestion." },
];

export function DeliveryView({ publishedSnapshots }: { publishedSnapshots: number }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestExport = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      setManifest(await deliveryPort.createExport(format));
    } catch (caught) {
      setManifest(null);
      setError(caught instanceof Error ? caught.message : "Export request failed");
    } finally {
      setBusy(null);
    }
  };

  return <>
    <section className="page-heading"><div><p className="eyebrow">DATA DELIVERY</p><h1>Deliver structured data</h1><p className="lede">Request governed, tenant-safe structured outputs from published fund-period snapshots.</p></div></section>
    <div className="panel">
      <div className="panel-heading"><div><p className="eyebrow">EXPORT CONTRACT</p><h2>{publishedSnapshots} published snapshot{publishedSnapshots === 1 ? "" : "s"} available</h2></div></div>
      <div className="review-summary">{formats.map((format) => <div key={format.value}><span>{format.label}</span><strong>{format.value.toUpperCase()}</strong><p>{format.detail}</p><button className="secondary-button" disabled={busy !== null || publishedSnapshots === 0} onClick={() => void requestExport(format.value)}><Icon name="download" size={15}/>{busy === format.value ? "Requesting…" : `Request ${format.label}`}</button></div>)}</div>
    </div>
    {error && <div className="lineage-note" role="alert"><Icon name="alert"/><div><strong>Delivery module unavailable</strong><span>{error}. Other workspace modules remain available.</span></div></div>}
    {manifest && <div className="lineage-note" role="status" aria-label="Export requested"><Icon name="check"/><div><strong>Structured export requested</strong><span>{manifest.format.toUpperCase()} · {manifest.rowCounts.observations ?? 0} observations · {manifest.snapshotIds.length} snapshots</span><span>Export ID {manifest.exportId} · checksum {manifest.checksumSha256.slice(0, 16)}…</span></div></div>}
    <div className="lineage-note"><Icon name="shield"/><div><strong>Only governed published data is delivered.</strong><span>Exports carry snapshot/schema/taxonomy metadata and are separate from raw extraction output. API, webhooks and optional warehouse sharing reuse the same serving contract.</span></div></div>
  </>;
}
