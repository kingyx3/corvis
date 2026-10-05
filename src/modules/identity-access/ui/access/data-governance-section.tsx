"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  DELETION_REQUEST_STATUS_LABEL,
  deletionStatusSummary,
  type DeletionRequestView,
  type RetentionView,
} from "@/modules/governance/domain/data-retention";
import {
  TENANT_EXPORT_MAX_TEXT_LENGTH,
  TENANT_EXPORT_MIN_REASON_LENGTH,
  TENANT_EXPORT_STATUS_LABEL,
  tenantExportStatusSummary,
  type TenantExportBuildPhase,
  type TenantExportPage,
  type TenantExportRequest,
} from "@/modules/delivery/domain/tenant-export";
import { Icon } from "@/shared/ui/icon";
import { StatusPill } from "@/shared/ui/status-pill";
import {
  dataGovernanceErrorMessage,
  decideDataExport,
  decideDeletion,
  getDataExport,
  getRetention,
  listDataExports,
  prepareDataExportDownload,
  requestDataExport,
  requestDeletion,
} from "@/modules/identity-access/ui/access/data-governance-api";
import { apiUrl } from "@/shared/lib/api-url";
import { displayDate } from "@/shared/lib/display-format";
import { formatBytes } from "@/shared/lib/format";

type Load<T> = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: T };

function time(value: string): string { return displayDate(value, { timeStyle: "short" }); }
function day(value: string): string { return displayDate(value); }

/**
 * Data governance for Organization Admins (F10, #266): what the organization's data retention is, and a complete export
 * of its data. Both sit on the access self-service page, which is already the Organization Admin's surface. Each section
 * loads on its own, so one failing never hides the other.
 */
export function DataGovernanceSections() {
  return <>
    <RetentionSection />
    <DataExportSection />
  </>;
}

function RetentionSection() {
  const [state, setState] = useState<Load<RetentionView>>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void getRetention(controller.signal)
      .then((value) => setState({ kind: "ready", value }))
      .catch(() => { if (!controller.signal.aborted) setState({ kind: "error" }); });
    return () => controller.abort();
  }, [reloadKey]);
  const view = state.kind === "ready" ? state.value : null;
  return <section className="panel" aria-labelledby="retention-heading">
    <div className="panel-heading"><div><p className="eyebrow">Records obligations</p><h2 id="retention-heading">Data retention and legal holds</h2></div></div>
    <p className="lede">How long Corvis keeps each class of your organization&apos;s data, and any legal hold that stops it being deleted. Retention periods and legal holds are read-only: Corvis operations set and lift both. Contact Corvis support to ask about a period or a hold. Below them are the deletion requests that affect your organization, and you can ask for a deletion yourself.</p>
    {state.kind === "loading" && <p className="empty-cell" role="status">Loading retention settings…</p>}
    {state.kind === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Retention settings are unavailable</strong><span>Nothing was changed. <button type="button" className="text-button" onClick={() => { setState({ kind: "loading" }); setReloadKey((key) => key + 1); }}>Try again</button></span></div></div>}
    {view && <>
      {view.policies.length === 0
        ? <p className="empty-cell">No retention policy has been recorded for your organization yet. Corvis does not delete a class of data until a policy covers it.</p>
        : <div className="table-card" tabIndex={0} role="region" aria-label="Retention periods"><table className="data-table">
          <thead><tr><th>Data</th><th>Kept for</th><th>When the contract ends</th><th>Legal hold</th><th>Policy</th></tr></thead>
          <tbody>{view.policies.map((policy) => <tr key={policy.dataClass}>
            <td><strong>{policy.label}</strong></td>
            <td>{policy.retentionLabel}</td>
            <td>{policy.deleteOnTermination ? "Deleted" : "Kept for the period above"}</td>
            <td>{policy.legalHold ? <StatusPill status="On hold"/> : <span className="table-muted">None</span>}</td>
            <td><span className="table-secondary">Version {policy.policyVersion}{policy.inEffect ? ` · since ${day(policy.effectiveFrom)}` : ` · takes effect ${day(policy.effectiveFrom)}`}</span></td>
          </tr>)}</tbody></table></div>}
      <h3 className="retention-holds-heading">Legal holds</h3>
      {view.legalHolds.length === 0
        ? <p className="empty-cell">No legal holds apply to your organization. Data past its retention period can be deleted when you ask.</p>
        : <div className="table-card" tabIndex={0} role="region" aria-label="Legal holds"><table className="data-table">
          <thead><tr><th>Matter</th><th>Covers</th><th>Placed</th></tr></thead>
          <tbody>{view.legalHolds.map((hold) => <tr key={hold.holdId}>
            <td><strong>{hold.matterReference}</strong></td>
            <td>{hold.scopeLabel}</td>
            <td>{day(hold.placedAt)}</td>
          </tr>)}</tbody></table></div>}
      <div className="lineage-note" role="note"><Icon name="shield"/><div><strong>A legal hold overrides retention</strong><span>While a hold applies, the data it covers is not deleted, even after its retention period ends or the contract ends.</span></div></div>
      <DeletionRequests view={view} onChanged={() => setReloadKey((key) => key + 1)} />
    </>}
  </section>;
}

