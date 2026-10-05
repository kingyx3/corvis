"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DATA_ISSUE_FIGURE_LABEL,
  DATA_ISSUE_STATUSES,
  DATA_ISSUE_STATUS_LABEL,
  dataIssueScopeSummary,
  dataIssueStatusSummary,
  isDataIssueStatus,
  type DataIssueCase,
  type DataIssueStatus,
} from "@/modules/governance/domain/data-issue";
import { Icon } from "@/shared/ui/icon";
import { PageHeading } from "@/shared/ui/page-heading";
import { StatusPill } from "@/shared/ui/status-pill";
import {
  acknowledgeDataIssue,
  dataIssueErrorMessage,
  exportDataIssues,
  getDataIssue,
  listDataIssues,
  type DataIssueScopeChoice,
} from "@/modules/governance/ui/data-issues/api";
import { displayDate } from "@/shared/lib/display-format";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: DataIssueCase[]; nextCursor: string | null };

function time(value: string): string { return displayDate(value, { timeStyle: "short" }); }

/**
 * Data issues (F5): the reports a person filed about published figures, each with where it stands. A case that changed
 * status since the person last looked carries an "Updated" badge until they open or acknowledge it; the sidebar shows the
 * count. Organization Admins can switch to every report in the organization. Reports can be exported (CSV or JSON) for
 * the customer's own records. Moving a case along is Data Operations' job in the admin console, not here.
 */
export function DataIssuesView({ canViewAll, onChanged }: { canViewAll: boolean; onChanged?: () => void }) {
  const [scope, setScope] = useState<DataIssueScopeChoice>("mine");
  const [status, setStatus] = useState<DataIssueStatus | "all">("all");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const requestId = useRef(0);

  const effectiveScope: DataIssueScopeChoice = canViewAll ? scope : "mine";

  useEffect(() => {
    const controller = new AbortController();
    const current = ++requestId.current;
    void listDataIssues({ scope: effectiveScope, status: status === "all" ? undefined : status }, controller.signal)
      .then((page) => { if (current === requestId.current) setState({ kind: "ready", items: page.items, nextCursor: page.nextCursor }); })
      .catch(() => { if (current === requestId.current && !controller.signal.aborted) setState({ kind: "error" }); });
    return () => controller.abort();
  }, [effectiveScope, status, reloadKey]);

  const reload = () => { setState({ kind: "loading" }); setReloadKey((key) => key + 1); };

  const loadMore = async () => {
    if (state.kind !== "ready" || !state.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listDataIssues({ scope: effectiveScope, status: status === "all" ? undefined : status, cursor: state.nextCursor });
      setState((current) => current.kind === "ready" ? { kind: "ready", items: [...current.items, ...page.items], nextCursor: page.nextCursor } : current);
    } catch (reason) {
      setMessage({ tone: "error", text: dataIssueErrorMessage(reason, "More reports could not be loaded. Try again.") });
    } finally { setLoadingMore(false); }
  };

  const replaceItem = useCallback((updated: DataIssueCase) => {
    setState((current) => current.kind === "ready" ? { ...current, items: current.items.map((item) => item.caseId === updated.caseId ? { ...item, ...updated, history: updated.history ?? item.history } : item) } : current);
  }, []);

  const acknowledge = async (item: DataIssueCase) => {
    try {
      replaceItem(await acknowledgeDataIssue(item.caseId));
      setMessage({ tone: "success", text: "Marked as seen." });
      onChanged?.();
    } catch (reason) {
      setMessage({ tone: "error", text: dataIssueErrorMessage(reason, "This report could not be marked as seen. Try again.") });
    }
  };

  const download = async (format: "csv" | "json") => {
    setExporting(format);
    setMessage(null);
    try {
      await exportDataIssues(format, effectiveScope);
      setMessage({ tone: "success", text: `Exported ${effectiveScope === "all" ? "every report in your organization" : "your reports"} as ${format.toUpperCase()}.` });
    } catch (reason) {
      setMessage({ tone: "error", text: dataIssueErrorMessage(reason, "The export could not be created. Try again.") });
    } finally { setExporting(null); }
  };

  const items = state.kind === "ready" ? state.items : [];
  return <section className="data-issues" aria-label="Data issues">
    <PageHeading
      eyebrow="Trusted data"
      title="Data issues"
      description="Reports you filed about published figures, and where each one stands. Reporting never changes data: Data Operations investigates, and a correction replaces the figure with a new publication."
      actions={<>
        <button type="button" className="secondary-button" disabled={exporting !== null || state.kind !== "ready"} onClick={() => void download("csv")}><Icon name="download" size={16}/>{exporting === "csv" ? "Exporting…" : "Export CSV"}</button>
        <button type="button" className="secondary-button" disabled={exporting !== null || state.kind !== "ready"} onClick={() => void download("json")}><Icon name="download" size={16}/>{exporting === "json" ? "Exporting…" : "Export JSON"}</button>
      </>}
    />
    <div className="toolbar data-issues-toolbar" aria-label="Data issue filters">
      {canViewAll && <fieldset className="position-financials-segmented"><legend>Whose reports</legend>
        {(["mine", "all"] as const).map((value) => <button type="button" key={value} aria-pressed={scope === value} className={scope === value ? "active" : ""} onClick={() => { setScope(value); setState({ kind: "loading" }); }}>{value === "mine" ? "My reports" : "Everyone in my organization"}</button>)}
      </fieldset>}
      <label className="form-field data-issues-status-filter"><span>Status</span>
        <select className="filter-button" value={status} onChange={(event) => { const next = event.target.value; setStatus(isDataIssueStatus(next) ? next : "all"); setState({ kind: "loading" }); }}>
          <option value="all">All statuses</option>
          {DATA_ISSUE_STATUSES.map((value) => <option key={value} value={value}>{DATA_ISSUE_STATUS_LABEL[value]}</option>)}
        </select>
      </label>
    </div>
    <div className="data-issues-status" role="status" aria-live="polite">{message?.tone === "success" ? message.text : ""}</div>
    {message?.tone === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Something went wrong</strong><span>{message.text}</span></div></div>}
    {canViewAll && <div className="lineage-note" role="note"><Icon name="shield"/><div><strong>Cases are moved by Data Operations</strong><span>Status changes (investigating, corrected, no change) are made in the admin console, where each change is audited. This list is read-only.</span></div></div>}
    {state.kind === "loading" && <div className="table-card" role="status" aria-label="Loading data issues"><div className="empty-cell">Loading your reports…</div></div>}
    {state.kind === "error" && <div className="table-card" role="alert"><div className="empty-cell"><strong>Data issues are unavailable.</strong> Your reports are safe and nothing was changed. <button type="button" className="text-button" onClick={reload}>Try again</button></div></div>}
    {state.kind === "ready" && items.length === 0 && <div className="table-card"><div className="empty-cell">{status === "all" ? "No reports yet. Use “Report an issue” beside a published figure on Overview, Position financials or Data review." : `No ${DATA_ISSUE_STATUS_LABEL[status].toLowerCase()} reports.`}</div></div>}
    {items.length > 0 && <ul className="data-issues-list" aria-label="Data issue reports">
      {items.map((item) => <IssueCard key={item.caseId} item={item} showReporter={effectiveScope === "all"} onAcknowledge={() => void acknowledge(item)} onOpened={async () => {
        try { const detail = await getDataIssue(item.caseId); replaceItem(detail); if (item.hasUnseenUpdate && item.reportedByMe) { replaceItem(await acknowledgeDataIssue(item.caseId)); onChanged?.(); } } catch { /* the card keeps its summary; details can be reopened */ }
      }}/>)}
    </ul>}
    {state.kind === "ready" && state.nextCursor && <div className="data-issues-more"><button type="button" className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button></div>}
  </section>;
}

