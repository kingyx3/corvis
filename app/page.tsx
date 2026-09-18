"use client";

import { useEffect, useMemo, useState } from "react";
import type { DocumentRecord, FundSnapshot, ObservationRecord, View } from "@/core/contracts";
import { recentActivity, researchSuggestions } from "@/adapters/demo/catalog";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon, type IconName } from "@/components/ui/icon";
import { OverviewView } from "@/features/overview/overview-view";
import { DocumentsView } from "@/features/documents/documents-view";
import { UploadModal } from "@/features/documents/upload-modal";
import { DocumentDrawer } from "@/features/documents/document-drawer";
import { ReviewView } from "@/features/review/review-view";
import { ResearchView } from "@/features/research/research-view";

export default function CorvisApp() {
  const [view, setView] = useState<View>("overview");
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [snapshots, setSnapshots] = useState<FundSnapshot[]>([]);
  const [observations, setObservations] = useState<ObservationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([workspacePort.listDocuments(), workspacePort.listSnapshots(), workspacePort.listObservations()])
      .then(([loadedDocs, loadedSnapshots, loadedObservations]) => {
        if (!active) return;
        setDocs(loadedDocs); setSnapshots(loadedSnapshots); setObservations(loadedObservations); setLoadError(null);
      })
      .catch((error) => active && setLoadError(error instanceof Error ? error.message : "Unable to load workspace"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const nav = useMemo(() => [
    { id: "overview" as View, label: "Overview", icon: "home" as IconName },
    { id: "documents" as View, label: "Documents", icon: "file" as IconName, badge: docs.filter((doc) => doc.status === "Review").length },
    { id: "review" as View, label: "Data review", icon: "table" as IconName, badge: observations.filter((row) => row.state === "Needs review").length },
    { id: "research" as View, label: "Ask Corvis", icon: "spark" as IconName },
  ], [docs, observations]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">C</span><span>CORVIS</span></div>
      <nav>{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</button>)}</nav>
      <div className="sidebar-section"><p>WORKSPACE</p><button><span className="workspace-dot">N</span><span>Current workspace</span><span className="down-caret">⌄</span></button></div>
      <div className="sidebar-bottom"><div className="cycle-card"><span>Reporting cycle</span><strong>{snapshots.length} fund periods</strong><p>Tenant-scoped serving data</p></div><button className="profile"><span className="avatar">U</span><span><strong>Signed-in user</strong><small>Enterprise session</small></span><span className="down-caret">⌄</span></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={13}/><strong>{nav.find((item) => item.id === view)?.label}</strong></div><div className="top-actions"><button className="global-search"><Icon name="search" size={16}/>Search funds, companies, documents <kbd>⌘K</kbd></button><button className="icon-button"><Icon name="dots"/></button></div></header>
      <div className={`content ${view === "research" ? "research-content" : ""}`}>
        {loading && <section className="page-heading"><div><p className="eyebrow">WORKSPACE</p><h1>Loading trusted data…</h1></div></section>}
        {!loading && loadError && <section className="page-heading"><div><p className="eyebrow">WORKSPACE ERROR</p><h1>Unable to load this workspace</h1><p className="lede">{loadError}</p></div></section>}
        {!loading && !loadError && view === "overview" && <OverviewView snapshots={snapshots} activity={process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true" ? recentActivity : []} onNavigate={setView} onUpload={() => setUploadOpen(true)}/>} 
        {!loading && !loadError && view === "documents" && <DocumentsView docs={docs} onUpload={() => setUploadOpen(true)} onSelect={setSelectedDoc}/>} 
        {!loading && !loadError && view === "review" && <ReviewView observations={observations}/>} 
        {!loading && !loadError && view === "research" && <ResearchView suggestions={researchSuggestions}/>} 
      </div>
    </main>
    {uploadOpen && <UploadModal onClose={() => { setUploadOpen(false); setView("documents"); }} onCompleted={(record) => setDocs((prev) => [record, ...prev])}/>} 
    {selectedDoc && <DocumentDrawer doc={selectedDoc} onClose={() => setSelectedDoc(null)} onReview={() => { setSelectedDoc(null); setView("review"); }}/>} 
  </div>;
}