/**
 * Deletion requests (F10e, #325), in the retention section: the requests that affect the organization (the ones Corvis
 * operations made show what they cover, where they stand and their dates, nothing else), and an Organization Admin's own
 * request for deletion. Like a full export, it needs a different Organization Admin to approve it, and a legal hold on the
 * data stops it. Approving hands it to Corvis operations; nothing is deleted by approving.
 */
function DeletionRequests({ view, onChanged }: { view: RetentionView; onChanged: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<{ requestId: string; kind: "approve" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const reasonId = useId();
  const hintId = useId();
  const noteId = useId();

  const choices = view.policies.filter((policy) => policy.inEffect);
  const onHold = (dataClass: string) => view.legalHolds.some((hold) => hold.dataClass === null || hold.dataClass === dataClass)
    || view.policies.some((policy) => policy.dataClass === dataClass && policy.legalHold);
  const items = view.deletionRequests;
  const pending = items.find((item) => item.status === "pending_approval");
  const trimmed = reason.trim();
  const valid = selected.length > 0 && trimmed.length >= TENANT_EXPORT_MIN_REASON_LENGTH && trimmed.length <= TENANT_EXPORT_MAX_TEXT_LENGTH;

  const run = async (key: string, action: () => Promise<string>, failure: string) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: "success", text: await action() });
    } catch (reasonForFailure) {
      setMessage({ tone: "error", text: dataGovernanceErrorMessage(reasonForFailure, failure) });
    } finally { setBusy(null); onChanged(); }
  };

  const submit = () => run("request", async () => {
    await requestDeletion(selected, trimmed);
    setSelected([]);
    setReason("");
    return "Deletion requested. A different Organization Admin must approve it before Corvis acts on it.";
  }, "The deletion could not be requested. Try again.");

  const decide = (item: DeletionRequestView, action: "approve" | "reject") => run(`${action}:${item.requestId}`, async () => {
    await decideDeletion(item.requestId, action, { expectedStatus: "pending_approval", ...(action === "reject" ? { note: note.trim() } : {}) });
    setConfirming(null);
    setNote("");
    return action === "approve" ? "Approved. Corvis operations will carry out the deletion." : "Rejected. Nothing will be deleted.";
  }, "This request could not be updated. Try again.");

  const withdraw = (item: DeletionRequestView) => run(`cancel:${item.requestId}`, async () => {
    await decideDeletion(item.requestId, "cancel");
    return "Request withdrawn.";
  }, "This request could not be withdrawn. Try again.");

  return <div className="deletion-requests" data-testid="deletion-requests">
    <h3 className="retention-holds-heading" id="deletion-heading">Deletion requests</h3>
    <p className="lede">Asking for data to be deleted needs two Organization Admins: one asks, a different one approves, and every step is audited. Corvis operations then carry it out. A legal hold on the data stops it.</p>
    <form className="data-export-request" aria-labelledby="deletion-heading" onSubmit={(event) => { event.preventDefault(); if (valid && !pending && busy === null) void submit(); }}>
      <fieldset className="form-field" disabled={busy !== null || Boolean(pending)}>
        <legend>What should be deleted?</legend>
        {choices.length === 0 && <p className="table-muted">No retention policy is recorded yet, so there is nothing to ask for.</p>}
        {choices.map((policy) => {
          const held = onHold(policy.dataClass);
          return <label key={policy.dataClass} className="check-field">
            <input type="checkbox" checked={selected.includes(policy.dataClass)} disabled={held}
              onChange={(event) => setSelected((current) => event.target.checked ? [...current, policy.dataClass] : current.filter((item) => item !== policy.dataClass))} />
            <span>{policy.label}{held ? " (under a legal hold, so it cannot be deleted)" : ""}</span>
          </label>;
        })}
      </fieldset>
      <label className="form-field" htmlFor={reasonId}><span>Why do you need this deletion?</span>
        <textarea id={reasonId} className="input-control" rows={3} maxLength={TENANT_EXPORT_MAX_TEXT_LENGTH} required value={reason} disabled={busy !== null || Boolean(pending)} aria-describedby={hintId}
          onChange={(event) => setReason(event.target.value)} placeholder="e.g. The contract has ended and we no longer need the data held" />
      </label>
      <p id={hintId} className="table-muted">{pending ? "Another deletion request is waiting for approval. Finish or withdraw it before starting a new one." : "Shown to the Organization Admin who approves it and kept in the audit trail. Whole kinds of data only; ask Corvis support to delete specific documents."}</p>
      <button type="submit" className="primary-button" disabled={!valid || Boolean(pending) || busy !== null}>{busy === "request" ? "Requesting…" : "Request deletion"}</button>
    </form>
    <div className="data-issues-status" role="status" aria-live="polite">{message?.tone === "success" ? message.text : ""}</div>
    {message?.tone === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Something went wrong</strong><span>{message.text}</span></div></div>}
    {items.length === 0
      ? <p className="empty-cell">No deletion request affects your organization yet.</p>
      : <ul className="data-issues-list" aria-label="Deletion requests">
        {items.map((item) => {
          const headingId = `deletion-request-${item.requestId}`;
          const confirmingThis = confirming?.requestId === item.requestId ? confirming.kind : null;
          const who = item.origin === "corvis" ? "by Corvis operations" : item.requestedByMe ? "by you" : `by ${item.requestedBy}`;
          return <li key={item.requestId} className="data-issue-card" data-status={item.status} data-origin={item.origin} aria-labelledby={headingId}>
            <div className="data-issue-head">
              <div><h4 id={headingId}>{item.scopeLabel}</h4><span className="table-secondary">Requested {time(item.requestedAt)} {who}{item.status === "pending_approval" && item.approvalExpiresAt ? ` · approval open until ${time(item.approvalExpiresAt)}` : ""}</span></div>
              <div className="data-issue-pills"><StatusPill status={DELETION_REQUEST_STATUS_LABEL[item.status]}/>{item.legalHoldBlocks && <StatusPill status="On hold"/>}</div>
            </div>
            {item.reason && <p className="data-issue-comment">{item.reason}</p>}
            <p className="data-issue-summary">{deletionStatusSummary(item)}</p>
            <p className="table-secondary">Requested {day(item.requestedAt)}{item.decidedAt ? ` · ${item.status === "rejected" ? "rejected" : "approved"} ${day(item.decidedAt)}` : ""}{item.executedAt ? ` · deleted ${day(item.executedAt)}` : ""}</p>
            {confirmingThis === "approve" && <div className="lineage-note tone-warning" role="group" aria-label="Confirm approval"><Icon name="shield"/><div><strong>Approve this deletion?</strong><span>Corvis operations will permanently delete {item.scopeLabel.toLowerCase()} once you approve. Deletion cannot be undone, and a legal hold on the data stops it.</span></div></div>}
            {confirmingThis === "reject" && <div className="form-field" role="group" aria-label="Confirm rejection">
              <label htmlFor={noteId}><span>Why are you rejecting it?</span></label>
              <textarea id={noteId} className="input-control" rows={2} maxLength={TENANT_EXPORT_MAX_TEXT_LENGTH} value={note} onChange={(event) => setNote(event.target.value)} />
            </div>}
            <div className="data-issue-actions">
              {item.actions.canApprove && confirmingThis === null && <button type="button" className="primary-button button-small" disabled={busy !== null} onClick={() => { setConfirming({ requestId: item.requestId, kind: "approve" }); setNote(""); }}>Approve deletion</button>}
              {item.actions.canReject && confirmingThis === null && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setConfirming({ requestId: item.requestId, kind: "reject" }); setNote(""); }}>Reject deletion</button>}
              {confirmingThis === "approve" && <button type="button" className="primary-button button-small" disabled={busy !== null} onClick={() => void decide(item, "approve")}>{busy === `approve:${item.requestId}` ? "Approving…" : "Confirm deletion approval"}</button>}
              {confirmingThis === "reject" && <button type="button" className="primary-button button-small" disabled={busy !== null || note.trim().length === 0} onClick={() => void decide(item, "reject")}>{busy === `reject:${item.requestId}` ? "Rejecting…" : "Confirm deletion rejection"}</button>}
              {confirmingThis !== null && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setConfirming(null); setNote(""); }}>Back</button>}
              {item.actions.canCancel && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => void withdraw(item)}>{busy === `cancel:${item.requestId}` ? "Withdrawing…" : "Withdraw deletion request"}</button>}
            </div>
          </li>;
        })}
      </ul>}
  </div>;
}