function IssueCard({ item, showReporter, onAcknowledge, onOpened }: { item: DataIssueCase; showReporter: boolean; onAcknowledge: () => void; onOpened: () => Promise<void> }) {
  const headingId = `data-issue-${item.caseId}`;
  const statusLabel = DATA_ISSUE_STATUS_LABEL[item.status];
  return <li className="data-issue-card" data-status={item.status} data-unseen={item.hasUnseenUpdate ? "true" : "false"} aria-labelledby={headingId}>
    <div className="data-issue-head">
      <div><h3 id={headingId}>{dataIssueScopeSummary(item.scope)}</h3><span className="table-secondary">{DATA_ISSUE_FIGURE_LABEL[item.figure]} · reported <time dateTime={item.createdAt}>{time(item.createdAt)}</time>{showReporter && !item.reportedByMe ? ` by ${item.reportedBy}` : ""}</span></div>
      <div className="data-issue-pills"><StatusPill status={statusLabel}/>{item.hasUnseenUpdate && <StatusPill status="Updated"/>}</div>
    </div>
    <p className="data-issue-comment">{item.comment}</p>
    <p className="data-issue-summary">{dataIssueStatusSummary(item)}</p>
    {item.replacement && <p className="data-issue-replacement">Replacement publication: snapshot <code>{item.replacement.snapshotId}</code>, version {item.replacement.snapshotVersion}.</p>}
    <div className="data-issue-actions">
      {item.hasUnseenUpdate && item.reportedByMe && <button type="button" className="secondary-button" aria-label={`Mark the update on ${dataIssueScopeSummary(item.scope)} as seen`} onClick={onAcknowledge}>Mark as seen</button>}
      <details onToggle={(event) => { if (event.currentTarget.open) void onOpened(); }}>
        <summary>History</summary>
        {item.history ? <ol className="data-issue-history">{item.history.map((event, index) => <li key={index}><StatusPill status={DATA_ISSUE_STATUS_LABEL[event.toStatus]}/> <time dateTime={event.at}>{time(event.at)}</time>{event.note ? ` — ${event.note}` : ""}</li>)}</ol> : <p className="table-secondary">Loading history…</p>}
      </details>
    </div>
  </li>;
}
