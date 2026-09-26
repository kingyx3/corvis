"use client";

import { useEffect, useMemo, useState } from "react";
import type { DocumentLifecycle, DocumentRecord } from "@/core/contracts";
import { documentSecurityNotice } from "@/core/document-processing";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

type SourceActivityAcquisition = { acquisitionId: string; disposition: string; remotePath: string; remoteVersion: string; acquiredAt: string; documentId?: string; reason: string };
type SourceActivityRun = { runId: string; trigger: string; state: string; discoveredCount: number; acceptedCount: number; duplicateCount: number; rejectedCount: number; startedAt: string; finishedAt?: string; zeroDiscoveryLongRunning: boolean; errorClass?: string; acquisitions: SourceActivityAcquisition[] };
type SourceActivityConnection = { sourceConnectionId: string; providerKey: string; connectionLabel: string; status: string; consecutiveFailures: number; needsAttention: boolean; attentionReason?: string; runs: SourceActivityRun[] };

function displayTime(value: string | undefined): string { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function originLabel(doc: DocumentRecord): string {
  const origin = doc.lifecycle?.origin;
  if (!origin) return "Loading provenance…";
  return origin.kind === "connector" ? `${origin.providerKey} · ${origin.connectionLabel}` : `Upload · ${origin.actor}`;
}

export function DocumentsView({ docs, onUpload, onSelect, canUpload }: { docs: DocumentRecord[]; onUpload: () => void; onSelect: (doc: DocumentRecord) => void; canUpload: boolean }) {
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState("all");
  const [status, setStatus] = useState("all");
  const [lifecycles, setLifecycles] = useState<DocumentLifecycle[]>([]);
  const [sourceActivity, setSourceActivity] = useState<SourceActivityConnection[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/document-lifecycle", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => response.ok ? response.json() as Promise<{ data?: DocumentLifecycle[] }> : Promise.reject(new Error(`document_lifecycle_${response.status}`)))
      .then((payload) => setLifecycles(payload.data ?? []))
      .catch((error: unknown) => { if ((error as { name?: string }).name !== "AbortError") setLifecycles([]); });
    void fetch("/api/v1/source-activity", { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => response.ok ? response.json() as Promise<{ data?: SourceActivityConnection[] }> : response.status === 403 ? { data: [] } : Promise.reject(new Error(`source_activity_${response.status}`)))
      .then((payload) => setSourceActivity(payload.data ?? []))
      .catch((error: unknown) => { if ((error as { name?: string }).name !== "AbortError") setSourceActivity([]); });
    return () => controller.abort();
  }, []);

  const lifecycleByDocument = useMemo(() => new Map(lifecycles.map((item) => [item.documentId, item])), [lifecycles]);
  const documents = useMemo(() => docs.map((doc) => ({ ...doc, lifecycle: lifecycleByDocument.get(doc.id) })), [docs, lifecycleByDocument]);
  const documentsById = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
  const periods = useMemo(() => [...new Set(documents.map((doc) => doc.period))].sort().reverse(), [documents]);
  const statuses = useMemo(() => [...new Set(documents.map((doc) => doc.status))].sort(), [documents]);
  const filtered = useMemo(() => documents.filter((doc) => {
    const matchesQuery = `${doc.name} ${doc.fund} ${doc.period} ${doc.type} ${originLabel(doc)}`.toLowerCase().includes(query.toLowerCase());
    const matchesPeriod = period === "all" || doc.period === period;
    const matchesStatus = status === "all" || doc.status === status;
    return matchesQuery && matchesPeriod && matchesStatus;
  }), [documents, period, query, status]);
  const attention = sourceActivity.filter((connection) => connection.needsAttention);

  return <>
    <section className="page-heading"><div><p className="eyebrow">Source library</p><h1>Documents</h1><p className="lede">Every source file, its provenance, processing state, and relationship to a fund period.</p></div>{canUpload && <button className="primary-button" onClick={onUpload}><Icon name="upload"/>Upload documents</button>}</section>
    {attention.length > 0 && <div className="table-card" role="alert"><div className="empty-cell"><strong>{attention.length} source connection{attention.length === 1 ? " needs" : "s need"} attention.</strong> {attention.map((item) => `${item.connectionLabel}: ${item.attentionReason ?? item.status}`).join(" · ")}</div></div>}
    <div className="toolbar" role="search" aria-label="Document filters">
      <label className="search-field"><Icon name="search"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents, funds, periods or sources" aria-label="Search documents"/></label>
      <select className="filter-button" aria-label="Reporting period" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="all">All periods</option>{periods.map((item) => <option key={item} value={item}>{item}</option>)}</select>
      <select className="filter-button" aria-label="Document status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select>
      {(query || period !== "all" || status !== "all") && <button className="text-button" onClick={() => { setQuery(""); setPeriod("all"); setStatus("all"); }}>Clear filters</button>}
      <span className="result-count" role="status">{filtered.length} of {documents.length}</span>
    </div>
    <div className="table-card" tabIndex={0} role="region" aria-label="Documents table"><table className="data-table document-table"><thead><tr><th>Document</th><th>Fund / period</th><th>Source</th><th>Status</th><th>Quality</th><th>Received</th><th><span className="visually-hidden">Actions</span></th></tr></thead><tbody>
      {filtered.length === 0 && <tr><td colSpan={7} className="empty-cell">{documents.length ? "No documents match the current filters." : canUpload ? "No source documents yet. Upload a file to start a reporting cycle." : "No entitled source documents are available."}</td></tr>}
      {filtered.map((doc) => {
        const securityNotice = documentSecurityNotice(doc);
        const origin = doc.lifecycle?.origin;
        return <tr key={doc.id}><td><div className="document-cell"><div className={`file-tile ${doc.name.endsWith("xlsx") ? "excel" : "pdf"}`} aria-hidden="true">{doc.name.endsWith("xlsx") ? "XLS" : "PDF"}</div><div><strong>{doc.name}</strong><span>{doc.type} · {doc.pages} {doc.name.endsWith("xlsx") ? "sheets" : "pages"} · {doc.size}</span></div></div></td><td><strong className="table-primary">{doc.fund}</strong><span className="table-secondary">{doc.period}</span></td><td><strong className="table-primary">{originLabel(doc)}</strong>{origin && <span className="table-secondary">{origin.kind === "connector" ? `Run ${origin.runId.slice(0, 8)} · ${displayTime(origin.acquiredAt)}` : displayTime(origin.occurredAt)}</span>}</td><td>{securityNotice ? <div><StatusPill status="Blocked"/><strong className="table-primary">{securityNotice.label}</strong><span className="table-secondary">{securityNotice.detail} {securityNotice.action}</span></div> : <><StatusPill status={doc.status}/>{doc.status === "Extracting" && <div className="mini-progress"><span style={{width:`${doc.progress ?? 0}%`}}/></div>}</>}</td><td><span className={`quality quality-${doc.quality.toLowerCase()}`}>{doc.quality}</span></td><td className="table-muted">{doc.uploaded}</td><td><button className="icon-button" aria-label={`Open ${doc.name}`} onClick={() => onSelect(doc)}><Icon name="chevron" size={16}/></button></td></tr>;
      })}
    </tbody></table></div>

    {sourceActivity.length > 0 && <section aria-labelledby="source-activity-heading"><section className="page-heading"><div><p className="eyebrow">Connector audit</p><h2 id="source-activity-heading">Source run history</h2><p className="lede">Discovery outcomes use the same document lifecycle as uploads; rejected and duplicate acquisitions remain visible as audit evidence.</p></div></section>
      <div className="table-card" role="region" aria-label="Source connector run history"><table className="data-table"><thead><tr><th>Connection</th><th>Status</th><th>Runs</th><th>Latest run</th></tr></thead><tbody>{sourceActivity.map((connection) => {
        const latest = connection.runs[0];
        return <tr key={connection.sourceConnectionId}><td><strong className="table-primary">{connection.connectionLabel}</strong><span className="table-secondary">{connection.providerKey}</span></td><td><StatusPill status={connection.needsAttention ? "Blocked" : connection.status}/>{connection.attentionReason && <span className="table-secondary">{connection.attentionReason}</span>}</td><td>{connection.runs.length}</td><td>{latest ? <details><summary>{latest.zeroDiscoveryLongRunning ? "Running · no documents after 15+ min" : `${latest.state} · ${latest.discoveredCount} discovered`}</summary><div className="table-muted">Started {displayTime(latest.startedAt)} · accepted {latest.acceptedCount} · duplicate {latest.duplicateCount} · rejected {latest.rejectedCount}</div>{connection.runs.map((run) => <details key={run.runId}><summary>{displayTime(run.startedAt)} · {run.state} · {run.discoveredCount}/{run.acceptedCount}/{run.duplicateCount}/{run.rejectedCount}</summary>{run.zeroDiscoveryLongRunning && <p><strong>No documents discovered yet after 15 minutes.</strong></p>}{run.errorClass && <p>Failure class: {run.errorClass}</p>}<ul>{run.acquisitions.map((acquisition) => <li key={acquisition.acquisitionId}><strong>{acquisition.disposition}</strong> — {acquisition.remotePath} ({acquisition.remoteVersion}) · {acquisition.reason} {acquisition.documentId && documentsById.has(acquisition.documentId) && <button className="text-button" onClick={() => onSelect(documentsById.get(acquisition.documentId!)!)}>Open document</button>}</li>)}</ul></details>)}</details> : "No runs yet"}</td></tr>;
      })}</tbody></table></div>
    </section>}
  </>;
}