/** Requests shown per page. Requests are rare (one is open at a time), so most organizations never see a second page. */
export const DATA_EXPORT_PAGE_SIZE = 10;
/** Tells the approval notice at the top of the page that a request changed, so it never contradicts the list below. */
export const DATA_EXPORT_CHANGED_EVENT = "corvis:data-export-changed";

/**
 * The in-app signal for F10d: a request from a colleague is waiting for this Organization Admin's approval. It sits at the
 * top of the access self-service page (no new navigation item) and links to the request. It is the same information the
 * approval email carries, and works whether or not email is switched on. The open request is always the newest, so the
 * first page is enough to find it.
 */
export function DataExportApprovalNotice() {
  const [waiting, setWaiting] = useState(0);
  const latest = useRef(0);
  const refresh = useCallback((signal?: AbortSignal) => {
    const current = ++latest.current;
    void listDataExports({ limit: DATA_EXPORT_PAGE_SIZE, signal })
      // Silent on failure: the export section below reports its own load failure, and a notice that cannot be confirmed is not shown.
      .then((page) => { if (current === latest.current) setWaiting(page.items.filter((item) => item.actions.canApprove).length); })
      .catch(() => { if (current === latest.current) setWaiting(0); });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    const onChanged = () => refresh();
    window.addEventListener(DATA_EXPORT_CHANGED_EVENT, onChanged);
    return () => { controller.abort(); window.removeEventListener(DATA_EXPORT_CHANGED_EVENT, onChanged); };
  }, [refresh]);
  if (waiting === 0) return null;
  return <div className="lineage-note tone-warning" role="status" data-testid="export-approval-notice"><Icon name="shield"/><div>
    <strong>A data export is awaiting your approval</strong>
    <span>A colleague asked for a full export of your organization&apos;s data. It is only built if a different Organization Admin approves it. <a className="text-button" href="#export-heading">Review the request</a></span>
  </div></div>;
}

