"use client";

import { ChangeEvent, DragEvent, FormEvent, useMemo, useRef, useState } from "react";
import { documents as seedDocuments, fundSnapshots, observations, recentActivity, researchSuggestions, type DocumentRecord } from "@/lib/mock-data";
import { uploadDocument, uploadRuntime, type UploadProgress } from "@/lib/upload";

type View = "overview" | "documents" | "review" | "research";
type IconName = "home" | "file" | "table" | "spark" | "upload" | "search" | "arrow" | "dots" | "check" | "clock" | "alert" | "download" | "chevron" | "close" | "send" | "database" | "shield" | "source";

const iconPaths: Record<IconName, React.ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V21h14V9.8"/><path d="M9 21v-7h6v7"/></>,
  file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M9 12h6M9 16h6"/></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/></>,
  spark: <><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/><path d="m5 14 .7 1.8 1.8.7-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7z"/></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v5h16v-5"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
  dots: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  alert: <><path d="M12 3 2.5 20h19z"/><path d="M12 9v4M12 17h.01"/></>,
  download: <><path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  send: <><path d="m3 3 18 9-18 9 4-9z"/><path d="M7 12h14"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
  shield: <><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z"/><path d="m9 12 2 2 4-4"/></>,
  source: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></>,
};

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}

function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase().replaceAll(" ", "-");
  return <span className={`status-pill status-${key}`}><span className="status-dot" />{status}</span>;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function Overview({ onNavigate, onUpload }: { onNavigate: (view: View) => void; onUpload: () => void }) {
  return <>
    <section className="hero-row">
      <div>
        <p className="eyebrow">THURSDAY · 18 SEPTEMBER</p>
        <h1>Good morning, Alex.</h1>
        <p className="lede">Your Q2 reporting cycle is 78% complete. Two funds need attention.</p>
      </div>
      <button className="primary-button" onClick={onUpload}><Icon name="upload" />Upload documents</button>
    </section>

    <section className="metric-grid">
      <button className="metric-card" onClick={() => onNavigate("documents")}>
        <div className="metric-head"><span>Documents this quarter</span><span className="metric-icon"><Icon name="file" /></span></div>
        <strong>42</strong><p><b>+8</b> since last week</p>
      </button>
      <button className="metric-card" onClick={() => onNavigate("review")}>
        <div className="metric-head"><span>Trusted observations</span><span className="metric-icon"><Icon name="database" /></span></div>
        <strong>6,284</strong><p><b>97.8%</b> auto-approved</p>
      </button>
      <button className="metric-card warning" onClick={() => onNavigate("review")}>
        <div className="metric-head"><span>Needs review</span><span className="metric-icon"><Icon name="alert" /></span></div>
        <strong>14</strong><p>Across <b>2 funds</b></p>
      </button>
      <div className="metric-card">
        <div className="metric-head"><span>Published snapshots</span><span className="metric-icon"><Icon name="check" /></span></div>
        <strong>18</strong><p><b>4</b> published this week</p>
      </div>
    </section>

    <section className="two-column">
      <div className="panel">
        <div className="panel-heading"><div><p className="eyebrow">FUND PERIODS</p><h2>Current reporting cycle</h2></div><button className="text-button" onClick={() => onNavigate("documents")}>View all <Icon name="arrow" size={15}/></button></div>
        <div className="snapshot-list">
          {fundSnapshots.map((item) => <div className="snapshot-row" key={item.fund}>
            <div className="fund-mark">{item.fund.split(" ").slice(0,2).map((word) => word[0]).join("")}</div>
            <div className="snapshot-main"><strong>{item.fund}</strong><span>{item.period} · {item.holdings} holdings · {item.facts} facts</span></div>
            <StatusPill status={item.status}/><span className="muted-time">{item.changed}</span><Icon name="chevron" size={16}/>
          </div>)}
        </div>
      </div>
      <div className="panel activity-panel">
        <div className="panel-heading"><div><p className="eyebrow">ACTIVITY</p><h2>What changed</h2></div></div>
        <div className="activity-list">
          {recentActivity.map((item, i) => <div className="activity-row" key={item.title}>
            <span className={`activity-marker marker-${i}`}></span><div><strong>{item.title}</strong><span>{item.detail}</span></div><time>{item.time}</time>
          </div>)}
        </div>
      </div>
    </section>

    <section className="research-callout" onClick={() => onNavigate("research")} role="button" tabIndex={0}>
      <div className="research-symbol"><Icon name="spark" size={22}/></div>
      <div><p className="eyebrow">ASK CORVIS</p><h3>What changed in my portfolio this quarter?</h3><p>Query trusted fund data and source documents together, with evidence.</p></div>
      <div className="research-arrow"><Icon name="arrow"/></div>
    </section>
  </>;
}

