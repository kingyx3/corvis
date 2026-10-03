"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  SERVICE_ACCOUNT_CREDENTIAL_STATUS_LABEL,
  SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS,
  SERVICE_ACCOUNT_DEFAULT_OVERLAP_MINUTES,
  SERVICE_ACCOUNT_EXPIRY_WARNING_DAYS,
  SERVICE_ACCOUNT_MAX_LIFETIME_DAYS,
  SERVICE_ACCOUNT_MAX_NAME_LENGTH,
  SERVICE_ACCOUNT_MAX_PURPOSE_LENGTH,
  SERVICE_ACCOUNT_MAX_REASON_LENGTH,
  SERVICE_ACCOUNT_MIN_TEXT_LENGTH,
  SERVICE_ACCOUNT_ROLES,
  SERVICE_ACCOUNT_ROLE_LABEL,
  SERVICE_ACCOUNT_STATUS_LABEL,
  minimumExtensionDays,
  serviceAccountCredentialSummary,
  type IssuedServiceAccountCredential,
  type ServiceAccount,
  type ServiceAccountList,
  type ServiceAccountRole,
} from "@/core/service-account";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";
import { actOnServiceAccount, createServiceAccount, listServiceAccounts, serviceAccountErrorMessage } from "@/features/access/service-accounts-api";
import { copyToClipboard } from "@/lib/clipboard";
import { displayDate } from "@/lib/display-format";

type Load<T> = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: T };
type Panel = { serviceAccountId: string; kind: "rotate" | "issue" | "revoke" | "disable" | "extend" | "transfer" };
type Reveal = { accountName: string; heading: string; credential: IssuedServiceAccountCredential };

const ROLE_GUIDE: Record<ServiceAccountRole, string> = {
  reviewer: "Can review checklists, enter evidence and draft narratives on the data it is entitled to.",
  analyst: "Can analyze the data it is entitled to and prepare working outputs.",
  viewer: "Can view the data it is entitled to. Cannot change anything.",
};
const OVERLAPS: Array<[number, string]> = [[0, "None: the old credential stops now"], [15, "15 minutes"], [60, "1 hour"], [240, "4 hours"], [1440, "24 hours"]];

function time(value: string): string { return displayDate(value, { timeStyle: "short" }); }
function day(value: string): string { return displayDate(value); }
function daysLeft(value: string): number { return Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 86_400_000)); }

/**
 * Service accounts for Organization Admins (F6, #262): non-human identities that call the Corvis API without borrowing a
 * person's login. One workspace and one ordinary role each, under the same entitlements and data rights as people. The
 * credential secret is shown once, when it is issued, and nowhere else.
 */
