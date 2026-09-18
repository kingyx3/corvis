"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DocumentRecord, ReadinessReport, ResearchCitation, View, WorkspaceBootstrap } from "@/core/contracts";
import { Icon, type IconName } from "@/components/ui/icon";
import { OverviewView } from "@/features/overview/overview-view";
import { DocumentsView } from "@/features/documents/documents-view";
import { UploadModal } from "@/features/documents/upload-modal";
import { DocumentDrawer } from "@/features/documents/document-drawer";
import { ReviewView } from "@/features/review/review-view";
import { ResearchView } from "@/features/research/research-view";
import { AdminView } from "@/features/admin/admin-view";
import { platform } from "@/runtime/services";

function initials(name?: string): string {
  return (name || "User").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "U";
}

export default function CorvisApp() {
  const [view, setView] = useState<View>("overview");
  const [workspace, setWorkspace] = useState<WorkspaceBootstrap | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const next = await platform.bootstrap(signal);
      setWorkspace(next);
      if (next.session.roles.includes("admin")) platform.readiness(signal).then(setReadiness).catch(() => setReadiness(null));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setLoadError(reason instanceof Error ? reason.message : "Could not load the Corvis workspace");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const documents = workspace?.documents || [];
  const observations = workspace?.observations || [];
  const snapshots = workspace?.fundSnapshots || [];
  const session = workspace?.session;
  const adminVisible = Boolean(workspace?.featureFlags.administration && session?.roles.includes("admin"));
  const nav = useMemo(() => [
    { id: "overview" as View, label: "Overview", icon: "home" as IconName },
    { id: "documents" as View, label: "Documents", icon: "file" as IconName, badge: documents.filter((doc) => doc.status === "Review").length },
    { id: "review" as View, label: "Data review", icon: "table" as IconName, badge: observations.filter((row) => row.state === "Needs review").length },
    { id: "research" as View, label: "Ask Corvis", icon: "spark" as IconName },
    ...(adminVisible ? [{ id: "admin" as View, label: "Administration", icon: "shield" as IconName }] : []),
  ], [adminVisible, documents, observations]);

  const openSource = useCallback(async (sourceReferenceId: string) => {
    try {
      const source = await platform.openSource(sourceReferenceId);
      const page = Number(source.pageNumber || source.page_number || 0);
      const url = page > 0 ? `${source.documentUrl}#page=${page}` : source.documentUrl;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Could not open source evidence");
    }
  }, []);

  const onOpenCitation = useCallback((citation: ResearchCitation) => {
    if (citation.type === "source") void openSource(citation.id);
    else setView("review");
  }, [openSource]);

  if (!workspace) {
    return <main className="main-area"><div className="content"><section className="page-heading"><div><p className="eyebrow">CORVIS</p><h1>{loadError ? "Workspace unavailable" : "Loading trusted data…"}</h1><p className="lede">{loadError || "Establishing your authenticated tenant context and serving data."}</p>{loadError && <button className="primary-button" onClick={() => void refresh()}>Retry</button>}</div></section></div></main>;
  }

  const workspaceName = session?.workspaceName || "Corvis Workspace";
  const published = snapshots.filter((snapshot) => snapshot.status === "Published").length;
  const cyclePercent = snapshots.length ? Math.round((published / snapshots.length) * 100) : 0;
  const snapshotId = snapshots.find((snapshot) => snapshot.status === "Review" && snapshot.id)?.id || snapshots.find((snapshot) => snapshot.id)?.id;
  const approvedCount = observations.filter((row) => row.state === "Approved").length;
  const needsReviewCount = observations.filter((row) => row.state === "Needs review").length;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">C</span><span>CORVIS</span></div>
      <nav>{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</button>)}</nav>
      <div className="sidebar-section"><p>WORKSPACE</p><button><span className="workspace-dot">{workspaceName[0]?.toUpperCase() || "C"}</span><span>{workspaceName}</span></button></div>
      <div className="sidebar-bottom"><div className="cycle-card"><span>Reporting cycle</span><strong>{cyclePercent}% published</strong><div><i style={{width:`${cyclePercent}%`}}/></div><p>{published} of {snapshots.length} fund periods</p></div><button className="profile" onClick={() => window.location.assign("/api/auth/logout")} title="Sign out"><span className="avatar">{initials(session?.name)}</span><span><strong>{session?.name || session?.email || "Corvis user"}</strong><small>{session?.roles.join(" · ") || "read only"}</small></span><span className="down-caret">↗</span></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>{workspaceName}</span><Icon name="chevron" size={13}/><strong>{nav.find((item) => item.id === view)?.label}</strong></div><div className="top-actions"><button className="global-search" onClick={() => setView("research")}><Icon name="search" size={16}/>Search funds, companies, documents <kbd>⌘K</kbd></button><button className="icon-button" aria-label="More workspace actions"><Icon name="dots"/></button></div></header>
      {loadError && <div className="content"><div className="lineage-note" role="alert"><Icon name="alert"/><div><strong>Some data could not be refreshed.</strong><span>{loadError}</span></div><button className="text-button" onClick={() => void refresh()}>Retry</button></div></div>}
      <div className={`content ${view === "research" ? "research-content" : ""}`}>
        {view === "overview" && <OverviewView snapshots={snapshots} activity={workspace.recentActivity} userName={session?.name} documentCount={documents.length} trustedObservations={approvedCount} needsReview={needsReviewCount} onNavigate={setView} onUpload={() => setUploadOpen(true)}/>} 
        {view === "documents" && <DocumentsView docs={documents} onUpload={() => setUploadOpen(true)} onSelect={setSelectedDoc}/>} 
        {view === "review" && <ReviewView observations={observations} snapshotId={snapshotId} onReview={async (observationId, decision) => { await platform.reviewObservation(observationId, { decision }); await refresh(); }} onPublish={async (id) => { await platform.publishSnapshot(id); await refresh(); }} onExport={async (id) => { const result = await platform.createExport(id, "csv"); window.location.assign(result.url); }} onOpenSource={(id) => void openSource(id)}/>} 
        {view === "research" && <ResearchView suggestions={workspace.researchSuggestions} onAsk={(question) => platform.ask(question)} onOpenCitation={onOpenCitation}/>} 
        {view === "admin" && adminVisible && <AdminView session={workspace.session} readiness={readiness}/>} 
      </div>
    </main>
    {uploadOpen && <UploadModal onClose={() => { setUploadOpen(false); setView("documents"); void refresh(); }} onCompleted={() => void refresh()}/>} 
    {selectedDoc && <DocumentDrawer doc={selectedDoc} onClose={() => setSelectedDoc(null)} onReview={() => { setSelectedDoc(null); setView("review"); }}/>} 
  </div>;
}