function DataExportSection() {
  const [state, setState] = useState<Load<TenantExportPage>>({ kind: "loading" });
  // Older pages the admin has opened. They hang off the first page's cursor, so they are dropped if a newer request moves that cursor.
  const [older, setOlder] = useState<TenantExportPage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const firstCursor = useRef<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<{ requestId: string; kind: "approve" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const reasonId = useId();
  const hintId = useId();
  const noteId = useId();
  const latest = useRef(0);

  const applyFirstPage = useCallback((page: TenantExportPage) => {
    setState({ kind: "ready", value: page });
    // Opened older pages stay while the first page still ends where it did; a newer request moves its end, and they would then skip a request.
    setOlder((current) => (current && firstCursor.current === page.nextCursor ? current : null));
    firstCursor.current = page.nextCursor;
  }, []);

  const refresh = useCallback(async (silent = false) => {
    const current = ++latest.current;
    try {
      const page = await listDataExports({ limit: DATA_EXPORT_PAGE_SIZE });
      if (current === latest.current) applyFirstPage(page);
    } catch {
      if (current === latest.current && !silent) setState({ kind: "error" });
    }
  }, [applyFirstPage]);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++latest.current;
    void listDataExports({ limit: DATA_EXPORT_PAGE_SIZE, signal: controller.signal })
      .then((page) => { if (current === latest.current) applyFirstPage(page); })
      .catch(() => { if (current === latest.current && !controller.signal.aborted) setState({ kind: "error" }); });
    return () => controller.abort();
  }, [reloadKey, applyFirstPage]);

  const showOlder = async () => {
    const cursor = older ? older.nextCursor : state.kind === "ready" ? state.value.nextCursor : null;
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      const page = await listDataExports({ limit: DATA_EXPORT_PAGE_SIZE, cursor });
      setOlder((current) => ({ items: [...(current?.items ?? []), ...page.items], nextCursor: page.nextCursor }));
    } catch (failure) {
      setMessage({ tone: "error", text: dataGovernanceErrorMessage(failure, "Older requests could not be loaded. Try again.") });
    } finally { setLoadingOlder(false); }
  };

  // An approved request is built by the delivery worker (a large export takes longer, and shows its progress): keep the list current until it settles.
  const items = state.kind === "ready" ? [...state.value.items, ...(older?.items ?? [])] : [];
  const moreCursor = state.kind === "ready" ? (older ? older.nextCursor : state.value.nextCursor) : null;
  const building = items.some((item) => item.status === "approved" || item.status === "building");
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refresh(true), 3000);
    return () => clearInterval(timer);
  }, [building, refresh]);

  const open = items.find((item) => item.status === "pending_approval" || item.status === "approved" || item.status === "building");
  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= TENANT_EXPORT_MIN_REASON_LENGTH && trimmed.length <= TENANT_EXPORT_MAX_TEXT_LENGTH;

  const run = async (key: string, action: () => Promise<string>, failure: string) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: "success", text: await action() });
      await refresh();
    } catch (reasonForFailure) {
      setMessage({ tone: "error", text: dataGovernanceErrorMessage(reasonForFailure, failure) });
      await refresh(true);
    } finally { setBusy(null); window.dispatchEvent(new Event(DATA_EXPORT_CHANGED_EVENT)); }
  };

  const submit = () => run("request", async () => {
    await requestDataExport(trimmed);
    setReason("");
    return "Export requested. A different Organization Admin must approve it before anything is built.";
  }, "The export could not be requested. Try again.");

  const decide = (item: TenantExportRequest, action: "approve" | "reject") => run(`${action}:${item.requestId}`, async () => {
    await decideDataExport(item.requestId, action, { expectedStatus: "pending_approval", ...(action === "reject" ? { note: note.trim() } : {}) });
    setConfirming(null);
    setNote("");
    return action === "approve" ? "Approved. The export is being prepared." : "Rejected. Nothing was built.";
  }, "This request could not be updated. Try again.");

  const withdraw = (item: TenantExportRequest) => run(`cancel:${item.requestId}`, async () => {
    await decideDataExport(item.requestId, "cancel");
    return "Request withdrawn.";
  }, "This request could not be withdrawn. Try again.");

  const download = async (item: TenantExportRequest) => {
    setBusy(`download:${item.requestId}`);
    setMessage(null);
    try {
      const link = await prepareDataExportDownload(item.requestId);
      window.location.assign(apiUrl(link.downloadUrl));
      setMessage({ tone: "success", text: `Download started. The link works once and expires at ${time(link.downloadExpiresAt)}; request a new link whenever you need one.` });
    } catch (failure) {
      setMessage({ tone: "error", text: dataGovernanceErrorMessage(failure, "The download could not be prepared. Try again.") });
      await refresh(true);
    } finally { setBusy(null); }
  };

  return <section className="panel" aria-labelledby="export-heading">
    <div className="panel-heading"><div><p className="eyebrow">Leave cleanly</p><h2 id="export-heading">Full data export</h2></div><span className="table-muted">{open ? "One request is open" : "No open request"}</span></div>
    <p className="lede">Request a complete copy of your organization&apos;s data. A second Organization Admin must approve it before anything is built, every step is audited, and the result is a checksummed archive behind a short-lived download link.</p>
    <ul className="data-export-contents" aria-label="What a full export contains">
      <li><strong>Published data</strong>: approved observations in your published snapshots.</li>
      <li><strong>Access audit trail</strong>: invitations, member changes, support access, source connections, data issues and exports.</li>
      <li><strong>Source documents</strong>: an inventory of each document with its size and SHA-256, and the document files themselves where your contracts grant you source-file access. A large data set is split into numbered files, and every file is listed with its checksum.</li>
      <li><strong>Only what you may redistribute</strong>: data your contracts do not let you redistribute is left out, and the manifest says how many funds, documents and source files that was.</li>
    </ul>
    <form className="data-export-request" onSubmit={(event) => { event.preventDefault(); if (reasonValid && !open && busy === null) void submit(); }}>
      <label className="form-field" htmlFor={reasonId}><span>Why do you need this export?</span>
        <textarea id={reasonId} className="input-control" rows={3} maxLength={TENANT_EXPORT_MAX_TEXT_LENGTH} required value={reason} disabled={busy !== null || Boolean(open)} aria-describedby={hintId}
          onChange={(event) => setReason(event.target.value)} placeholder="e.g. Records review at contract end" />
      </label>
      <p id={hintId} className="table-muted">{open ? "Another request is open. Finish or withdraw it before starting a new one." : "Shown to the Organization Admin who approves it and kept in the audit trail."}</p>
      <button type="submit" className="primary-button" disabled={!reasonValid || Boolean(open) || busy !== null}>{busy === "request" ? "Requesting…" : "Request full export"}</button>
    </form>
    <div className="data-issues-status" role="status" aria-live="polite">{message?.tone === "success" ? message.text : ""}</div>
    {message?.tone === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Something went wrong</strong><span>{message.text}</span></div></div>}
    {state.kind === "loading" && <p className="empty-cell" role="status">Loading export requests…</p>}
    {state.kind === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Export requests are unavailable</strong><span>Nothing was changed. <button type="button" className="text-button" onClick={() => { setState({ kind: "loading" }); setReloadKey((key) => key + 1); }}>Try again</button></span></div></div>}
    {state.kind === "ready" && items.length === 0 && <p className="empty-cell">No export has been requested yet.</p>}
    {items.length > 0 && <ul className="data-issues-list" aria-label="Data export requests">
      {items.map((item) => {
        const headingId = `data-export-${item.requestId}`;
        const confirmingThis = confirming?.requestId === item.requestId ? confirming.kind : null;
        return <li key={item.requestId} className="data-issue-card" data-status={item.status} aria-labelledby={headingId}>
          <div className="data-issue-head">
            <div><h3 id={headingId}>Requested {time(item.requestedAt)}</h3><span className="table-secondary">{item.requestedByMe ? "by you" : `by ${item.requestedBy}`}{item.status === "pending_approval" ? ` · approval open until ${time(item.approvalExpiresAt)}` : ""}</span></div>
            <div className="data-issue-pills"><StatusPill status={TENANT_EXPORT_STATUS_LABEL[item.status]}/></div>
          </div>
          <p className="data-issue-comment">{item.reason}</p>
          <p className="data-issue-summary">{tenantExportStatusSummary(item)}</p>
          {item.status === "building" && <ExportProgress item={item}/>}
          {item.artifact && <p className="data-issue-replacement">Archive {formatBytes(item.artifact.sizeBytes)} · SHA-256 <code>{item.artifact.checksumSha256}</code> · available until {time(item.artifact.expiresAt)}</p>}
          {confirmingThis === "approve" && <div className="lineage-note tone-warning" role="group" aria-label="Confirm approval"><Icon name="shield"/><div><strong>Approve this export?</strong><span>Corvis will build and deliver a complete copy of your organization&apos;s data (what your contracts allow) and a download link will be available to Organization Admins. You are recorded as the approver.</span></div></div>}
          {confirmingThis === "reject" && <div className="form-field" role="group" aria-label="Confirm rejection">
            <label htmlFor={noteId}><span>Why are you rejecting it?</span></label>
            <textarea id={noteId} className="input-control" rows={2} maxLength={TENANT_EXPORT_MAX_TEXT_LENGTH} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>}
          <div className="data-issue-actions">
            {item.actions.canApprove && confirmingThis === null && <button type="button" className="primary-button button-small" disabled={busy !== null} onClick={() => { setConfirming({ requestId: item.requestId, kind: "approve" }); setNote(""); }}>Approve export</button>}
            {item.actions.canReject && confirmingThis === null && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setConfirming({ requestId: item.requestId, kind: "reject" }); setNote(""); }}>Reject</button>}
            {confirmingThis === "approve" && <button type="button" className="primary-button button-small" disabled={busy !== null} onClick={() => void decide(item, "approve")}>{busy === `approve:${item.requestId}` ? "Approving…" : "Confirm approval"}</button>}
            {confirmingThis === "reject" && <button type="button" className="primary-button button-small" disabled={busy !== null || note.trim().length === 0} onClick={() => void decide(item, "reject")}>{busy === `reject:${item.requestId}` ? "Rejecting…" : "Confirm rejection"}</button>}
            {confirmingThis !== null && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setConfirming(null); setNote(""); }}>Back</button>}
            {item.actions.canCancel && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => void withdraw(item)}>{busy === `cancel:${item.requestId}` ? "Withdrawing…" : "Withdraw request"}</button>}
            {item.actions.canDownload && <button type="button" className="primary-button button-small" disabled={busy !== null} onClick={() => void download(item)}>{busy === `download:${item.requestId}` ? "Preparing…" : "Download export"}</button>}
            {item.artifact && <details><summary>Contents and checksums</summary><ExportManifest item={item}/></details>}
            <ExportHistory item={item}/>
          </div>
        </li>;
      })}
    </ul>}
    {moreCursor && <button type="button" className="secondary-button" disabled={loadingOlder} onClick={() => void showOlder()}>{loadingOlder ? "Loading older requests…" : "Show older requests"}</button>}
  </section>;
}

