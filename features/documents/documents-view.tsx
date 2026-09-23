"use client";

import { useMemo, useState } from "react";
import type { DocumentRecord } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

export function DocumentsView({ docs, onUpload, onSelect, canUpload }: { docs: DocumentRecord[]; onUpload: () => void; onSelect: (doc: DocumentRecord) => void; canUpload: boolean }) {
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState("all");
  const [status, setStatus] = useState("all");
  const periods = useMemo(() => [...new Set(docs.map((doc) => doc.period))].sort().reverse(), [docs]);
  const statuses = useMemo(() => [...new Set(docs.map((doc) => doc.status))].sort(), [docs]);
  const filtered = useMemo(() => docs.filter((doc) => {
    const matchesQuery = `${doc.name} ${doc.fund} ${doc.period} ${doc.type}`.toLowerCase().includes(query.toLowerCase());
    const matchesPeriod = period === "all" || doc.period === period;
    const matchesStatus = status === "all" || doc.status === status;
    return matchesQuery && matchesPeriod && matchesStatus;
  }), [docs, period, query, status]);

  return <>
    <section className="page-heading"><div><p className="eyebrow">Source library</p><h1>Documents</h1><p className="lede">Every source file, its processing state, and its relationship to a fund period.</p></div>{canUpload && <button className="primary-button" onClick={onUpload}><Icon name="upload"/>Upload documents</button>}</section>
    <div className="toolbar" role="search" aria-label="Document filters">
      <label className="search-field"><Icon name="search"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents, funds or periods" aria-label="Search documents"/></label>
      <select className="filter-button" aria-label="Reporting period" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="all">All periods</option>{periods.map((item) => <option key={item} value={item}>{item}</option>)}</select>
      <select className="filter-button" aria-label="Document status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select>
      {(query || period !== "all" || status !== "all") && <button className="text-button" onClick={() => { setQuery(""); setPeriod("all"); setStatus("all"); }}>Clear filters</button>}
      <span className="result-count" role="status">{filtered.length} of {docs.length}</span>
    </div>
    <div className="table-card" tabIndex={0} role="region" aria-label="Documents table"><table className="data-table document-table"><thead><tr><th>Document</th><th>Fund / period</th><th>Status</th><th>Quality</th><th>Uploaded</th><th><span className="visually-hidden">Actions</span></th></tr></thead><tbody>
      {filtered.length === 0 && <tr><td colSpan={6} className="empty-cell">{docs.length ? "No documents match the current filters." : canUpload ? "No source documents yet. Upload a file to start a reporting cycle." : "No entitled source documents are available."}</td></tr>}
      {filtered.map((doc) => <tr key={doc.id}><td><div className="document-cell"><div className={`file-tile ${doc.name.endsWith("xlsx") ? "excel" : "pdf"}`} aria-hidden="true">{doc.name.endsWith("xlsx") ? "XLS" : "PDF"}</div><div><strong>{doc.name}</strong><span>{doc.type} · {doc.pages} {doc.name.endsWith("xlsx") ? "sheets" : "pages"} · {doc.size}</span></div></div></td><td><strong className="table-primary">{doc.fund}</strong><span className="table-secondary">{doc.period}</span></td><td><StatusPill status={doc.status}/>{doc.status === "Extracting" && <div className="mini-progress"><span style={{width:`${doc.progress ?? 0}%`}}/></div>}</td><td><span className={`quality quality-${doc.quality.toLowerCase()}`}>{doc.quality}</span></td><td className="table-muted">{doc.uploaded}</td><td><button className="icon-button" aria-label={`Open ${doc.name}`} onClick={() => onSelect(doc)}><Icon name="chevron" size={16}/></button></td></tr>)}
    </tbody></table></div>
  </>;
}
