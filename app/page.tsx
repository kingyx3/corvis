"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DocumentRecord, FundSnapshot, ObservationRecord, View } from "@/core/contracts";
import { currentSnapshots } from "@/core/current-snapshots";
import type { Permission } from "@/core/enterprise";
import type { WorkspaceCapabilities, WorkspaceIdentity } from "@/core/workspace";
import { comparePeriods, type AttentionTarget, type WorkspaceSummary } from "@/core/workspace-summary";
import { NO_DEMO_FIXTURES, loadDemoUiFixtures, type DemoUiFixtures } from "@/runtime/demo-fixtures";
import { SESSION_EXPIRED_EVENT, friendlyErrorMessage, isUnauthenticatedError, sessionExpiredCopy } from "@/lib/api-errors";
import { SessionExpiryTracker } from "@/lib/session-expiry";
import { OAUTH_RETURN_MARKER } from "@/core/source-connect-wizard";
import { parseViewHash, viewHash } from "@/lib/view-hash";
import { useDocumentTitle } from "@/components/ui/use-document-title";
import { ViewErrorBoundary } from "@/components/ui/view-error-boundary";
import { createLatestRequestGate } from "@/lib/latest-request";
import { CONTACT_SUPPORT, helpLinks } from "@/lib/support";
import { setSupportScope } from "@/lib/support-scope";
import { researchDraftForView, type ResearchDraft } from "@/lib/research-draft";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon, type IconName } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { ContactSupportLink } from "@/components/help/contact-support-link";
import { HelpDialog } from "@/components/help/help-dialog";
import { useSupportConfig } from "@/components/help/use-support-request";
import { PageHeading } from "@/components/ui/page-heading";
import { SidebarNavItem } from "@/components/ui/sidebar-nav-item";
import { OverviewView } from "@/features/overview/overview-view";
import { DashboardDepthSections } from "@/features/overview/dashboard-depth-sections";
import type { PositionFinancialsFocusRequest } from "@/features/analytics/position-financials-view";
import { AnalyticsView } from "@/features/analytics/analytics-view";
import { DocumentsView } from "@/features/documents/documents-view";
import { UploadModal } from "@/features/documents/upload-modal";
import { DisplaySettings } from "@/features/preferences/display-settings";
import { usePreferences } from "@/features/preferences/preference-provider";
import { type ReconciliationException } from "@/core/enterprise";
import { type SourceEvidence } from "@/core/workspace";
import { NotificationSettingsDialog } from "@/features/notifications/notification-settings-dialog";
import { DocumentDrawer } from "@/features/documents/document-drawer";
import { ReviewView, type ReviewFocusRequest } from "@/features/review/review-view";
import { DeliveryView } from "@/features/delivery/delivery-view";
import { ResearchView } from "@/features/research/research-view";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { AccessAdminView } from "@/features/access/access-admin-view";
import { FundPeriodStatusChip, type FundPeriodStatus } from "@/components/ui/fund-period-status-chip";
import { DataIssuesView } from "@/features/data-issues/data-issues-view";
import { useDataIssueIndicator } from "@/features/data-issues/use-data-issue-indicator";

type ReadModule = "capabilities" | "documents" | "snapshots" | "observations" | "summary";
type ModuleErrors = Partial<Record<ReadModule, string>>;
type SearchResult =
  | { kind: "document"; key: string; title: string; detail: string; document: DocumentRecord }
  | { kind: "fund"; key: string; title: string; detail: string; snapshot: FundSnapshot }
  | { kind: "observation"; key: string; title: string; detail: string; observation: ObservationRecord };
type CommandResult = { kind: "command"; category: "Navigation" | "Action" | "Help"; key: string; title: string; detail: string; keywords: string; run: () => void };
type PaletteResult = SearchResult | CommandResult;

function errorMessage(reason: unknown): string { return friendlyErrorMessage(reason, "This module is temporarily unavailable. Retry, or contact support if it persists."); }
function fallbackCapabilities(documentsAvailable: boolean, observationsAvailable: boolean): WorkspaceCapabilities {
  const permissions: Permission[] = [];
  if (documentsAvailable) permissions.push("documents:read");
  if (observationsAvailable) permissions.push("observations:read");
  return { permissions, sourceDocumentAccessAllowed: false, redistributionAllowed: false };
}