function DocumentsView({ docs, onUpload, onSelect }: { docs: DocumentRecord[]; onUpload: () => void; onSelect: (doc: DocumentRecord) => void }) {
  const [query, setQuery] = useState("");
  const filtered = docs.filter((doc) => `${doc.name} ${doc.fund} ${doc.period}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <section className="page-heading"><div><p className="eyebrow">SOURCE LIBRARY</p><h1>Documents</h1><p className="lede">Every source file, its processing state, and its relationship to a fund period.</p></div><button className="primary-button" onClick={onUpload}><Icon name="upload"/>Upload documents</button></section>
    <div className="toolbar"><label className="search-field"><Icon name="search"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents, funds or periods"/></label><button className="filter-button">Q2 2026 <span>⌄</span></button><button className="filter-button">All statuses <span>⌄</span></button></div>
    <div className="table-card">
      <table className="data-table document-table"><thead><tr><th>Document</th><th>Fund / period</th><th>Status</th><th>Quality</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>{filtered.map((doc) => <tr key={doc.id} onClick={() => onSelect(doc)}>
          <td><div className="document-cell"><div className={`file-tile ${doc.name.endsWith("xlsx") ? "excel" : "pdf"}`}>{doc.name.endsWith("xlsx") ? "XLS" : "PDF"}</div><div><strong>{doc.name}</strong><span>{doc.type} · {doc.pages} {doc.name.endsWith("xlsx") ? "sheets" : "pages"} · {doc.size}</span></div></div></td>
          <td><strong className="table-primary">{doc.fund}</strong><span className="table-secondary">{doc.period}</span></td>
          <td><StatusPill status={doc.status}/>{doc.status === "Extracting" && <div className="mini-progress"><span style={{width:`${doc.progress}%`}}/></div>}</td>
          <td><span className={`quality quality-${doc.quality.toLowerCase()}`}>{doc.quality}</span></td><td className="table-muted">{doc.uploaded}</td><td><Icon name="chevron" size={16}/></td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

function ReviewView() {
  const [onlyReview, setOnlyReview] = useState(false);
  const visible = onlyReview ? observations.filter((row) => row.state === "Needs review") : observations;
  const exportCsv = () => {
    const header = ["Company","Metric","Value","Period","Source","Confidence","State"];
    const rows = observations.map((row) => [row.company,row.metric,row.value,row.period,row.source,`${row.confidence}%`,row.state]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "corvis-advent-viii-q2-2026.csv"; link.click(); URL.revokeObjectURL(url);
  };
  return <>
    <section className="page-heading"><div><p className="eyebrow">TRUSTED DATA</p><h1>Data review</h1><p className="lede">Advent International GPE VIII · Q2 2026 · Snapshot v2</p></div><div className="heading-actions"><button className="secondary-button" onClick={exportCsv}><Icon name="download"/>Export CSV</button><button className="primary-button"><Icon name="check"/>Publish snapshot</button></div></section>
    <div className="review-summary">
      <div><span>Observations</span><strong>486</strong></div><div><span>Approved</span><strong>482</strong></div><div><span>Needs review</span><strong className="amber">4</strong></div><div><span>Holdings</span><strong>37</strong></div><div><span>Source coverage</span><strong>99.4%</strong></div>
    </div>
    <div className="toolbar"><div className="segmented"><button className={!onlyReview ? "active" : ""} onClick={() => setOnlyReview(false)}>All observations</button><button className={onlyReview ? "active" : ""} onClick={() => setOnlyReview(true)}>Needs review <span className="count-badge">4</span></button></div><div className="toolbar-spacer"/><button className="filter-button">All companies <span>⌄</span></button><button className="filter-button">All metrics <span>⌄</span></button></div>
    <div className="table-card">
      <table className="data-table review-table"><thead><tr><th>Company</th><th>Metric</th><th>Value</th><th>Period</th><th>Change</th><th>Confidence</th><th>Source evidence</th><th>State</th></tr></thead>
      <tbody>{visible.map((row) => <tr key={row.id}><td><strong>{row.company}</strong></td><td>{row.metric}</td><td><strong className="value-cell">{row.value}</strong></td><td>{row.period}</td><td className={row.delta.startsWith("+") ? "positive" : ""}>{row.delta}</td><td><div className="confidence"><span>{row.confidence}%</span><div><i style={{width:`${row.confidence}%`}}/></div></div></td><td><button className="source-link"><Icon name="source" size={14}/>{row.source}</button></td><td><StatusPill status={row.state}/></td></tr>)}</tbody></table>
    </div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Every value is traceable.</strong><span>Snapshot → consolidated fact → reviewed observation → source reference → original document.</span></div><button className="text-button">View lineage model <Icon name="arrow" size={14}/></button></div>
  </>;
}

function ResearchView() {
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("What changed in my portfolio this quarter?");
  const [loading, setLoading] = useState(false);
  const ask = (value: string) => {
    if (!value.trim()) return;
    setQuestion(value.trim()); setInput(""); setLoading(true); setTimeout(() => setLoading(false), 650);
  };
  return <div className="research-page">
    <section className="page-heading research-heading"><div><p className="eyebrow">AI RESEARCH</p><h1>Ask Corvis</h1><p className="lede">Answers combine deterministic fund data with permissioned source evidence.</p></div><div className="answer-mode"><span className="live-dot"/>Trusted data mode</div></section>
    <div className="research-layout">
      <div className="conversation-panel">
        <div className="user-question"><div className="avatar user-avatar">AM</div><div><span>You</span><p>{question}</p></div></div>
        <div className="assistant-answer"><div className="avatar corvis-avatar">C</div><div className="answer-body"><span>Corvis</span>{loading ? <div className="thinking"><i/><i/><i/></div> : <>
          <p>Across your latest published and review-ready Q2 2026 snapshots, the most material movement is concentrated in operating performance and leverage.</p>
          <div className="answer-callouts"><div><span className="callout-label">12 companies</span><strong>EBITDA increased</strong><p>Median LTM growth of 9.4%</p></div><div><span className="callout-label amber-text">4 companies</span><strong>Leverage increased</strong><p>By more than 0.5x</p></div><div><span className="callout-label">3 holdings</span><strong>Fair value moved &gt;10%</strong><p>Quarter over quarter</p></div></div>
          <p><strong>ABC Corp</strong> was one of the strongest operating movers: LTM Adjusted EBITDA rose to <strong>$125m</strong> (+8.7%) while revenue increased 12.1%. Net debt / EBITDA increased from 3.9x to 4.2x, so earnings growth has not yet translated into lower leverage.</p>
          <div className="citation-row"><button>[1] Advent VIII · Q2 · p.18</button><button>[2] Advent VIII · Q2 · p.19</button><button>[3] Snapshot fps_adv8_2026q2_v2</button></div>
          <p className="answer-footnote">Quantitative statements above were computed from semantic measures. Narrative context was retrieved from entitled source documents.</p>
        </>}</div></div>
        <div className="suggestion-wrap"><span>Try asking</span><div>{researchSuggestions.filter((x) => x !== question).slice(0,3).map((suggestion) => <button key={suggestion} onClick={() => ask(suggestion)}>{suggestion}<Icon name="arrow" size={14}/></button>)}</div></div>
        <form className="ask-box" onSubmit={(e) => {e.preventDefault(); ask(input);}}><textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about a fund, company, metric, change or source document…" rows={2}/><div className="ask-footer"><span><Icon name="shield" size={14}/>Uses only data you can access</span><button disabled={!input.trim()}><Icon name="send" size={17}/></button></div></form>
      </div>
      <aside className="evidence-panel"><p className="eyebrow">EVIDENCE</p><h3>Sources used</h3><div className="evidence-card"><div className="evidence-head"><div className="file-tile pdf">PDF</div><div><strong>Advent International GPE VIII</strong><span>Q2 2026 · Quarterly report</span></div></div><div className="evidence-snippet"><span>Page 18</span><p>“Adjusted EBITDA” <mark>$125m</mark> · LTM Jun-26</p></div><button>Open source <Icon name="arrow" size={14}/></button></div><div className="evidence-card semantic"><div className="semantic-icon"><Icon name="database"/></div><div><strong>Fund-period snapshot</strong><span>fps_adv8_2026q2_v2</span></div><dl><dt>Status</dt><dd>Published</dd><dt>Facts</dt><dd>486</dd><dt>Formula</dt><dd>semantic-v4.2</dd></dl></div><div className="evidence-policy"><Icon name="shield"/><p>Source retrieval is permission-checked before search results are returned.</p></div></aside>
    </div>
  </div>;
}

function UploadModal({ onClose, onCompleted }: { onClose: () => void; onCompleted: (record: DocumentRecord) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<Record<string, UploadProgress>>({});
  const [dragging, setDragging] = useState(false);
  const addFiles = async (files: File[]) => {
    const accepted = files.filter((file) => /\.(pdf|xlsx|xls|docx|pptx|csv)$/i.test(file.name));
    for (const file of accepted) {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      setQueue((prev) => ({ ...prev, [key]: { fileName: file.name, uploadedBytes: 0, totalBytes: file.size, percent: 0, status: "queued" } }));
      try {
        const result = await uploadDocument(file, { onProgress: (progress) => setQueue((prev) => ({ ...prev, [key]: progress })) });
        onCompleted({ id: result.documentId, name: file.name, fund: "Classifying…", period: "Detecting…", type: "Source document", pages: 0, size: formatBytes(file.size), status: "Queued", progress: 0, uploaded: "Just now", quality: "Pending", observations: 0 });
      } catch (error) {
        setQueue((prev) => ({ ...prev, [key]: { ...prev[key], status: "error", error: error instanceof Error ? error.message : "Upload failed" } }));
      }
    }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; };
  const items = Object.entries(queue);
  const allDone = items.length > 0 && items.every(([,item]) => item.status === "complete");
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="upload-modal">
    <div className="modal-head"><div><p className="eyebrow">SOURCE INGESTION</p><h2>Upload documents</h2><p>Files are registered immediately, then processed in the background.</p></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></div>
    <div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={(e) => {e.preventDefault(); setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()}>
      <div className="drop-icon"><Icon name="upload" size={24}/></div><strong>Drop files here, or choose files</strong><span>PDF, Excel, Word, PowerPoint or CSV · large files supported</span><input ref={inputRef} type="file" hidden multiple accept=".pdf,.xlsx,.xls,.docx,.pptx,.csv" onChange={onChange}/>
    </div>
    <div className="upload-architecture"><Icon name="shield"/><span>Large files upload directly to encrypted object storage in resumable {Math.round(uploadRuntime.partSize / 1024 / 1024)} MB parts.</span><b>{uploadRuntime.mockMode ? "Demo transport" : "Secure transport"}</b></div>
    {items.length > 0 && <div className="upload-list">{items.map(([key,item]) => <div className="upload-item" key={key}><div className="file-tile pdf">{item.fileName.toLowerCase().endsWith("pdf") ? "PDF" : "DOC"}</div><div className="upload-item-main"><div><strong>{item.fileName}</strong><span>{formatBytes(item.totalBytes)} · {item.status === "complete" ? "Uploaded" : item.status === "finalizing" ? "Finalizing…" : item.status === "error" ? item.error : `${item.percent}%`}</span></div><div className="upload-progress"><span style={{width:`${item.percent}%`}}/></div></div>{item.status === "complete" ? <div className="upload-check"><Icon name="check" size={15}/></div> : <span className="upload-percent">{item.percent}%</span>}</div>)}</div>}
    <div className="modal-footer"><div><span>What happens next?</span><p>Register → diagnose → extract → review → reconcile → publish</p></div><button className={allDone ? "primary-button" : "secondary-button"} onClick={onClose}>{allDone ? "View documents" : "Done"}</button></div>
  </div></div>;
}

function DocumentDrawer({ doc, onClose, onReview }: { doc: DocumentRecord; onClose: () => void; onReview: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><aside className="document-drawer"><div className="drawer-head"><div className="file-tile pdf">{doc.name.endsWith("xlsx") ? "XLS" : "PDF"}</div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></div><p className="eyebrow">DOCUMENT</p><h2>{doc.name}</h2><div className="drawer-status"><StatusPill status={doc.status}/><span>{doc.size}</span><span>{doc.pages || "—"} pages</span></div><hr/><h3>Resolved context</h3><dl className="metadata-grid"><dt>Fund</dt><dd>{doc.fund}</dd><dt>Reporting period</dt><dd>{doc.period}</dd><dt>Document type</dt><dd>{doc.type}</dd><dt>Document ID</dt><dd><code>{doc.id}</code></dd><dt>Source quality</dt><dd>{doc.quality}</dd><dt>Observations</dt><dd>{doc.observations || "Processing"}</dd></dl><hr/><h3>Processing pipeline</h3><div className="pipeline-list">{["Registered & secured","Document interpreted","Facts extracted","Independent review","Fund-period consolidated"].map((step,index) => <div key={step} className={index < (doc.status === "Published" ? 5 : doc.status === "Review" ? 3 : doc.status === "Extracting" ? 2 : 1) ? "done" : index === (doc.status === "Published" ? 5 : doc.status === "Review" ? 3 : doc.status === "Extracting" ? 2 : 1) ? "current" : ""}><span>{index < 3 ? <Icon name="check" size={13}/> : index + 1}</span><strong>{step}</strong></div>)}</div>{doc.status === "Published" && <><hr/><div className="drawer-actions"><button className="primary-button" onClick={onReview}>Open trusted data <Icon name="arrow" size={15}/></button><button className="secondary-button"><Icon name="source"/>View source</button></div></>}</aside></div>;
}

export default function CorvisApp() {
  const [view, setView] = useState<View>("overview");
  const [docs, setDocs] = useState<DocumentRecord[]>(seedDocuments);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const nav = useMemo(() => [
    { id: "overview" as View, label: "Overview", icon: "home" as IconName },
    { id: "documents" as View, label: "Documents", icon: "file" as IconName, badge: docs.filter((d) => d.status === "Review").length },
    { id: "review" as View, label: "Data review", icon: "table" as IconName, badge: 4 },
    { id: "research" as View, label: "Ask Corvis", icon: "spark" as IconName },
  ], [docs]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">C</span><span>CORVIS</span></div>
      <nav>{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</button>)}</nav>
      <div className="sidebar-section"><p>WORKSPACE</p><button><span className="workspace-dot">N</span><span>Northbridge Partners</span><span className="down-caret">⌄</span></button></div>
      <div className="sidebar-bottom"><div className="cycle-card"><span>Q2 reporting cycle</span><strong>78% complete</strong><div><i style={{width:"78%"}}/></div><p>18 of 23 fund periods</p></div><button className="profile"><span className="avatar">AM</span><span><strong>Alex Morgan</strong><small>Investment team</small></span><span className="down-caret">⌄</span></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Northbridge Partners</span><Icon name="chevron" size={13}/><strong>{nav.find((item) => item.id === view)?.label}</strong></div><div className="top-actions"><button className="global-search"><Icon name="search" size={16}/>Search funds, companies, documents <kbd>⌘K</kbd></button><button className="icon-button"><Icon name="dots"/></button></div></header>
      <div className={`content ${view === "research" ? "research-content" : ""}`}>
        {view === "overview" && <Overview onNavigate={setView} onUpload={() => setUploadOpen(true)}/>} 
        {view === "documents" && <DocumentsView docs={docs} onUpload={() => setUploadOpen(true)} onSelect={setSelectedDoc}/>} 
        {view === "review" && <ReviewView/>}
        {view === "research" && <ResearchView/>}
      </div>
    </main>
    {uploadOpen && <UploadModal onClose={() => {setUploadOpen(false); setView("documents");}} onCompleted={(record) => setDocs((prev) => [record, ...prev])}/>} 
    {selectedDoc && <DocumentDrawer doc={selectedDoc} onClose={() => setSelectedDoc(null)} onReview={() => {setSelectedDoc(null); setView("review");}}/>}
  </div>;
}