const PHASE_LABEL: Record<TenantExportBuildPhase, string> = {
  estimating: "Estimating the size of the export",
  data: "Writing the data files",
  documents: "Copying source documents",
  finalizing: "Finishing the archive",
};

/** The size estimate and progress of a running build, as the worker last reported them. */
function ExportProgress({ item }: { item: TenantExportRequest }) {
  const progress = item.progress;
  if (!progress) return <p className="table-secondary">Preparing the export. Its size estimate appears here shortly.</p>;
  const number = (value: number) => value.toLocaleString("en-US");
  return <div className="data-export-progress" data-testid="export-progress">
    <progress max={100} value={progress.percent} aria-label={`Export build progress, ${progress.percent}%`}/>
    <p className="data-issue-summary"><strong>{PHASE_LABEL[progress.phase]}.</strong> {progress.percent}% of an estimated {formatBytes(progress.estimatedBytes)}.</p>
    <p className="table-secondary">{number(progress.rowsWritten)} of about {number(progress.estimatedRows)} data rows · {number(progress.documentsWritten)} of {number(progress.estimatedDocuments)} source files · updated {time(progress.updatedAt)}</p>
  </div>;
}

function ExportManifest({ item }: { item: TenantExportRequest }) {
  const manifest = item.artifact!.manifest;
  return <div className="data-export-manifest">
    <p className="table-secondary">Generated {time(manifest.generatedAt)} · requested by {manifest.requestedBy} · approved by {manifest.approvedBy}</p>
    <div className="table-card" tabIndex={0} role="region" aria-label={`Files in the export requested ${time(item.requestedAt)}`}><table className="data-table">
      <thead><tr><th>File</th><th>Rows</th><th>Size</th><th>SHA-256</th></tr></thead>
      <tbody>{manifest.files.map((file) => <tr key={file.path}><td><strong>{file.path}</strong><span className="table-secondary">{file.description}</span></td><td>{file.rowCount}</td><td>{formatBytes(file.sizeBytes)}</td><td><code>{file.sha256}</code></td></tr>)}</tbody></table></div>
    {manifest.sourceFiles && <p className="table-secondary">{manifest.sourceFiles.included} source document file{manifest.sourceFiles.included === 1 ? "" : "s"} ({formatBytes(manifest.sourceFiles.totalBytes)}) {manifest.sourceFiles.included === 1 ? "is" : "are"} in the archive, each listed with its size and SHA-256 in <code>manifest.json</code> inside it{manifest.fileCount ? `; the archive holds ${manifest.fileCount} files in all` : ""}.</p>}
    <p>Funds: {manifest.dataRights.funds.included} included, {manifest.dataRights.funds.excluded} left out. Documents: {manifest.dataRights.documents.included} included, {manifest.dataRights.documents.excluded} left out{manifest.sourceFiles ? `. Source files: ${manifest.sourceFiles.included} included, ${manifest.sourceFiles.excluded} left out` : ""}.</p>
    <p className="table-secondary">{manifest.dataRights.basis}</p>
    {manifest.notIncluded.length > 0 && <ul>{manifest.notIncluded.map((entry) => <li key={entry.item}><strong>Not included: {entry.item}.</strong> {entry.reason}</li>)}</ul>}
  </div>;
}

function ExportHistory({ item }: { item: TenantExportRequest }) {
  const [history, setHistory] = useState<TenantExportRequest["history"]>(item.history);
  const [failed, setFailed] = useState(false);
  return <details onToggle={(event) => {
    if (!event.currentTarget.open || history) return;
    void getDataExport(item.requestId).then((detail) => setHistory(detail.history ?? [])).catch(() => setFailed(true));
  }}>
    <summary>History</summary>
    {history ? <ol className="data-issue-history">{history.map((event, index) => <li key={index}>{event.eventType.replaceAll("_", " ")} by {event.actor} · <time dateTime={event.at}>{time(event.at)}</time>{event.note ? ` — ${event.note}` : ""}</li>)}</ol>
      : <p className="table-muted" role={failed ? "alert" : "status"}>{failed ? "History could not be loaded." : "Loading history…"}</p>}
  </details>;
}