export default function CorvisApp() {
  usePreferences();
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const [researchDraft, setResearchDraft] = useState<ResearchDraft | null>(null);
  const [sourceLocation, setSourceLocation] = useState<SourceEvidence | null>(null);
  const [view, setView] = useState<View>("overview");
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [snapshots, setSnapshots] = useState<FundSnapshot[]>([]);
  const [observations, setObservations] = useState<ObservationRecord[]>([]);
  const [capabilities, setCapabilities] = useState<WorkspaceCapabilities | null>(null);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [moduleErrors, setModuleErrors] = useState<ModuleErrors>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | undefined>();
  const [searchOpen, setSearchOpen] = useState(false);
  // The sidebar workspace section is hidden at <=960px; this dialog carries it on tablets and phones (#245).
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const supportConfig = useSupportConfig();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const [reviewFocus, setReviewFocus] = useState<ReviewFocusRequest | null>(null);
  const [analyticsFocus, setAnalyticsFocus] = useState<PositionFinancialsFocusRequest | null>(null);
  const [identity, setIdentity] = useState<WorkspaceIdentity | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Every report of an expired session goes through `reportSessionExpired`, and a successful workspace load only clears the
  // prompt when nothing reported one after it started (see lib/session-expiry.ts).
  const [sessionExpiry] = useState(() => new SessionExpiryTracker());
  const reportSessionExpired = useCallback(() => { sessionExpiry.report(); setSessionExpired(true); }, [sessionExpiry]);
  const [demoFixtures, setDemoFixtures] = useState<DemoUiFixtures>(NO_DEMO_FIXTURES);
  const [announcement, setAnnouncement] = useState("");

  // Optional emails link to /?notifications=settings; open the dialog once and drop the parameter.
  useEffect(() => {
    const openFromEmailLink = () => {
      const url = new URL(window.location.href);
      // A source provider's consent page redirects back to `/?source_oauth=return&…`: land on Documents, where the Connect source wizard resumes.
      if (url.searchParams.has(OAUTH_RETURN_MARKER) && !url.hash) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${viewHash("documents")}`);
      if (url.searchParams.get("notifications") !== "settings") return;
      url.searchParams.delete("notifications");
      window.history.replaceState(window.history.state, "", url.toString());
      setNotificationsOpen(true);
    };
    openFromEmailLink();
  }, []);

  useEffect(() => {
    let active = true;
    // Demo-only fixtures are a dynamic import behind the build-time demo flag; production builds never fetch them.
    void loadDemoUiFixtures().then((fixtures) => { if (active) setDemoFixtures(fixtures); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Contact support quotes the workspace the shell loaded, even from an error page that replaces the shell.
  useEffect(() => { if (identity) setSupportScope({ tenantId: identity.tenantId, workspaceId: identity.workspaceId }); }, [identity]);

  useEffect(() => {
    let active = true;
    // An expired session is not a module failure: prompt re-authentication instead of degrading silently.
    void workspacePort.whoAmI().then((value) => { if (active) setIdentity(value); }).catch((reason: unknown) => { if (active && isUnauthenticatedError(reason)) reportSessionExpired(); });
    window.addEventListener(SESSION_EXPIRED_EVENT, reportSessionExpired);
    return () => { active = false; window.removeEventListener(SESSION_EXPIRED_EVENT, reportSessionExpired); };
  }, [reportSessionExpired]);

  const applyWorkspaceResults = useCallback((results: [PromiseSettledResult<WorkspaceCapabilities>, PromiseSettledResult<DocumentRecord[]>, PromiseSettledResult<FundSnapshot[]>, PromiseSettledResult<ObservationRecord[]>]) => {
    const [capabilitiesResult, documentsResult, snapshotsResult, observationsResult] = results;
    const nextErrors: ModuleErrors = {};
    // A module that answered 401 shows the prompt. A successful re-fetch (Retry after signing in again) clears it, but only a
    // load that began after the last report of an expiry: one that was already in flight when, say, the notification
    // preferences reported it must not undo that report just because its own response arrived later.
    if ([capabilitiesResult, documentsResult, snapshotsResult, observationsResult].some((result) => result.status === "rejected" && isUnauthenticatedError(result.reason))) reportSessionExpired();
    else if (sessionExpiry.loadMayClear()) setSessionExpired(false);
    if (documentsResult.status === "fulfilled") setDocs(documentsResult.value); else nextErrors.documents = errorMessage(documentsResult.reason);
    if (snapshotsResult.status === "fulfilled") setSnapshots(currentSnapshots(snapshotsResult.value)); else nextErrors.snapshots = errorMessage(snapshotsResult.reason);
    if (observationsResult.status === "fulfilled") setObservations(observationsResult.value); else nextErrors.observations = errorMessage(observationsResult.reason);
    if (capabilitiesResult.status === "fulfilled") setCapabilities(capabilitiesResult.value);
    else {
      nextErrors.capabilities = errorMessage(capabilitiesResult.reason);
      setCapabilities(fallbackCapabilities(documentsResult.status === "fulfilled", observationsResult.status === "fulfilled"));
    }
    // The summary loads on its own path; keep its error while the other modules are re-applied.
    setModuleErrors((current) => current.summary ? { ...nextErrors, summary: current.summary } : nextErrors);
    setLoading(false);
  }, [reportSessionExpired, sessionExpiry]);
  const applySummaryResult = useCallback((result: PromiseSettledResult<WorkspaceSummary>) => {
    if (result.status === "rejected" && isUnauthenticatedError(result.reason)) reportSessionExpired();
    setSummary(result.status === "fulfilled" ? result.value : null);
    setModuleErrors((current) => {
      const next = { ...current };
      if (result.status === "fulfilled") delete next.summary; else next.summary = errorMessage(result.reason);
      return next;
    });
  }, [reportSessionExpired]);

  const loadWorkspace = useCallback(() => {
    sessionExpiry.beginLoad();
    return Promise.allSettled([
      workspacePort.capabilities(),
      workspacePort.listDocuments(),
      workspacePort.listSnapshots(),
      workspacePort.listObservations(),
    ]) as Promise<[PromiseSettledResult<WorkspaceCapabilities>, PromiseSettledResult<DocumentRecord[]>, PromiseSettledResult<FundSnapshot[]>, PromiseSettledResult<ObservationRecord[]>]>;
  }, [sessionExpiry]);

  const loadSummary = useCallback(() => Promise.allSettled([workspacePort.workspaceSummary()]).then(([result]) => result), []);

  // Only the most recent request of each kind may apply its result: an older, slower response
  // (e.g. from the initial load or an earlier Retry) must never overwrite a newer one.
  const [gates] = useState(() => ({ workspace: createLatestRequestGate(), summary: createLatestRequestGate() }));
  const refreshModules = useCallback(() => gates.workspace(loadWorkspace, applyWorkspaceResults), [applyWorkspaceResults, gates, loadWorkspace]);
  const refreshSummary = useCallback(() => gates.summary(loadSummary, applySummaryResult), [applySummaryResult, gates, loadSummary]);
  const refreshWorkspace = useCallback(async () => { await Promise.all([refreshModules(), refreshSummary()]); }, [refreshModules, refreshSummary]);

  useEffect(() => {
    void refreshModules();
    void refreshSummary();
  }, [refreshModules, refreshSummary]);

  const allowed = useCallback((permission: Permission) => capabilities?.permissions.includes(permission) === true, [capabilities]);
  const canReadDocuments = allowed("documents:read");
  const canUpload = allowed("documents:write");
  const canReadObservations = allowed("observations:read");
  const canReview = allowed("observations:review");
  const canPublish = allowed("snapshots:publish");
  const canResearch = allowed("research:query");
  const canAdmin = allowed("admin:manage");
  const canExport = allowed("exports:create") && capabilities?.redistributionAllowed === true;
  const canReadSources = allowed("sources:read") && capabilities?.sourceDocumentAccessAllowed === true;
  const canSearch = canReadDocuments || canReadObservations;
  const dataIssues = useDataIssueIndicator(canReadObservations, view);

  const reviewSnapshot = snapshots.find((snapshot) => snapshot.id && snapshot.id === selectedSnapshotId) ?? snapshots.find((snapshot) => snapshot.status === "Review") ?? snapshots[0];
  const publishedSnapshots = snapshots.filter((snapshot) => snapshot.status === "Published").length;
  // D14: a persistent cross-view chip showing the active fund-period's own
  // blocking review/exception counts, derived from the same attention items
  // Overview already surfaces — never a separate source of truth.
  const fundPeriodStatus = useMemo<FundPeriodStatus | null>(() => {
    if (!canReadObservations || !reviewSnapshot?.id || !summary) return null;
    let blockingExceptions = 0;
    let needsReview = 0;
    for (const item of summary.attention.items) {
      if (item.target.view !== "review" || item.target.snapshotId !== reviewSnapshot.id) continue;
      if (item.kind === "blocking_exception") blockingExceptions += item.count;
      else if (item.kind === "needs_review") needsReview += item.count;
    }
    return { fund: reviewSnapshot.fund, period: reviewSnapshot.period, blockingExceptions, needsReview };
  }, [canReadObservations, reviewSnapshot, summary]);
  // The summary needs observations:read; a 403 for other roles is entitlement, not degradation.
  const degradedModules = (Object.keys(moduleErrors) as ReadModule[]).filter((module) => module !== "summary" || canReadObservations);
  const nav = useMemo(() => [
    { id: "overview" as View, label: "Overview", icon: "home" as IconName, visible: true },
    { id: "analytics" as View, label: "Portfolio analytics", icon: "database" as IconName, visible: canReadObservations },
    { id: "documents" as View, label: "Documents", icon: "file" as IconName, badge: docs.filter((doc) => doc.status === "Review").length, visible: canReadDocuments },
    { id: "review" as View, label: "Data review", icon: "table" as IconName, badge: observations.filter((row) => row.state === "Needs review").length, visible: canReadObservations },
    { id: "delivery" as View, label: "Data delivery", icon: "download" as IconName, visible: canExport },
    { id: "research" as View, label: "Ask Corvis", icon: "spark" as IconName, visible: canResearch },
    { id: "issues" as View, label: "Data issues", icon: "alert" as IconName, badge: dataIssues.unseen, visible: canReadObservations },
    { id: "access" as View, label: "Access administration", icon: "shield" as IconName, visible: canAdmin && identity?.tenantAdmin === true },
  ].filter((item) => item.visible), [canAdmin, canExport, canReadDocuments, canReadObservations, canResearch, dataIssues.unseen, docs, identity?.tenantAdmin, observations]);
  const activeView: View = nav.some((item) => item.id === view) ? view : "overview";
  const activeLabel = nav.find((item) => item.id === activeView)?.label ?? "Overview";

  // The active view lives in the URL hash so reload and Back/Forward land on the same view.
  // Forward navigation pushes an entry; history traversal only reads the hash.
  const changeView = useCallback((next: View) => {
    setView(next);
    const inUrl = parseViewHash(window.location.hash);
    if (inUrl !== next && !(inUrl === null && next === "overview")) window.history.pushState(null, "", viewHash(next));
  }, []);
  useEffect(() => {
    const readHash = () => {
      const parsed = parseViewHash(window.location.hash);
      // Other hashes (the skip link's #main-content) are not view routes and leave the view alone.
      if (parsed) setView(parsed); else if (!window.location.hash) setView("overview");
    };
    readHash();
    window.addEventListener("popstate", readHash);
    window.addEventListener("hashchange", readHash);
    return () => { window.removeEventListener("popstate", readHash); window.removeEventListener("hashchange", readHash); };
  }, []);
  // Once permissions are known, a hash for a view this user cannot open is corrected in place.
  useEffect(() => {
    if (loading) return;
    const inUrl = parseViewHash(window.location.hash);
    if (inUrl !== null && inUrl !== activeView) window.history.replaceState(null, "", viewHash(activeView));
    // `view` is in the deps because `activeView` stays "overview" while a later hashchange requests a
    // view this user cannot open; without it that URL would never be corrected.
  }, [view, activeView, loading]);


  useDocumentTitle(`${activeLabel} · Corvis`);

  // After the first render of real content, a change of view moves focus to the new view's h1
  // (so keyboard and screen-reader users land at the top of the new content) and is announced.
  const shownView = useRef<View | null>(null);
  useEffect(() => {
    if (loading) return;
    const previous = shownView.current;
    shownView.current = activeView;
    if (previous === null || previous === activeView) return;
    setAnnouncement(`Navigated to ${activeLabel}`);
    const main = document.getElementById("main-content");
    const heading = main?.querySelector<HTMLElement>("h1");
    // A view that already moved focus itself (e.g. a drill-through to a specific row) keeps it, and
    // focusing the heading never scrolls: views position their own content (row reveal, etc.).
    const viewMovedFocus = main != null && document.activeElement !== main && main.contains(document.activeElement);
    if (heading && !viewMovedFocus) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [activeLabel, activeView, loading]);

  const navigate = useCallback((next: View) => { setReviewFocus(null); setAnalyticsFocus(null); setResearchDraft((current) => researchDraftForView(current, next)); changeView(next); }, [changeView]);
  const viewPositionFinancials = (row: ObservationRecord) => {
    if (!row.companyId) return;
    setAnalyticsFocus((current) => ({ companyId: row.companyId!, fundId: row.fundId, holdingId: row.holdingId, period: row.period, key: (current?.key ?? 0) + 1 }));
    changeView("analytics");
  };
  const openSnapshot = (snapshot: FundSnapshot) => { if (!canReadObservations) return; setSelectedSnapshotId(snapshot.id); navigate("review"); };
  const openSnapshotById = (snapshotId: string | undefined, fund?: string) => {
    const snapshot = snapshots.find((item) => item.id && item.id === snapshotId) ?? snapshots.filter((item) => item.fund === fund).sort((a, b) => comparePeriods(b.period, a.period))[0];
    if (snapshot) openSnapshot(snapshot); else if (canReadObservations) navigate("review");
  };
  const openDocumentById = (documentId: string, location?: SourceEvidence) => {
    setSourceLocation(location ?? null);
    if (!canReadDocuments) return;
    const document = docs.find((item) => item.id === documentId);
    if (!document) return;
    setSelectedDoc(document);
    navigate("documents");
  };
  const explainException = (item: ReconciliationException) => {
    if (!canResearch) return;
    const subject = observations.find((row) => [row.companyId, row.holdingId, row.fundId].includes(item.subjectId));
    const question = `Explain the ${item.metricCode ?? "metric"} reconciliation conflict for ${subject?.company ?? item.subjectId ?? "this fund"} (subject ${item.subjectType ?? "company"} "${item.subjectId ?? ""}") in fund ${item.fundId}, period ${item.reportPeriod}: ${item.summary}. Compare the conflicting observations and cite the underlying evidence. Do not treat this explanation as a review decision.`;
    setResearchDraft((current) => ({ question, key: (current?.key ?? 0) + 1 })); changeView("research");
  };
  const openAttention = (target: AttentionTarget) => {
    if (target.view === "documents") { openDocumentById(target.documentId); return; }
    if (target.view === "admin" || !canReadObservations) return;
    if (target.snapshotId) setSelectedSnapshotId(target.snapshotId);
    setAnalyticsFocus(null);
    setReviewFocus(target.observationId ? (current) => ({ observationId: target.observationId!, key: (current?.key ?? 0) + 1 }) : null);
    changeView("review");
  };
  const openReviewObservation = (observationId: string) => {
    if (!canReadObservations) return;
    setAnalyticsFocus(null);
    setReviewFocus((current) => ({ observationId, key: (current?.key ?? 0) + 1 }));
    changeView("review");
  };

  const closeSearch = () => { setSearchOpen(false); setSearchQuery(""); setActiveResult(0); };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const searchResults = useMemo<SearchResult[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query || !canSearch) return [];
    const results: SearchResult[] = [];
    if (canReadDocuments) for (const doc of docs) if (`${doc.name} ${doc.fund} ${doc.period}`.toLowerCase().includes(query)) results.push({ kind: "document", key: `doc:${doc.id}`, title: doc.name, detail: `${doc.fund} · ${doc.period}`, document: doc });
    if (canReadObservations) {
      for (const snapshot of snapshots) if (`${snapshot.fund} ${snapshot.period}`.toLowerCase().includes(query)) results.push({ kind: "fund", key: `fund:${snapshot.id}:${snapshot.period}`, title: snapshot.fund, detail: `${snapshot.period} · ${snapshot.status}`, snapshot });
      for (const row of observations) if (`${row.company} ${row.metric} ${row.value} ${row.period}`.toLowerCase().includes(query)) results.push({ kind: "observation", key: `obs:${row.id}`, title: `${row.company} · ${row.metric}`, detail: `${row.value} · ${row.period} · ${row.state}`, observation: row });
    }
    return results.slice(0, 20);
  }, [canReadDocuments, canReadObservations, canSearch, docs, observations, searchQuery, snapshots]);

  const paletteResults = useMemo<PaletteResult[]>(() => {
    const commands: CommandResult[] = [
      ...nav.map((item) => ({ kind: "command" as const, category: "Navigation" as const, key: `nav:${item.id}`, title: item.label, detail: `Go to ${item.label}`, keywords: `navigate open go ${item.label}`, run: () => { closeSearch(); navigate(item.id); } })),
      { kind: "command", category: "Action", key: "action:refresh", title: "Refresh workspace", detail: "Re-fetch entitled workspace data", keywords: "reload refresh sync data", run: () => { closeSearch(); void refreshWorkspace(); } },
      { kind: "command", category: "Action", key: "action:display", title: "Display preferences", detail: "Time zone, date and number formats", keywords: "timezone time zone number date display preferences settings", run: () => { closeSearch(); setDisplaySettingsOpen(true); } },
      { kind: "command", category: "Action", key: "action:notifications", title: "Notification settings", detail: "Choose which events email you", keywords: "notifications email alerts preferences digest settings", run: () => { closeSearch(); setNotificationsOpen(true); } },
      { kind: "command", category: "Help", key: "help:contact", title: `Help: ${CONTACT_SUPPORT.label}`, detail: CONTACT_SUPPORT.description, keywords: CONTACT_SUPPORT.keywords, run: () => { closeSearch(); setHelpOpen(true); } },
      ...helpLinks(supportConfig).map((link) => ({ kind: "command" as const, category: "Help" as const, key: `help:${link.id}`, title: `Help: ${link.label}`, detail: link.description, keywords: link.keywords, run: () => { closeSearch(); window.open(link.href, "_blank", "noopener,noreferrer"); } })),
      ...(canUpload ? [{ kind: "command" as const, category: "Action" as const, key: "action:upload", title: "Upload documents", detail: "Open the governed document upload flow", keywords: "upload add document files", run: () => { closeSearch(); setUploadOpen(true); } }] : []),
      ...(canReview && canReadObservations ? [{ kind: "command" as const, category: "Action" as const, key: "action:review", title: "Review data", detail: "Open observations that need review", keywords: "review approve observations exceptions", run: () => { closeSearch(); navigate("review"); } }] : []),
    ];
    const query = searchQuery.trim().toLowerCase();
    const matchingCommands = commands.filter((command) => !query || `${command.title} ${command.detail} ${command.keywords}`.toLowerCase().includes(query));
    return [...matchingCommands, ...searchResults].slice(0, 20);
  }, [canReadObservations, canReview, canUpload, nav, navigate, refreshWorkspace, searchQuery, searchResults, supportConfig]);
  const activeResultIndex = Math.min(activeResult, Math.max(paletteResults.length - 1, 0));

  const choosePaletteResult = (result: PaletteResult) => {
    if (result.kind === "command") { result.run(); return; }
    closeSearch();
    if (result.kind === "document") { setSelectedDoc(result.document); navigate("documents"); return; }
    if (result.kind === "fund") { openSnapshot(result.snapshot); return; }
    if (result.observation.snapshotId) setSelectedSnapshotId(result.observation.snapshotId);
    setReviewFocus((current) => ({ observationId: result.observation.id, key: (current?.key ?? 0) + 1 }));
    changeView("review");
  };
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!paletteResults.length) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(paletteResults.length - 1, activeResultIndex + 1) : Math.max(0, activeResultIndex - 1);
      setActiveResult(next);
      document.getElementById(`search-result-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      const result = paletteResults[activeResultIndex];
      if (!result) return;
      event.preventDefault();
      choosePaletteResult(result);
    }
  };

  const scopedUnavailable = (title: string, detail: string) => <div role="alert"><PageHeading eyebrow="Module unavailable" title={title} description={detail}><button className="secondary-button" onClick={() => void refreshWorkspace()}>Retry this workspace</button><ContactSupportLink className="text-button" view={activeView}/></PageHeading></div>;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="Workspace navigation"><div className="brand"><span className="brand-mark" aria-hidden="true">C</span><span>CORVIS</span></div><nav aria-label="Workspace sections">{nav.map((item) => <SidebarNavItem key={item.id} label={item.label} icon={item.icon} badge={item.badge} active={activeView === item.id} onSelect={() => navigate(item.id)}/>)}<button type="button" className="sidebar-workspace-button" aria-label="Workspace and access" aria-haspopup="dialog" onClick={() => setWorkspaceOpen(true)}><Icon name="shield"/><span>Workspace</span></button></nav><WorkspaceSwitcher identity={identity}/><div className="sidebar-bottom"><div className="cycle-card"><span>Reporting cycle</span><strong>{snapshots.length} fund periods</strong><p>Tenant-scoped serving data</p></div><button className="sidebar-notifications-button" onClick={() => setDisplaySettingsOpen(true)}>Display preferences</button><div className="profile"><span className="avatar" aria-hidden="true">U</span><span><strong>{identity?.subject ?? "Signed-in user"}</strong><small>Enterprise session</small></span></div><button type="button" className="sidebar-notifications-button" aria-haspopup="dialog" onClick={() => setNotificationsOpen(true)}><Icon name="send" size={15}/><span>Notification settings</span></button></div></aside>
    <main className="main-area" id="main-content" tabIndex={-1}><header className="topbar" role="banner"><div className="breadcrumb" aria-label="Breadcrumb"><span>Workspace</span><Icon name="chevron" size={13}/><strong>{nav.find((item) => item.id === activeView)?.label ?? "Overview"}</strong></div><div className="top-actions">{fundPeriodStatus && <FundPeriodStatusChip status={fundPeriodStatus} onOpen={() => openSnapshot(reviewSnapshot!)}/>}<button className="global-search" aria-label="Search workspace or run a command" aria-keyshortcuts="Meta+K Control+K" aria-haspopup="dialog" aria-expanded={searchOpen} onClick={() => setSearchOpen(true)}><Icon name="search" size={16}/><span className="global-search-label">Search or run a command</span><kbd aria-hidden="true">⌘K</kbd></button><button type="button" className="help-button" aria-label="Help and support" aria-haspopup="dialog" onClick={() => setHelpOpen(true)}><Icon name="help" size={16}/><span className="help-button-label">Help</span></button></div></header><div className={`content ${activeView === "research" ? "research-content" : ""}`}>
      {sessionExpired && <div className="lineage-note tone-warning" role="alert" aria-label="Session expired"><Icon name="alert"/><div><strong>{sessionExpiredCopy().title}</strong><span>{sessionExpiredCopy().detail}</span></div><button className="primary-button" onClick={() => window.location.reload()}>Sign in again</button></div>}
      {loading && <PageHeading eyebrow="Workspace" title="Loading trusted data…" description="Fetching entitled documents, snapshots and observations."/>}
      {!loading && !sessionExpired && degradedModules.length > 0 && <div className="lineage-note tone-warning" role="status" aria-label="Workspace degraded"><Icon name="alert"/><div><strong>Some workspace modules are degraded</strong><span>{degradedModules.join(", ")}. Healthy modules remain available; capability failures fail closed for mutating actions.</span></div><button className="text-button" onClick={() => void refreshWorkspace()}>Retry</button><ContactSupportLink className="text-button" view={activeView}/></div>}
      <ViewErrorBoundary key={activeView} view={activeView} label={activeLabel}>
      {!loading && activeView === "overview" && <><DashboardDepthSections summary={summary} observations={observations} canAdmin={canAdmin} onOpenSnapshotId={openSnapshotById} onOpenPositionFinancials={viewPositionFinancials} onSummaryChanged={() => void refreshSummary()}/><div id="customer-overview"><OverviewView snapshots={snapshots} summary={summary} summaryError={canReadObservations ? moduleErrors.summary : undefined} onRetrySummary={() => void refreshSummary()} onOpenAttention={openAttention} onOpenSnapshotId={openSnapshotById} onSummaryChanged={() => void refreshSummary()} activity={identity?.workspaceId !== "demo-secondary" ? demoFixtures.recentActivity : []} onNavigate={navigate} onUpload={() => setUploadOpen(true)} onSnapshotSelect={openSnapshot} canUpload={canUpload} canReadDocuments={canReadDocuments} canReadObservations={canReadObservations} canResearch={canResearch} canReview={canReview} canAdmin={canAdmin}/></div></>}
      {!loading && activeView === "analytics" && canReadObservations && <AnalyticsView canReadSources={canReadSources} onOpenDocument={canReadDocuments ? openDocumentById : undefined} focusRequest={analyticsFocus} canExport={canExport}/>}
      {!loading && activeView === "documents" && canReadDocuments && (moduleErrors.documents ? scopedUnavailable("Documents are temporarily unavailable", moduleErrors.documents) : <DocumentsView docs={docs} onUpload={() => setUploadOpen(true)} onSelect={setSelectedDoc} canUpload={canUpload} canManageSources={canAdmin}/>)}
      {!loading && activeView === "review" && canReadObservations && (moduleErrors.observations || moduleErrors.snapshots ? scopedUnavailable("Data review is temporarily unavailable", moduleErrors.observations || moduleErrors.snapshots || "Required review state is unavailable") : <ReviewView observations={observations} snapshot={reviewSnapshot} canReview={canReview} canPublish={canPublish} canReadSources={canReadSources} canExport={canExport} focusRequest={reviewFocus} snapshots={snapshots} onSelectSnapshot={setSelectedSnapshotId} canResearch={canResearch} onExplainException={explainException} onOpenDocument={canReadDocuments && canReadSources ? openDocumentById : undefined} onViewPositionFinancials={viewPositionFinancials} onObservationUpdated={(updated) => setObservations((current) => current.map((row) => row.id === updated.id ? updated : row))} onPublished={(published) => { setSelectedSnapshotId(published.id); setSnapshots((current) => current.map((snapshot) => snapshot.id === published.id ? published : snapshot)); void refreshWorkspace(); }}/>)}
      {!loading && activeView === "delivery" && canExport && <DeliveryView publishedSnapshots={publishedSnapshots} canViewAllSchedules={canAdmin && identity?.tenantAdmin === true}/>}
      {!loading && activeView === "research" && canResearch && <ResearchView draftRequest={researchDraft} onOpenDocument={canReadDocuments && canReadSources ? openDocumentById : undefined} suggestions={demoFixtures.researchSuggestions} canReadSources={canReadSources} onOpenReviewObservation={canReadObservations ? openReviewObservation : undefined}/>}
      {!loading && activeView === "issues" && canReadObservations && <DataIssuesView canViewAll={canAdmin && identity?.tenantAdmin === true} onChanged={dataIssues.refresh}/>}
      {!loading && activeView === "access" && canAdmin && identity?.tenantAdmin === true && <AccessAdminView/>}
      </ViewErrorBoundary>
    </div><div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</div></main>
    {workspaceOpen && <Modal label="Workspace and access" onClose={() => setWorkspaceOpen(false)} width="min(460px, 100%)"><div className="dialog-body"><h2>Workspace and access</h2><button type="button" className="secondary-button" onClick={() => { setWorkspaceOpen(false); setDisplaySettingsOpen(true); }}>Display preferences</button><WorkspaceSwitcher identity={identity} variant="panel"/><button type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => { setWorkspaceOpen(false); setNotificationsOpen(true); }}>Notification settings</button><button type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => { setWorkspaceOpen(false); setHelpOpen(true); }}>Help and support</button><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setWorkspaceOpen(false)}>Close</button></div></div></Modal>}
    {searchOpen && <Modal label="Workspace command palette" onClose={closeSearch} align="top" width="min(680px, 100%)"><label className="search-palette-input"><Icon name="search" size={18}/><input autoFocus role="combobox" aria-expanded={paletteResults.length > 0} aria-controls="global-search-results" aria-autocomplete="list" aria-activedescendant={paletteResults.length ? `search-result-${activeResultIndex}` : undefined} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setActiveResult(0); }} onKeyDown={onSearchKeyDown} placeholder="Search or run a command" aria-label="Search workspace or run a command"/><kbd>Esc</kbd></label><div className="search-palette-results">{searchQuery.trim() && paletteResults.length === 0 && <p role="status" className="search-palette-empty">No commands or entitled workspace data match “{searchQuery}”.</p>}{paletteResults.length > 0 && <div id="global-search-results" role="listbox" aria-label="Commands and search results">{paletteResults.map((result, index) => <div key={result.key} id={`search-result-${index}`} role="option" aria-selected={index === activeResultIndex} className="search-result" onMouseDown={(event) => event.preventDefault()} onMouseMove={() => { if (index !== activeResultIndex) setActiveResult(index); }} onClick={() => choosePaletteResult(result)}><span><strong>{result.title}</strong><small>{result.detail}</small></span><span className="search-kind">{result.kind === "command" ? result.category : result.kind}</span></div>)}</div>}</div><div className="search-palette-footer" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Run/open</span><span><kbd>Esc</kbd> Close</span></div></Modal>}
    {helpOpen && <HelpDialog view={activeView} onClose={() => setHelpOpen(false)}/>}
    {displaySettingsOpen && <DisplaySettings onClose={() => setDisplaySettingsOpen(false)}/>}
    {notificationsOpen && <NotificationSettingsDialog onClose={() => setNotificationsOpen(false)}/>}
    {uploadOpen && canUpload && <UploadModal onClose={() => { setUploadOpen(false); navigate("documents"); }} onCompleted={(record) => { setDocs((prev) => [record, ...prev.filter((item) => item.id !== record.id)]); void refreshWorkspace(); }}/>}
    {selectedDoc && <DocumentDrawer key={`${selectedDoc.id}:${sourceLocation?.sourceReferenceId ?? ""}`} sourceLocation={sourceLocation} doc={selectedDoc} onClose={() => setSelectedDoc(null)} canOpenTrustedData={canReadObservations} onReview={() => { const match = snapshots.find((snapshot) => snapshot.fund === selectedDoc.fund && snapshot.period === selectedDoc.period); if (match?.id) setSelectedSnapshotId(match.id); setSelectedDoc(null); navigate("review"); }}/>}
  </div>;
}