export function ServiceAccountsSection() {
  const [state, setState] = useState<Load<ServiceAccountList>>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [reason, setReason] = useState("");
  const [overlap, setOverlap] = useState(SERVICE_ACCOUNT_DEFAULT_OVERLAP_MINUTES);
  const [credentialDays, setCredentialDays] = useState(SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS);
  const [extendDays, setExtendDays] = useState(SERVICE_ACCOUNT_MAX_LIFETIME_DAYS);
  const [newOwner, setNewOwner] = useState("");
  // The create form.
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [roleName, setRoleName] = useState<ServiceAccountRole>("analyst");
  const [accountDays, setAccountDays] = useState(SERVICE_ACCOUNT_MAX_LIFETIME_DAYS);
  const [newCredentialDays, setNewCredentialDays] = useState(SERVICE_ACCOUNT_DEFAULT_CREDENTIAL_DAYS);
  const ids = { name: useId(), purpose: useId(), workspace: useId(), role: useId(), roleHint: useId(), account: useId(), credential: useId(), reason: useId(), overlap: useId(), days: useId(), secret: useId(), extend: useId(), extendHint: useId(), owner: useId() };
  const latest = useRef(0);

  const refresh = useCallback(async (silent = false) => {
    const current = ++latest.current;
    try {
      const value = await listServiceAccounts();
      if (current === latest.current) setState({ kind: "ready", value });
    } catch {
      if (current === latest.current && !silent) setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++latest.current;
    void listServiceAccounts(controller.signal)
      .then((value) => { if (current === latest.current) setState({ kind: "ready", value }); })
      .catch(() => { if (current === latest.current && !controller.signal.aborted) setState({ kind: "error" }); });
    return () => controller.abort();
  }, [reloadKey]);

  const list = state.kind === "ready" ? state.value : null;
  const accounts = list?.serviceAccounts ?? [];
  const workspaces = list?.workspaces ?? [];
  const owners = list?.owners ?? [];
  const selectedWorkspace = workspaceId || workspaces[0]?.workspaceId || "";
  const nameOk = name.trim().length >= SERVICE_ACCOUNT_MIN_TEXT_LENGTH && name.trim().length <= SERVICE_ACCOUNT_MAX_NAME_LENGTH;
  const purposeOk = purpose.trim().length >= SERVICE_ACCOUNT_MIN_TEXT_LENGTH && purpose.trim().length <= SERVICE_ACCOUNT_MAX_PURPOSE_LENGTH;
  const reasonOk = reason.trim().length >= SERVICE_ACCOUNT_MIN_TEXT_LENGTH && reason.trim().length <= SERVICE_ACCOUNT_MAX_REASON_LENGTH;
  const createReady = nameOk && purposeOk && selectedWorkspace !== "" && busy === null;

  const closePanel = () => { setPanel(null); setReason(""); };
  const show = (heading: string, accountName: string, credential: IssuedServiceAccountCredential) => { setCopied(null); setReveal({ accountName, heading, credential }); };

  const create = async () => {
    setBusy("create");
    setMessage(null);
    try {
      const created = await createServiceAccount({
        name: name.trim(), purpose: purpose.trim(), workspaceId: selectedWorkspace, roleName,
        expiresInDays: accountDays, credentialExpiresInDays: Math.min(newCredentialDays, accountDays),
      });
      setName("");
      setPurpose("");
      show("Copy the new API credential now", created.serviceAccount.name, created.credential);
      setMessage({ tone: "success", text: `Service account ${created.serviceAccount.name} created.` });
      await refresh();
    } catch (failure) {
      setMessage({ tone: "error", text: serviceAccountErrorMessage(failure, "The service account could not be created. Try again.") });
    } finally { setBusy(null); }
  };

  const act = async (account: ServiceAccount, key: string, command: Parameters<typeof actOnServiceAccount>[1], success: (account: ServiceAccount) => string, failure: string) => {
    setBusy(key);
    setMessage(null);
    try {
      const result = await actOnServiceAccount(account.serviceAccountId, command);
      if (result.credential) show(command.action === "rotate" ? "Copy the rotated API credential now" : "Copy the new API credential now", account.name, result.credential);
      closePanel();
      setMessage({ tone: "success", text: success(result.serviceAccount) });
      await refresh();
    } catch (reasonForFailure) {
      setMessage({ tone: "error", text: serviceAccountErrorMessage(reasonForFailure, failure) });
      await refresh(true);
    } finally { setBusy(null); }
  };

  return <section className="panel" aria-labelledby="service-accounts-heading">
    <div className="panel-heading"><div><p className="eyebrow">Non-human access</p><h2 id="service-accounts-heading">Service accounts</h2></div><span className="table-muted">{list ? `${accounts.filter((account) => account.status === "active").length} active` : ""}</span></div>
    <p className="lede">A service account lets your own systems call Corvis without borrowing a person&apos;s login. It has one role in one workspace and the same entitlements and data rights as a person, it expires, and every change to it is in the access audit trail below.</p>
    <div className="lineage-note tone-warning" role="note"><Icon name="alert"/><div><strong>Credentials are not yet accepted by the API</strong><span>You can create accounts and issue, rotate and revoke credentials here, and everything is recorded. The Corvis API does not yet accept these credentials on requests; that is being enabled separately, and no credential will work until it is.</span></div></div>
    <div className="lineage-note" role="note"><Icon name="shield"/><div><strong>What an account can see</strong><span>Creating an account grants no fund or document access. Corvis operations grant that, as for people, to the account&apos;s identity reference shown on each account.</span></div></div>

    <form className="data-export-request" onSubmit={(event) => { event.preventDefault(); if (createReady) void create(); }}>
      <h3>Create a service account</h3>
      <label className="form-field" htmlFor={ids.name}><span>Name</span>
        <input id={ids.name} className="input-control" required maxLength={SERVICE_ACCOUNT_MAX_NAME_LENGTH} value={name} disabled={busy !== null} onChange={(event) => setName(event.target.value)} placeholder="e.g. Nightly reporting sync" />
      </label>
      <label className="form-field" htmlFor={ids.purpose}><span>What it is for</span>
        <input id={ids.purpose} className="input-control" required maxLength={SERVICE_ACCOUNT_MAX_PURPOSE_LENGTH} value={purpose} disabled={busy !== null} onChange={(event) => setPurpose(event.target.value)} placeholder="e.g. Loads published fund data into our warehouse" />
      </label>
      <label className="form-field" htmlFor={ids.workspace}><span>Workspace</span>
        <select id={ids.workspace} className="filter-button" value={selectedWorkspace} disabled={busy !== null || workspaces.length === 0} onChange={(event) => setWorkspaceId(event.target.value)}>
          {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.name}</option>)}
        </select>
      </label>
      <label className="form-field" htmlFor={ids.role}><span>Role</span>
        <select id={ids.role} className="filter-button" value={roleName} disabled={busy !== null} aria-describedby={ids.roleHint} onChange={(event) => setRoleName(SERVICE_ACCOUNT_ROLES.find((role) => role === event.target.value) ?? "analyst")}>
          {SERVICE_ACCOUNT_ROLES.map((role) => <option key={role} value={role}>{SERVICE_ACCOUNT_ROLE_LABEL[role]}</option>)}
        </select>
      </label>
      <p id={ids.roleHint} className="table-muted">{ROLE_GUIDE[roleName]} A service account is never an administrator.</p>
      <label className="form-field" htmlFor={ids.account}><span>Account lifetime (days)</span>
        <input id={ids.account} className="input-control" type="number" min={1} max={SERVICE_ACCOUNT_MAX_LIFETIME_DAYS} step={1} required value={accountDays} disabled={busy !== null}
          onChange={(event) => setAccountDays(Math.min(SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} />
      </label>
      <label className="form-field" htmlFor={ids.credential}><span>Credential lifetime (days)</span>
        <input id={ids.credential} className="input-control" type="number" min={1} max={SERVICE_ACCOUNT_MAX_LIFETIME_DAYS} step={1} required value={newCredentialDays} disabled={busy !== null}
          onChange={(event) => setNewCredentialDays(Math.min(SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} />
      </label>
      <p className="table-muted">An account lasts up to {SERVICE_ACCOUNT_MAX_LIFETIME_DAYS} days. You can extend it later, up to {SERVICE_ACCOUNT_MAX_LIFETIME_DAYS} days from the day you extend it. A credential never outlasts its account.</p>
      <button type="submit" className="primary-button" disabled={!createReady}>{busy === "create" ? "Creating…" : "Create service account"}</button>
    </form>

    {reveal && <div className="lineage-note tone-warning service-account-secret" role="group" aria-label="New API credential">
      <Icon name="shield"/>
      <div>
        <strong>{reveal.heading}</strong>
        <span>This is the API credential for {reveal.accountName}. It is shown only now and cannot be retrieved again: if you lose it, rotate the credential. Treat it like a password.</span>
        <label className="form-field" htmlFor={ids.secret}><span>API credential (shown once)</span>
          <input id={ids.secret} className="input-control" readOnly value={reveal.credential.secret} onFocus={(event) => event.currentTarget.select()} />
        </label>
        <span className="table-secondary">Expires {time(reveal.credential.expiresAt)}</span>
        <div className="dialog-actions">
          <button type="button" className="secondary-button button-small" onClick={() => void copyToClipboard(reveal.credential.secret).then((ok) => setCopied(ok ? "copied" : "failed"))}>Copy credential</button>
          <button type="button" className="primary-button button-small" onClick={() => { setReveal(null); setCopied(null); }}>I have stored it</button>
        </div>
        <span role="status" aria-live="polite">{copied === "copied" ? "Copied to the clipboard." : copied === "failed" ? "Copy failed. Select the credential and copy it by hand." : ""}</span>
      </div>
    </div>}

    <div className="data-issues-status" role="status" aria-live="polite">{message?.tone === "success" ? message.text : ""}</div>
    {message?.tone === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Something went wrong</strong><span>{message.text}</span></div></div>}
    {state.kind === "loading" && <p className="empty-cell" role="status">Loading service accounts…</p>}
    {state.kind === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Service accounts are unavailable</strong><span>Nothing was changed. <button type="button" className="text-button" onClick={() => { setState({ kind: "loading" }); setReloadKey((key) => key + 1); }}>Try again</button></span></div></div>}
    {state.kind === "ready" && accounts.length === 0 && <p className="empty-cell">No service account has been created yet.</p>}
    {accounts.length > 0 && <ul className="data-issues-list" aria-label="Service accounts">
      {accounts.map((account) => {
        const headingId = `service-account-${account.serviceAccountId}`;
        const open = panel?.serviceAccountId === account.serviceAccountId ? panel.kind : null;
        const key = (kind: string) => `${kind}:${account.serviceAccountId}`;
        return <li key={account.serviceAccountId} className="data-issue-card" data-status={account.status} aria-labelledby={headingId}>
          <div className="data-issue-head">
            <div><h3 id={headingId}>{account.name}</h3><span className="table-secondary">{account.purpose}</span></div>
            <div className="data-issue-pills">
              <StatusPill status={SERVICE_ACCOUNT_STATUS_LABEL[account.status]}/>
              {(account.expiringSoon || account.needsOwner) && <StatusPill status="Needs attention"/>}
            </div>
          </div>
          {account.needsOwner && <p className="data-issue-summary"><strong>Needs a new owner.</strong> {account.ownerSubject} is no longer an active Organization Admin. The account and its credentials keep working, but it cannot be extended until an active Organization Admin takes it over.</p>}
          {account.expiringSoon && <p className="data-issue-summary"><strong>Expiring soon.</strong> {account.credentialExpiresAt && daysLeft(account.credentialExpiresAt) <= SERVICE_ACCOUNT_EXPIRY_WARNING_DAYS ? `Its credential expires ${day(account.credentialExpiresAt)}: rotate it before then.` : `The account itself expires ${day(account.expiresAt)}: create its replacement before then.`}</p>}
          <dl className="preview-dl service-account-facts" aria-label={`Details of ${account.name}`}>
            <div className="form-field"><dt>Role</dt><dd>{SERVICE_ACCOUNT_ROLE_LABEL[account.roleName]}</dd></div>
            <div className="form-field"><dt>Workspace</dt><dd>{account.workspaceName}</dd></div>
            <div className="form-field"><dt>Created by</dt><dd>{account.createdBy} · {day(account.createdAt)}</dd></div>
            <div className="form-field"><dt>Owner</dt><dd>{account.ownerSubject}{account.needsOwner ? " (no longer active)" : ""} · since {day(account.ownerAssignedAt)}</dd></div>
            <div className="form-field"><dt>Last used</dt><dd>{account.lastUsedAt ? time(account.lastUsedAt) : "Never used"}</dd></div>
            <div className="form-field"><dt>Credential expires</dt><dd>{account.credentialExpiresAt ? day(account.credentialExpiresAt) : "No credential in use"}</dd></div>
            <div className="form-field"><dt>Account expires</dt><dd>{day(account.expiresAt)}</dd></div>
            <div className="form-field"><dt>Identity reference</dt><dd><code>{account.userId}</code></dd></div>
          </dl>
          {account.status === "disabled" && <p className="data-issue-summary">Deactivated {account.disabledAt ? time(account.disabledAt) : ""} by {account.disabledBy}{account.disableReason ? `: ${account.disableReason}` : "."}</p>}

          {open === "rotate" && <div className="form-field" role="group" aria-label={`Rotate the credential of ${account.name}`}>
            <label htmlFor={ids.overlap}><span>Keep the old credential working for</span></label>
            <select id={ids.overlap} className="filter-button" value={overlap} disabled={busy !== null} onChange={(event) => setOverlap(Number(event.target.value))}>{OVERLAPS.map(([minutes, label]) => <option key={minutes} value={minutes}>{label}</option>)}</select>
            <label htmlFor={ids.days}><span>New credential lifetime (days)</span></label>
            <input id={ids.days} className="input-control" type="number" min={1} max={SERVICE_ACCOUNT_MAX_LIFETIME_DAYS} step={1} value={credentialDays} disabled={busy !== null} onChange={(event) => setCredentialDays(Math.min(SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} />
            <span className="table-muted">The new credential is shown once. Roll it out to your systems during the overlap, then the old one stops.</span>
          </div>}
          {open === "issue" && <div className="form-field" role="group" aria-label={`Issue a credential for ${account.name}`}>
            <label htmlFor={ids.days}><span>Credential lifetime (days)</span></label>
            <input id={ids.days} className="input-control" type="number" min={1} max={SERVICE_ACCOUNT_MAX_LIFETIME_DAYS} step={1} value={credentialDays} disabled={busy !== null} onChange={(event) => setCredentialDays(Math.min(SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} />
          </div>}
          {open === "extend" && (() => {
            const minimum = minimumExtensionDays(account.expiresAt, new Date());
            const valid = extendDays >= minimum && extendDays <= SERVICE_ACCOUNT_MAX_LIFETIME_DAYS;
            return <div className="form-field" role="group" aria-label={`Extend ${account.name}`}>
              <label htmlFor={ids.extend}><span>New expiry, in days from today</span></label>
              <input id={ids.extend} className="input-control" type="number" min={minimum} max={SERVICE_ACCOUNT_MAX_LIFETIME_DAYS} step={1} value={extendDays} disabled={busy !== null} aria-describedby={ids.extendHint} aria-invalid={valid ? undefined : true}
                onChange={(event) => setExtendDays(Math.min(SERVICE_ACCOUNT_MAX_LIFETIME_DAYS, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} />
              <span id={ids.extendHint} className="table-muted">{valid
                ? `The account will expire on ${day(new Date(Date.now() + extendDays * 86_400_000).toISOString())}, and its review date moves with it. Credentials keep their own expiry: rotate or issue one if needed.`
                : `Choose at least ${minimum} days, so the new expiry is later than ${day(account.expiresAt)}, and at most ${SERVICE_ACCOUNT_MAX_LIFETIME_DAYS}.`}</span>
            </div>;
          })()}
          {open === "transfer" && (() => {
            const candidates = owners.filter((owner) => owner.subject !== account.ownerSubject);
            return <div className="form-field" role="group" aria-label={`Change the owner of ${account.name}`}>
              <label htmlFor={ids.owner}><span>New owner</span></label>
              <select id={ids.owner} className="filter-button" value={newOwner} disabled={busy !== null || candidates.length === 0} onChange={(event) => setNewOwner(event.target.value)}>
                <option value="">Choose an Organization Admin</option>
                {candidates.map((owner) => <option key={owner.subject} value={owner.subject}>{owner.subject}</option>)}
              </select>
              <span className="table-muted">{candidates.length === 0 ? "No other active Organization Admin is available to take this account over." : "Only an active Organization Admin can own an account. The change is recorded in the audit trail."}</span>
            </div>;
          })()}
          {(open === "revoke" || open === "disable") && <div className="form-field" role="group" aria-label={open === "revoke" ? `Revoke the credentials of ${account.name}` : `Deactivate ${account.name}`}>
            <div className="lineage-note tone-warning"><Icon name="alert"/><div><strong>{open === "revoke" ? "Revoke every credential now?" : "Deactivate this account everywhere?"}</strong><span>{open === "revoke"
              ? "Every credential of this account stops working immediately, including one that is rotating out. The account stays, and you can issue a new credential."
              : "The account's access is removed in every workspace, its entitlements end and its credentials are revoked, all at once. This cannot be undone: create a new account if you need one again."}</span></div></div>
            <label htmlFor={ids.reason}><span>Reason</span></label>
            <input id={ids.reason} className="input-control" maxLength={SERVICE_ACCOUNT_MAX_REASON_LENGTH} value={reason} disabled={busy !== null} onChange={(event) => setReason(event.target.value)} placeholder={open === "revoke" ? "e.g. Credential found in a log file" : "e.g. Integration retired"} />
          </div>}

          <div className="data-issue-actions">
            {open === null && account.actions.canRotate && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setPanel({ serviceAccountId: account.serviceAccountId, kind: "rotate" }); setReason(""); }}>Rotate credential</button>}
            {open === null && account.actions.canIssue && <button type="button" className="primary-button button-small" disabled={busy !== null} onClick={() => { setPanel({ serviceAccountId: account.serviceAccountId, kind: "issue" }); setReason(""); }}>Issue credential</button>}
            {open === null && account.actions.canExtend && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setPanel({ serviceAccountId: account.serviceAccountId, kind: "extend" }); setReason(""); setExtendDays(SERVICE_ACCOUNT_MAX_LIFETIME_DAYS); }}>Extend expiry</button>}
            {open === null && account.actions.canTransfer && <button type="button" className={account.needsOwner ? "primary-button button-small" : "secondary-button button-small"} disabled={busy !== null} onClick={() => { setPanel({ serviceAccountId: account.serviceAccountId, kind: "transfer" }); setReason(""); setNewOwner(""); }}>{account.needsOwner ? "Assign a new owner" : "Change owner"}</button>}
            {open === null && account.actions.canRevoke && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setPanel({ serviceAccountId: account.serviceAccountId, kind: "revoke" }); setReason(""); }}>Revoke credential</button>}
            {open === null && account.actions.canDisable && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setPanel({ serviceAccountId: account.serviceAccountId, kind: "disable" }); setReason(""); }}>Deactivate account</button>}
            {open === "rotate" && <button type="button" className="primary-button button-small" disabled={busy !== null} onClick={() => void act(account, key("rotate"), { action: "rotate", overlapMinutes: overlap, credentialExpiresInDays: credentialDays }, () => "Credential rotated.", "The credential could not be rotated. Try again.")}>{busy === key("rotate") ? "Rotating…" : "Confirm rotation"}</button>}
            {open === "issue" && <button type="button" className="primary-button button-small" disabled={busy !== null} onClick={() => void act(account, key("issue"), { action: "issue", credentialExpiresInDays: credentialDays }, () => "Credential issued.", "The credential could not be issued. Try again.")}>{busy === key("issue") ? "Issuing…" : "Confirm issue"}</button>}
            {open === "extend" && <button type="button" className="primary-button button-small" disabled={busy !== null || extendDays < minimumExtensionDays(account.expiresAt, new Date())} onClick={() => void act(account, key("extend"), { action: "extend", expiresInDays: extendDays }, (updated) => `Expiry extended to ${day(updated.expiresAt)}.`, "The expiry could not be extended. Try again.")}>{busy === key("extend") ? "Extending…" : "Confirm extension"}</button>}
            {open === "transfer" && <button type="button" className="primary-button button-small" disabled={busy !== null || newOwner === ""} onClick={() => void act(account, key("transfer"), { action: "transfer", ownerSubject: newOwner }, (updated) => `${updated.name} is now owned by ${updated.ownerSubject}.`, "The owner could not be changed. Try again.")}>{busy === key("transfer") ? "Changing…" : "Confirm new owner"}</button>}
            {open === "revoke" && <button type="button" className="primary-button button-small" disabled={busy !== null || !reasonOk} onClick={() => void act(account, key("revoke"), { action: "revoke", reason: reason.trim() }, () => "Credentials revoked. They stopped working immediately.", "The credentials could not be revoked. Try again.")}>{busy === key("revoke") ? "Revoking…" : "Confirm revocation"}</button>}
            {open === "disable" && <button type="button" className="primary-button button-small" disabled={busy !== null || !reasonOk} onClick={() => void act(account, key("disable"), { action: "disable", reason: reason.trim() }, (updated) => `${updated.name} deactivated everywhere.`, "The account could not be deactivated. Try again.")}>{busy === key("disable") ? "Deactivating…" : "Confirm deactivation"}</button>}
            {open !== null && <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={closePanel}>Back</button>}
            {account.credentials.length > 0 && <details><summary>Credentials ({account.credentials.length})</summary>
              <div className="table-card" tabIndex={0} role="region" aria-label={`Credentials of ${account.name}`}><table className="data-table">
                <thead><tr><th>Credential</th><th>Status</th><th>Issued</th><th>Expires</th><th>Last used</th></tr></thead>
                <tbody>{account.credentials.map((credential) => <tr key={credential.credentialId}>
                  <td><code>{credential.credentialId.slice(0, 8)}</code><span className="table-secondary">{serviceAccountCredentialSummary(credential)}</span></td>
                  <td><StatusPill status={SERVICE_ACCOUNT_CREDENTIAL_STATUS_LABEL[credential.status]}/>{credential.status === "rotating_out" && credential.endsAt ? <span className="table-secondary">until {time(credential.endsAt)}</span> : null}</td>
                  <td>{time(credential.createdAt)}<span className="table-secondary">by {credential.createdBy}</span></td>
                  <td>{day(credential.expiresAt)}{credential.expiringSoon ? <span className="table-secondary">Expires soon</span> : null}</td>
                  <td>{credential.lastUsedAt ? time(credential.lastUsedAt) : "Never"}</td>
                </tr>)}</tbody></table></div>
            </details>}
          </div>
        </li>;
      })}
    </ul>}
  </section>;
}
