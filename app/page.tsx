"use client";

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DocumentRecord, FundSnapshot, ObservationRecord, View } from "@/core/contracts";
import type { Permission } from "@/core/enterprise";
import type { WorkspaceCapabilities } from "@/core/workspace";
import { recentActivity, researchSuggestions } from "@/adapters/demo/catalog";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon, type IconName } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { OverviewView } from "@/features/overview/overview-view";
import { DocumentsView } from "@/features/documents/documents-view";
import { UploadModal } from "@/features/documents/upload-modal";
import { DocumentDrawer } from "@/features/documents/document-drawer";
import { ReviewView, type ReviewFocusRequest } from "@/features/review/review-view";
import { DeliveryView } from "@/features/delivery/delivery-view";
import { ResearchView } from "@/features/research/research-view";

type ReadModule = "capabilities" | "documents" | "snapshots" | "observations";
type ModuleErrors = Partial<Record<ReadModule, string>>;
type SearchResult =
  | { kind: "document"; key: string; title: string; detail: string; document: DocumentRecord }
  | { kind: "fund"; key: string; title: string; detail: string; snapshot: FundSnapshot }
  | { kind: "observation"; key: string; title: string; detail: string; observation: ObservationRecord };

function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "Module temporarily unavailable"; }
function fallbackCapabilities(documentsAvailable: boolean, observationsAvailable: boolean): WorkspaceCapabilities {
  const permissions: Permission[] = [];
  if (documentsAvailable) permissions.push("documents:read");
  if (observationsAvailable) permissions.push("observations:read");
  return { permissions, sourceDocumentAccessAllowed: false, redistributionAllowed: false };
}

