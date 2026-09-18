"use client";

import { useMemo, useState } from "react";
import type { DocumentRecord, View } from "@/core/contracts";
import { documents as seedDocuments, fundSnapshots, observations, recentActivity, researchSuggestions } from "@/adapters/demo/catalog";
import { Icon, type IconName } from "@/components/ui/icon";
import { OverviewView } from "@/features/overview/overview-view";
import { DocumentsView } from "@/features/documents/documents-view";
import { UploadModal } from "@/features/documents/upload-modal";
import { DocumentDrawer } from "@/features/documents/document-drawer";
import { ReviewView } from "@/features/review/review-view";
import { ResearchView } from "@/features/research/research-view";

export default function CorvisApp() {
  const [view, setView] = useState<View>("overview");
  const [docs, setDocs] = useState<DocumentRecord[]>(seedDocuments);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);

  const nav = useMemo(() => [
    { id: "overview" as View, label: "Overview", icon: "home" as IconName },
    { id: "documents" as View, label: "Documents", icon: "file" as IconName, badge: docs.filter((doc) => doc.status === "Review").length },
    { id: "review" as View, label: "Data review", icon: "table" as IconName, badge: observations.filter((row) => row.state === "Needs review").length },
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
        {view === "overview" && <OverviewView snapshots={fundSnapshots} activity={recentActivity} onNavigate={setView} onUpload={() => setUploadOpen(true)}/>} 
        {view === "documents" && <DocumentsView docs={docs} onUpload={() => setUploadOpen(true)} onSelect={setSelectedDoc}/>} 
        {view === "review" && <ReviewView observations={observations}/>} 
        {view === "research" && <ResearchView suggestions={researchSuggestions}/>} 
      </div>
    </main>
    {uploadOpen && <UploadModal onClose={() => { setUploadOpen(false); setView("documents"); }} onCompleted={(record) => setDocs((prev) => [record, ...prev])}/>} 
    {selectedDoc && <DocumentDrawer doc={selectedDoc} onClose={() => setSelectedDoc(null)} onReview={() => { setSelectedDoc(null); setView("review"); }}/>} 
  </div>;
}
