"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DocumentRecord, FundSnapshot, ObservationRecord, View } from "@/core/contracts";
import { recentActivity, researchSuggestions } from "@/adapters/demo/catalog";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon, type IconName } from "@/components/ui/icon";
import { OverviewView } from "@/features/overview/overview-view";
import { DocumentsView } from "@/features/documents/documents-view";
import { UploadModal } from "@/features/documents/upload-modal";
import { DocumentDrawer } from "@/features/documents/document-drawer";
import { ReviewView } from "@/features/review/review-view";
import { DeliveryView } from "@/features/delivery/delivery-view";
import { ResearchView } from "@/features/research/research-view";

type ReadModule = "documents" | "snapshots" | "observations";
type ModuleErrors = Partial<Record<ReadModule, string>>;

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Module temporarily unavailable";
}

export default function CorvisApp() {
  const [view, setView] = useState<View>("overview");
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [snapshots, setSnapshots] = useState<FundSnapshot[]>([]);
  const [observations, setObservations] = useState<ObservationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [moduleErrors, setModuleErrors] = useState<ModuleErrors>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);

  const refreshWorkspace = useCallback(async () => {
    const [documentsResult, snapshotsResult, observationsResult] = await Promise.allSettled([
      workspacePort.listDocuments(),
      workspacePort.listSnapshots(),
      workspacePort.listObservations(),
    ]);

    const nextErrors: ModuleErrors = {};
    if (documentsResult.status === "fulfilled") setDocs(documentsResult.value);
    else nextErrors.documents = errorMessage(documentsResult.reason);

    if (snapshotsResult.status === "fulfilled") setSnapshots(snapshotsResult.value);
    else nextErrors.snapshots = errorMessage(snapshotsResult.reason);

    if (observationsResult.status === "fulfilled") setObservations(observationsResult.value);
    else nextErrors.observations = errorMessage(observationsResult.reason);

    setModuleErrors(nextErrors);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      workspacePort.listDocuments(),
      workspacePort.listSnapshots(),
      workspacePort.listObservations(),
    ]).then(([documentsResult, snapshotsResult, observationsResult]) => {
      if (!active) return;
      const nextErrors: ModuleErrors = {};
      if (documentsResult.status === "fulfilled") setDocs(documentsResult.value);
      else nextErrors.documents = errorMessage(documentsResult.reason);
      if (snapshotsResult.status === "fulfilled") setSnapshots(snapshotsResult.value);
      else nextErrors.snapshots = errorMessage(snapshotsResult.reason);
      if (observationsResult.status === "fulfilled") setObservations(observationsResult.value);
      else nextErrors.observations = errorMessage(observationsResult.reason);
      setModuleErrors(nextErrors);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const reviewSnapshot = snapshots.find((snapshot) => snapshot.status === "Review") ?? snapshots[0];
  const publishedSnapshots = snapshots.filter((snapshot) => snapshot.status === "Published").length;
  const degradedModules = Object.keys(moduleErrors) as ReadModule[];
  const nav = useMemo(() => [
    { id: "overview" as View, label: "Overview", icon: "home" as IconName },
    { id: "documents" as View, label: "Documents", icon: "file" as IconName, badge: docs.filter((doc) => doc.status === "Review").length },
    { id: "review" as View, label: "Data review", icon: "table" as IconName, badge: observations.filter((row) => row.state === "Needs review").length },
    { id: "delivery" as View, label: "Data delivery", icon: "download" as IconName },
    { id: "research" as View, label: "Ask Corvis", icon: "spark" as IconName },
  ], [docs, observations]);

  const scopedUnavailable = (title: string, detail: string) => <section className="page-heading" role="alert"><div><p className="eyebrow">MODULE UNAVAILABLE</p><h1>{title}</h1><p className="lede">{detail}</p><button className="secondary-button" onClick={() => void refreshWorkspace()}>Retry this workspace</button></div></section>;

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Workspace navigation">
      <div className="brand"><span className="brand-mark">C</span><span>CORVIS</span></div>
      <nav aria-label="Workspace sections">{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} aria-label={item.label} onClick={() => setView(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</button>)}</nav>
      <div className="sidebar-section"><p>WORKSPACE</p><button><span className="workspace-dot">N</span><span>Current workspace</span><span className="down-caret">⌄</span></button></div>
      <div className="sidebar-bottom"><div className="cycle-card"><span>Reporting cycle</span><strong>{snapshots.length} fund periods</strong><p>Tenant-scoped serving data</p></div><button className="profile"><span className="avatar">U</span><span><strong>Signed-in user</strong><small>Enterprise session</small></span><span className="down-caret">⌄</span></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar" role="banner"><div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={13}/><strong>{nav.find((item) => item.id === view)?.label}</strong></div><div className="top-actions"><button className="global-search"><Icon name="search" size={16}/>Search funds, companies, documents <kbd>⌘K</kbd></button><button className="icon-button" aria-label="More workspace options"><Icon name="dots"/></button></div></header>
      <div className={`content ${view === "research" ? "research-content" : ""}`}>
        {loading && <section className="page-heading"><div><p className="eyebrow">WORKSPACE</p><h1>Loading trusted data…</h1></div></section>}
        {!loading && degradedModules.length > 0 && <div className="lineage-note" role="status" aria-label="Workspace degraded"><Icon name="alert"/><div><strong>Some workspace modules are degraded</strong><span>{degradedModules.join(", ")}. Healthy modules remain available while the affected module is repaired.</span></div><button className="text-button" onClick={() => void refreshWorkspace()}>Retry</button></div>}
        {!loading && view === "overview" && <OverviewView snapshots={snapshots} activity={process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true" ? recentActivity : []} onNavigate={setView} onUpload={() => setUploadOpen(true)}/>} 
        {!loading && view === "documents" && (moduleErrors.documents ? scopedUnavailable("Documents are temporarily unavailable", moduleErrors.documents) : <DocumentsView docs={docs} onUpload={() => setUploadOpen(true)} onSelect={setSelectedDoc}/>)} 
        {!loading && view === "review" && (moduleErrors.observations || moduleErrors.snapshots ? scopedUnavailable("Data review is temporarily unavailable", moduleErrors.observations || moduleErrors.snapshots || "Required review state is unavailable") : <ReviewView observations={observations} snapshot={reviewSnapshot} onObservationUpdated={(updated) => setObservations((current) => current.map((row) => row.id === updated.id ? updated : row))} onPublished={(published) => { setSnapshots((current) => current.map((snapshot) => snapshot.id === published.id ? published : snapshot)); void refreshWorkspace(); }}/>)} 
        {!loading && view === "delivery" && <DeliveryView publishedSnapshots={publishedSnapshots}/>} 
        {!loading && view === "research" && <ResearchView suggestions={researchSuggestions}/>} 
      </div>
    </main>
    {uploadOpen && <UploadModal onClose={() => { setUploadOpen(false); setView("documents"); }} onCompleted={(record) => { setDocs((prev) => [record, ...prev.filter((item) => item.id !== record.id)]); void refreshWorkspace(); }}/>} 
    {selectedDoc && <DocumentDrawer doc={selectedDoc} onClose={() => setSelectedDoc(null)} onReview={() => { setSelectedDoc(null); setView("review"); }}/>} 
  </div>;
}
