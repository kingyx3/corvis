"use client";

import { useState } from "react";
import type { DocumentRecord } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";

export function DocumentsView({ docs, onUpload, onSelect }: { docs: DocumentRecord[]; onUpload: () => void; onSelect: (doc: DocumentRecord) => void }) {
  const [query, setQuery] = useState("");
  const filtered = docs.filter((doc) => `${doc.name} ${doc.fund} ${doc.period}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <section className="page-heading"><div><p className="eyebrow">SOURCE LIBRARY</p><h1>Documents</h1><p className="lede">Every source file, its processing state, and its relationship to a fund period.</p></div><button className="primary-button" onClick={onUpload}><Icon name="upload"/>Upload documents</button></section>
    <div className="toolbar"><label className="search-field"><Icon name="search"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents, funds or periods"/></label><button className="filter-button">Q2 2026 <span>⌄</span></button><button className="filter-button">All statuses <span>⌄</span></button></div>
    <div className="table-card" tabIndex={0} role="region" aria-label="Documents table"><table className="data-table document-table"><thead><tr><th>Document</th><th>Fund / period</th><th>Status</th><th>Quality</th><th>Uploaded</th><th></th></tr></thead><tbody>{filtered.map((doc) => <tr key={doc.id} onClick={() => onSelect(doc)}><td><div className="document-cell"><div className={`file-tile ${doc.name.endsWith("xlsx") ? "excel" : "pdf"}`}>{doc.name.endsWith("xlsx") ? "XLS" : "PDF"}</div><div><strong>{doc.name}</strong><span>{doc.type} · {doc.pages} {doc.name.endsWith("xlsx") ? "sheets" : "pages"} · {doc.size}</span></div></div></td><td><strong className="table-primary">{doc.fund}</strong><span className="table-secondary">{doc.period}</span></td><td><StatusPill status={doc.status}/>{doc.status === "Extracting" && <div className="mini-progress"><span style={{width:`${doc.progress ?? 0}%`}}/></div>}</td><td><span className={`quality quality-${doc.quality.toLowerCase()}`}>{doc.quality}</span></td><td className="table-muted">{doc.uploaded}</td><td><Icon name="chevron" size={16}/></td></tr>)}</tbody></table></div>
  </>;
}