export default function CorvisApp() {
  const [view, setView] = useState<View>("overview");
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [snapshots, setSnapshots] = useState<FundSnapshot[]>([]);
  const [observations, setObservations] = useState<ObservationRecord[]>([]);
  const [capabilities, setCapabilities] = useState<WorkspaceCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [moduleErrors, setModuleErrors] = useState<ModuleErrors>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | undefined>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const [reviewFocus, setReviewFocus] = useState<ReviewFocusRequest | null>(null);

  const applyWorkspaceResults = useCallback((results: [PromiseSettledResult<WorkspaceCapabilities>, PromiseSettledResult<DocumentRecord[]>, PromiseSettledResult<FundSnapshot[]>, PromiseSettledResult<ObservationRecord[]>]) => {
    const [capabilitiesResult, documentsResult, snapshotsResult, observationsResult] = results;
    const nextErrors: ModuleErrors = {};
    if (documentsResult.status === "fulfilled") setDocs(documentsResult.value); else nextErrors.documents = errorMessage(documentsResult.reason);
    if (snapshotsResult.status === "fulfilled") setSnapshots(snapshotsResult.value); else nextErrors.snapshots = errorMessage(snapshotsResult.reason);
    if (observationsResult.status === "fulfilled") setObservations(observationsResult.value); else nextErrors.observations = errorMessage(observationsResult.reason);
    if (capabilitiesResult.status === "fulfilled") setCapabilities(capabilitiesResult.value);
    else {
      nextErrors.capabilities = errorMessage(capabilitiesResult.reason);
      setCapabilities(fallbackCapabilities(documentsResult.status === "fulfilled", observationsResult.status === "fulfilled"));
    }
    setModuleErrors(nextErrors);
    setLoading(false);
  }, []);

  const loadWorkspace = useCallback(() => Promise.allSettled([
    workspacePort.capabilities(),
    workspacePort.listDocuments(),
    workspacePort.listSnapshots(),
    workspacePort.listObservations(),
  ]) as Promise<[PromiseSettledResult<WorkspaceCapabilities>, PromiseSettledResult<DocumentRecord[]>, PromiseSettledResult<FundSnapshot[]>, PromiseSettledResult<ObservationRecord[]>]>, []);

  // Background refresh after a mutation (publish, approval, upload, retry):
  // keep the current view mounted so its confirmations, filters and queue
  // position survive. Only the first load shows the full-page loading state.
  const refreshWorkspace = useCallback(async () => {
    applyWorkspaceResults(await loadWorkspace());
  }, [applyWorkspaceResults, loadWorkspace]);

  useEffect(() => {
    let active = true;
    void loadWorkspace().then((results) => { if (active) applyWorkspaceResults(results); });
    return () => { active = false; };
  }, [applyWorkspaceResults, loadWorkspace]);

  const allowed = useCallback((permission: Permission) => capabilities?.permissions.includes(permission) === true, [capabilities]);
  const canReadDocuments = allowed("documents:read");
  const canUpload = allowed("documents:write");
  const canReadObservations = allowed("observations:read");
  const canReview = allowed("observations:review");
  const canPublish = allowed("snapshots:publish");
  const canResearch = allowed("research:query");
  const canExport = allowed("exports:create") && capabilities?.redistributionAllowed === true;
  const canReadSources = allowed("sources:read") && capabilities?.sourceDocumentAccessAllowed === true;
  const canSearch = canReadDocuments || canReadObservations;

  // The shortcut is offered exactly when the search button is.
  useEffect(() => {
    if (!canSearch) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSearch]);

  const reviewSnapshot = snapshots.find((snapshot) => snapshot.id && snapshot.id === selectedSnapshotId) ?? snapshots.find((snapshot) => snapshot.status === "Review") ?? snapshots[0];
  const publishedSnapshots = snapshots.filter((snapshot) => snapshot.status === "Published").length;
  const degradedModules = Object.keys(moduleErrors) as ReadModule[];
  const nav = useMemo(() => [
    { id: "overview" as View, label: "Overview", icon: "home" as IconName, visible: true },
    { id: "documents" as View, label: "Documents", icon: "file" as IconName, badge: docs.filter((doc) => doc.status === "Review").length, visible: canReadDocuments },
    { id: "review" as View, label: "Data review", icon: "table" as IconName, badge: observations.filter((row) => row.state === "Needs review").length, visible: canReadObservations },
    { id: "delivery" as View, label: "Data delivery", icon: "download" as IconName, visible: canExport },
    { id: "research" as View, label: "Ask Corvis", icon: "spark" as IconName, visible: canResearch },
  ].filter((item) => item.visible), [canExport, canReadDocuments, canReadObservations, canResearch, docs, observations]);
  // A view that stops being allowed (e.g. capabilities changed on refresh)
  // falls back to the overview instead of rendering an empty workspace.
  const activeView: View = nav.some((item) => item.id === view) ? view : "overview";

  // Plain navigation drops any pending drill-through focus so a later visit to
  // the review queue does not jump back to an old search result.
  const navigate = (next: View) => { setReviewFocus(null); setView(next); };
  const openSnapshot = (snapshot: FundSnapshot) => { if (!canReadObservations) return; setSelectedSnapshotId(snapshot.id); navigate("review"); };

  const searchResults = useMemo<SearchResult[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const results: SearchResult[] = [];
    if (canReadDocuments) for (const doc of docs) if (`${doc.name} ${doc.fund} ${doc.period}`.toLowerCase().includes(query)) results.push({ kind: "document", key: `doc:${doc.id}`, title: doc.name, detail: `${doc.fund} · ${doc.period}`, document: doc });
    if (canReadObservations) {
      for (const snapshot of snapshots) if (`${snapshot.fund} ${snapshot.period}`.toLowerCase().includes(query)) results.push({ kind: "fund", key: `fund:${snapshot.id}:${snapshot.period}`, title: snapshot.fund, detail: `${snapshot.period} · ${snapshot.status}`, snapshot });
      for (const row of observations) if (`${row.company} ${row.metric} ${row.value} ${row.period}`.toLowerCase().includes(query)) results.push({ kind: "observation", key: `obs:${row.id}`, title: `${row.company} · ${row.metric}`, detail: `${row.value} · ${row.period} · ${row.state}`, observation: row });
    }
    return results.slice(0, 20);
  }, [canReadDocuments, canReadObservations, docs, observations, searchQuery, snapshots]);
  const activeResultIndex = Math.min(activeResult, Math.max(searchResults.length - 1, 0));

  const closeSearch = () => { setSearchOpen(false); setSearchQuery(""); setActiveResult(0); };
  const chooseSearchResult = (result: SearchResult) => {
    closeSearch();
    if (result.kind === "document") { setSelectedDoc(result.document); navigate("documents"); return; }
    if (result.kind === "fund") { openSnapshot(result.snapshot); return; }
    if (result.observation.snapshotId) setSelectedSnapshotId(result.observation.snapshotId);
    setReviewFocus((current) => ({ observationId: result.observation.id, key: (current?.key ?? 0) + 1 }));
    setView("review");
  };
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!searchResults.length) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(searchResults.length - 1, activeResultIndex + 1) : Math.max(0, activeResultIndex - 1);
      setActiveResult(next);
      document.getElementById(`search-result-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      const result = searchResults[activeResultIndex];
      if (!result) return;
      event.preventDefault();
      chooseSearchResult(result);
    }
  };

  const scopedUnavailable = (title: string, detail: string) => <section className="page-heading" role="alert"><div><p className="eyebrow">Module unavailable</p><h1>{title}</h1><p className="lede">{detail}</p><button className="secondary-button" onClick={() => void refreshWorkspace()}>Retry this workspace</button></div></section>;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="Workspace navigation"><div className="brand"><span className="brand-mark" aria-hidden="true">C</span><span>CORVIS</span></div><nav aria-label="Workspace sections">{nav.map((item) => <button key={item.id} className={activeView === item.id ? "active" : ""} aria-current={activeView === item.id ? "page" : undefined} aria-label={item.label} onClick={() => navigate(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</button>)}</nav><div className="sidebar-section"><p>WORKSPACE</p><div className="profile"><span className="workspace-dot" aria-hidden="true">N</span><span><strong>Current workspace</strong><small>Tenant-scoped</small></span></div></div><div className="sidebar-bottom"><div className="cycle-card"><span>Reporting cycle</span><strong>{snapshots.length} fund periods</strong><p>Tenant-scoped serving data</p></div><div className="profile"><span className="avatar" aria-hidden="true">U</span><span><strong>Signed-in user</strong><small>Enterprise session</small></span></div></div></aside>
    <main className="main-area" id="main-content" tabIndex={-1}><header className="topbar" role="banner"><div className="breadcrumb" aria-label="Breadcrumb"><span>Workspace</span><Icon name="chevron" size={13}/><strong>{nav.find((item) => item.id === activeView)?.label ?? "Overview"}</strong></div><div className="top-actions">{canSearch && <button className="global-search" aria-label="Search entitled workspace data" aria-keyshortcuts="Meta+K Control+K" aria-haspopup="dialog" aria-expanded={searchOpen} onClick={() => setSearchOpen(true)}><Icon name="search" size={16}/><span className="global-search-label">Search entitled workspace data</span><kbd aria-hidden="true">⌘K</kbd></button>}</div></header><div className={`content ${activeView === "research" ? "research-content" : ""}`}>
      {loading && <section className="page-heading" aria-busy="true"><div><p className="eyebrow">Workspace</p><h1>Loading trusted data…</h1><p className="lede">Fetching entitled documents, snapshots and observations.</p></div></section>}
      {!loading && degradedModules.length > 0 && <div className="lineage-note tone-warning" role="status" aria-label="Workspace degraded"><Icon name="alert"/><div><strong>Some workspace modules are degraded</strong><span>{degradedModules.join(", ")}. Healthy modules remain available; capability failures fail closed for mutating actions.</span></div><button className="text-button" onClick={() => void refreshWorkspace()}>Retry</button></div>}
      {!loading && activeView === "overview" && <OverviewView snapshots={snapshots} activity={process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true" ? recentActivity : []} onNavigate={navigate} onUpload={() => setUploadOpen(true)} onSnapshotSelect={openSnapshot} canUpload={canUpload} canReadDocuments={canReadDocuments} canReadObservations={canReadObservations} canResearch={canResearch}/>} 
      {!loading && activeView === "documents" && canReadDocuments && (moduleErrors.documents ? scopedUnavailable("Documents are temporarily unavailable", moduleErrors.documents) : <DocumentsView docs={docs} onUpload={() => setUploadOpen(true)} onSelect={setSelectedDoc} canUpload={canUpload}/>)} 
      {!loading && activeView === "review" && canReadObservations && (moduleErrors.observations || moduleErrors.snapshots ? scopedUnavailable("Data review is temporarily unavailable", moduleErrors.observations || moduleErrors.snapshots || "Required review state is unavailable") : <ReviewView observations={observations} snapshot={reviewSnapshot} canReview={canReview} canPublish={canPublish} canReadSources={canReadSources} canExport={canExport} focusRequest={reviewFocus} onObservationUpdated={(updated) => setObservations((current) => current.map((row) => row.id === updated.id ? updated : row))} onPublished={(published) => { setSelectedSnapshotId(published.id); setSnapshots((current) => current.map((snapshot) => snapshot.id === published.id ? published : snapshot)); void refreshWorkspace(); }}/>)} 
      {!loading && activeView === "delivery" && canExport && <DeliveryView publishedSnapshots={publishedSnapshots}/>} 
      {!loading && activeView === "research" && canResearch && <ResearchView suggestions={process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true" ? researchSuggestions : []} canReadSources={canReadSources}/>}
    </div></main>
    {searchOpen && canSearch && <Modal label="Global workspace search" onClose={closeSearch} align="top" width="min(680px, 100%)"><label className="search-palette-input"><Icon name="search" size={18}/><input autoFocus role="combobox" aria-expanded={searchResults.length > 0} aria-controls="global-search-results" aria-autocomplete="list" aria-activedescendant={searchResults.length ? `search-result-${activeResultIndex}` : undefined} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setActiveResult(0); }} onKeyDown={onSearchKeyDown} placeholder="Search funds, companies, documents or metrics" aria-label="Search workspace"/><kbd>Esc</kbd></label><div className="search-palette-results">{!searchQuery.trim() && <p className="search-palette-empty">Type to search documents, fund periods and observations you are entitled to.</p>}{searchQuery.trim() && searchResults.length === 0 && <p role="status" className="search-palette-empty">No entitled workspace results match “{searchQuery}”.</p>}{searchResults.length > 0 && <div id="global-search-results" role="listbox" aria-label="Search results">{searchResults.map((result, index) => <div key={result.key} id={`search-result-${index}`} role="option" aria-selected={index === activeResultIndex} className="search-result" onMouseDown={(event) => event.preventDefault()} onMouseMove={() => { if (index !== activeResultIndex) setActiveResult(index); }} onClick={() => chooseSearchResult(result)}><span><strong>{result.title}</strong><small>{result.detail}</small></span><span className="search-kind">{result.kind}</span></div>)}</div>}</div><div className="search-palette-footer" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></div></Modal>}
    {uploadOpen && canUpload && <UploadModal onClose={() => { setUploadOpen(false); navigate("documents"); }} onCompleted={(record) => { setDocs((prev) => [record, ...prev.filter((item) => item.id !== record.id)]); void refreshWorkspace(); }}/>} 
    {selectedDoc && <DocumentDrawer doc={selectedDoc} onClose={() => setSelectedDoc(null)} canOpenTrustedData={canReadObservations} onReview={() => { const match = snapshots.find((snapshot) => snapshot.fund === selectedDoc.fund && snapshot.period === selectedDoc.period); if (match?.id) setSelectedSnapshotId(match.id); setSelectedDoc(null); navigate("review"); }}/>} 
  </div>;
}
