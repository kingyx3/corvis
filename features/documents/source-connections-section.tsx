"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { ContactSupportLink } from "@/components/help/contact-support-link";
import { StatusPill } from "@/components/ui/status-pill";
import { ConnectSourceWizard } from "@/features/documents/connect-source-wizard";
import { describeOnDemandTest, parseOAuthReturn, withoutOAuthReturn, type OAuthReturn } from "@/core/source-connect-wizard";
import {
  CONNECTION_ACTION_COPY,
  buildReauthorizeSecret,
  commandFailureMessage,
  credentialInput,
  describeConnection,
  reauthorizeOutcome,
  type ConnectionAction,
  type ConnectionHealth,
  type SourceConnectionRecord,
} from "@/core/source-connection-health";
import { apiUrl } from "@/lib/api-url";
import { friendlyErrorMessage, throwIfUnauthenticated } from "@/lib/api-errors";
import { displayDate } from "@/lib/display-format";
import { workspaceContextHeaders } from "@/lib/workspace-context";

type LoadState =
  | { kind: "loading" }
  // The caller is not an administrator of this workspace (HTTP 403): the section does not exist for them.
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "ready"; connections: SourceConnectionRecord[] };

type Fetched = Exclude<LoadState, { kind: "loading" }>;
type Dialog = { action: ConnectionAction; connection: SourceConnectionRecord };
type Outcome = { tone: "success" | "error"; text: string; title?: string };
type CommandResult<T = undefined> = { ok: true; data?: T } | { ok: false; status?: number; message?: string };

function time(value: string | undefined): string { return value ? displayDate(value, { timeStyle: "short" }) : "—"; }

async function fetchConnections(signal?: AbortSignal): Promise<Fetched> {
  try {
    const response = await fetch(apiUrl("/api/v1/source-connections"), { signal, credentials: "include", headers: workspaceContextHeaders() });
    throwIfUnauthenticated(response);
    if (response.status === 403) return { kind: "hidden" };
    if (!response.ok) return { kind: "error" };
    const payload = await response.json() as { data?: SourceConnectionRecord[] };
    return { kind: "ready", connections: payload.data ?? [] };
  } catch {
    return { kind: "error" };
  }
}

/** One request to a connection command. Never logs or returns the request body; the response carries no credential. */
async function sendCommand<T = undefined>(path: string, method: "PATCH" | "POST", body: unknown, readResult = false): Promise<CommandResult<T>> {
  try {
    const response = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers: { ...workspaceContextHeaders(), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    throwIfUnauthenticated(response);
    if (!response.ok) return { ok: false, status: response.status };
    // Only the on-demand test reads a body back (a pass/fail result); no other command's response carries anything the page uses.
    return readResult ? { ok: true, data: (await response.json() as { data: T }).data } : { ok: true };
  } catch (reason) {
    return { ok: false, message: friendlyErrorMessage(reason, "The change could not be completed. Nothing was changed; try again.") };
  }
}

function failureText(action: ConnectionAction, result: Extract<CommandResult, { ok: false }>): string {
  return result.message ?? commandFailureMessage(action, result.status);
}

/**
 * Source connections (stories B5/B8): one list of the workspace's connections with
 * plain-language health, the single next action, and pause / resume / reauthorize / revoke
 * controls. Renders nothing for a caller the API refuses (HTTP 403), like the run history.
 */
export function SourceConnectionsSection({ runHistoryAvailable, onOpenRunHistory, onChanged }: {
  /** Connection ids whose run history is rendered below, so a row only links to history that exists. */
  runHistoryAvailable: ReadonlySet<string>;
  onOpenRunHistory: (sourceConnectionId: string) => void;
  /** Called after a command succeeds so the attention banner and run history can refresh. */
  onChanged: () => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // The row to focus once the refreshed list has rendered (set before the reload, consumed by the effect below).
  const focusId = useRef<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  // The Connect source wizard; `resume` is set when the administrator was just redirected back from a provider's consent page.
  const [wizard, setWizard] = useState<{ resume: OAuthReturn | null } | null>(() => {
    if (typeof window === "undefined") return null;
    const returned = parseOAuthReturn(window.location.search);
    return returned.kind === "none" ? null : { resume: returned };
  });
  const connectedId = useRef<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  // A provider redirects back to `/?source_oauth=return&code=…&state=…`: take the one-time values out of the URL
  // straight away (so a reload or a shared link cannot replay them) and resume the wizard with them.
  useEffect(() => {
    if (parseOAuthReturn(window.location.search).kind === "none") return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${withoutOAuthReturn(window.location.search)}${window.location.hash}`);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchConnections(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setNow(new Date());
      setState(result);
    });
    return () => controller.abort();
  }, [reloadKey]);

  // After a command the opener may have been replaced (Pause becomes Resume), so focus lands on the row it changed.
  useEffect(() => {
    if (!focusId.current || state.kind !== "ready") return;
    document.getElementById(`source-connection-heading-${focusId.current}`)?.focus();
    focusId.current = null;
  }, [state]);

  if (state.kind === "hidden" || state.kind === "loading") return null;

  const finish = async (connection: SourceConnectionRecord, text: string) => {
    setDialog(null);
    setOutcome({ tone: "success", text: `${connection.connectionLabel}: ${text}` });
    focusId.current = connection.sourceConnectionId;
    const result = await fetchConnections();
    setNow(new Date());
    setState(result);
    onChanged();
  };

  // The list behind the wizard refreshes as soon as a connection exists; focus moves to it only once the dialog has closed.
  const closeWizard = () => {
    setWizard(null);
    if (!connectedId.current) return;
    focusId.current = connectedId.current;
    connectedId.current = null;
    setReloadKey((key) => key + 1);
  };

  const reload = async () => {
    const result = await fetchConnections();
    setNow(new Date());
    setState(result);
    onChanged();
  };

  const runTest = async (connection: SourceConnectionRecord) => {
    setOutcome(null);
    setTestingId(connection.sourceConnectionId);
    const result = await sendCommand<{ ok: boolean; errorClass?: string }>(`/api/v1/source-connections/${encodeURIComponent(connection.sourceConnectionId)}/test`, "POST", {}, true);
    setTestingId(null);
    focusId.current = connection.sourceConnectionId;
    if (!result.ok) {
      setOutcome({ tone: "error", title: "Connection test did not run", text: `${connection.connectionLabel}: ${result.message ?? "The test could not be run. Nothing was changed; try again."}` });
    } else {
      const described = describeOnDemandTest(connection.connectionLabel, result.data ?? { ok: false });
      setOutcome(described.tone === "success" ? described : { ...described, title: "Connection test did not pass" });
    }
    await reload();
  };

  return <section aria-labelledby="source-connections-heading" className="source-connections">
    <section className="page-heading"><div><p className="eyebrow">Source acquisition</p><h2 id="source-connections-heading">Source connections</h2><p className="lede">Each connection&apos;s health, what it collects, when it last synced, and the one thing to do next. Changes here are limited to administrators of this workspace and are recorded in the access audit.</p></div><button type="button" className="primary-button" onClick={() => { setOutcome(null); setWizard({ resume: null }); }}>Connect source</button></section>
    <div className="source-connections-status" role="status" aria-live="polite">{outcome?.tone === "success" ? outcome.text : ""}</div>
    {outcome?.tone === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>{outcome.title ?? "Change not applied"}</strong><span>{outcome.text}</span></div></div>}
    {state.kind === "error" && <div className="table-card" role="alert"><div className="empty-cell"><strong>Source connections are unavailable.</strong> The documents above are unaffected. <button className="text-button" onClick={() => { setState({ kind: "loading" }); setReloadKey((key) => key + 1); }}>Retry</button></div></div>}
    {state.kind === "ready" && state.connections.length === 0 && <div className="table-card"><div className="empty-cell">No source connections yet. Use Connect source to add one.</div></div>}
    {state.kind === "ready" && state.connections.length > 0 && <ul className="source-connections-list" aria-label="Source connections">
      {state.connections.map((connection) => <ConnectionCard key={connection.sourceConnectionId} connection={connection} health={describeConnection(connection, now)} hasRunHistory={runHistoryAvailable.has(connection.sourceConnectionId)} onOpenRunHistory={onOpenRunHistory} testing={testingId === connection.sourceConnectionId} onTest={() => void runTest(connection)} onAction={(action) => { setOutcome(null); setDialog({ action, connection }); }}/>)}
    </ul>}
    {dialog && dialog.action !== "reauthorize" && <ConfirmDialog action={dialog.action} connection={dialog.connection} onClose={() => setDialog(null)} onDone={(text) => finish(dialog.connection, text)}/>}
    {wizard && <ConnectSourceWizard resume={wizard.resume} onClose={closeWizard} onConnected={(sourceConnectionId) => { connectedId.current = sourceConnectionId; void reload(); }}/>}
    {dialog?.action === "reauthorize" && credentialInput(dialog.connection.credentialType).kind === "oauth" && <OAuthReauthorizeDialog connection={dialog.connection} onClose={() => setDialog(null)}/>}
    {dialog?.action === "reauthorize" && credentialInput(dialog.connection.credentialType).kind !== "oauth" && <ReauthorizeDialog connection={dialog.connection} onClose={() => setDialog(null)} onDone={(text) => finish(dialog.connection, text)}/>}
  </section>;
}

function ConnectionCard({ connection, health, hasRunHistory, testing, onTest, onOpenRunHistory, onAction }: {
  connection: SourceConnectionRecord;
  health: ConnectionHealth;
  hasRunHistory: boolean;
  testing: boolean;
  onTest: () => void;
  onOpenRunHistory: (sourceConnectionId: string) => void;
  onAction: (action: ConnectionAction) => void;
}) {
  const id = connection.sourceConnectionId;
  const headingId = `source-connection-heading-${id}`;
  const { controls, action } = health;
  const label = connection.connectionLabel;
  const reauthorizeIsNext = action.kind === "reauthorize";
  // For transient and attention states the headline already is the error summary.
  const latestError = health.severity === "transient" || health.severity === "attention" ? undefined : health.error;
  return <li className="source-connection-card" data-severity={health.severity} data-stale={health.stale ? "true" : "false"}>
    <div className="source-connection-head">
      <div><h3 id={headingId} tabIndex={-1}>{label}</h3><span className="table-secondary">{health.credentialLabel}</span></div>
      <div className="source-connection-pills">{health.pills.map((pill) => <StatusPill key={pill} status={pill}/>)}</div>
    </div>
    <div className="source-connection-notice" data-severity={health.severity}>
      <Icon name={health.icon} size={20}/>
      <div><strong>{health.headline}</strong>{latestError && <span>Latest error: {latestError.summary}</span>}</div>
    </div>
    <dl className="source-connection-facts">
      <div><dt>Scope</dt><dd>{health.scopeSummary}{health.scopeItems.length > 0 && <details><summary>Scope details</summary><ul>{health.scopeItems.map((item) => <li key={`${item.label}|${item.path ?? ""}`}>{item.label}{item.path && <span className="table-secondary"> · {item.path}</span>}</li>)}</ul></details>}</dd></div>
      <div><dt>Last successful sync</dt><dd>{health.lastSuccess.at ? <><time dateTime={health.lastSuccess.at}>{time(health.lastSuccess.at)}</time><span className="table-secondary">{health.lastSuccess.relative}</span></> : "Never"}</dd></div>
      <div><dt>Last attempt</dt><dd>{health.lastAttempt ? <><time dateTime={health.lastAttempt.at}>{time(health.lastAttempt.at)}</time><span className="table-secondary">{health.lastAttempt.relative}{health.lastAttempt.failed ? " · did not succeed" : ""}</span></> : "No attempt yet"}</dd></div>
      <div><dt>Next sync</dt><dd>{health.nextSync}</dd></div>
      <div className="source-connection-required"><dt>Required action</dt><dd><strong>{action.label}</strong><span className="table-secondary">{action.detail}</span>{action.kind === "contact_support" && <ContactSupportLink className="text-button" view="documents"/>}</dd></div>
    </dl>
    <div className="source-connection-controls">
      {controls.test && <button className={action.kind === "test" ? "primary-button" : "secondary-button"} aria-label={`Test connection ${label}`} disabled={testing} aria-busy={testing || undefined} onClick={onTest}>{testing ? "Testing…" : "Test connection"}</button>}
      {controls.reauthorize && <button className={reauthorizeIsNext ? "primary-button" : "secondary-button"} aria-label={`Reauthorize ${label}`} onClick={() => onAction("reauthorize")}>Reauthorize</button>}
      {controls.resume && <button className="primary-button" aria-label={`Resume ${label}`} onClick={() => onAction("resume")}>Resume</button>}
      {controls.pause && <button className="secondary-button" aria-label={`Pause ${label}`} onClick={() => onAction("pause")}>Pause</button>}
      {controls.revoke && <button className="danger-button" aria-label={`Revoke ${label}`} onClick={() => onAction("revoke")}>Revoke</button>}
      {hasRunHistory && <button className="text-button" aria-label={`View run history for ${label}`} onClick={() => onOpenRunHistory(id)}>View run history</button>}
    </div>
  </li>;
}

function ConfirmDialog({ action, connection, onClose, onDone }: {
  action: "pause" | "resume" | "revoke";
  connection: SourceConnectionRecord;
  onClose: () => void;
  onDone: (text: string) => Promise<void>;
}) {
  const copy = CONNECTION_ACTION_COPY[action];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result = await sendCommand(`/api/v1/source-connections/${encodeURIComponent(connection.sourceConnectionId)}`, "PATCH", { action });
    if (result.ok) { await onDone(copy.success); return; }
    setError(failureText(action, result));
    setBusy(false);
  };
  return <Modal label={`${copy.confirmLabel}: ${connection.connectionLabel}`} onClose={() => { if (!busy) onClose(); }}>
    <div className="dialog-header"><div><p className="eyebrow">{action === "revoke" ? "Confirm irreversible change" : "Confirm change"}</p><h2>{copy.title}</h2><p>{connection.connectionLabel}</p></div></div>
    <div className="dialog-body">
      {action === "revoke" && <div className="lineage-note tone-danger"><Icon name="alert"/><div><strong>This cannot be undone.</strong><span>Revoking is permanent for this connection.</span></div></div>}
      <p>{action === "revoke" ? "Here is exactly what happens:" : "What this does:"}</p>
      <ul className="source-connection-consequences">{copy.consequences.map((line) => <li key={line}>{line}</li>)}</ul>
      {error && <p role="alert" className="source-connection-dialog-error">{error}</p>}
    </div>
    <div className="dialog-actions">
      <button type="button" className="secondary-button" data-autofocus disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className={action === "revoke" ? "danger-button" : "primary-button"} disabled={busy} onClick={() => void confirm()}>{busy ? copy.busyLabel : copy.confirmLabel}</button>
    </div>
  </Modal>;
}

/**
 * Reauthorizing a connection that signs in with OAuth: the same sign-in leg as connecting, started for this connection
 * (only its id is sent). The administrator approves at the provider, is brought back, and Corvis stores the new
 * credential, retires the old one and tests the connection (see the wizard's return handling).
 */
function OAuthReauthorizeDialog({ connection, onClose }: { connection: SourceConnectionRecord; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const result = await sendCommand<{ authorizationUrl: string }>("/api/v1/source-connections/oauth/start", "POST", { sourceConnectionId: connection.sourceConnectionId }, true);
    if (!result.ok || !result.data) {
      setError(result.ok ? commandFailureMessage("reauthorize", undefined) : failureText("reauthorize", result));
      setBusy(false);
      return;
    }
    // Leaves the app for the provider's consent page; the provider redirects back with a one-time code.
    window.location.assign(result.data.authorizationUrl);
  };

  return <Modal label={`Reauthorize ${connection.connectionLabel}`} onClose={() => { if (!busy) onClose(); }}>
    <div className="dialog-header"><div><p className="eyebrow">Sign in again</p><h2>Reauthorize {connection.connectionLabel}</h2></div></div>
    <div className="dialog-body">
      <ul className="source-connection-consequences">
        <li>You will leave Corvis and sign in on the provider&apos;s own page, where you approve the same access this connection already has. Its scope does not change.</li>
        <li>Corvis never sees your provider password. When you approve, you are brought back here, Corvis saves the new credential and tests the connection.</li>
        <li>The previous credential is destroyed only after the new one is saved and the change is recorded in the audit log. Collected documents and the run history are kept.</li>
        <li>{connection.status === "paused" ? "This connection is paused and stays paused until you resume it." : "Collection restarts once the test passes."}</li>
        <li>If you decline or close the provider&apos;s page, nothing changes.</li>
      </ul>
      {error && <p role="alert" className="source-connection-dialog-error">{error}</p>}
    </div>
    <div className="dialog-actions">
      <button type="button" className="secondary-button" data-autofocus disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void start()}>{busy ? "Opening the provider…" : "Go to the provider"}</button>
    </div>
  </Modal>;
}

function ReauthorizeDialog({ connection, onClose, onDone }: {
  connection: SourceConnectionRecord;
  onClose: () => void;
  onDone: (text: string) => Promise<void>;
}) {
  const input = credentialInput(connection.credentialType);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Uncontrolled on purpose: the credential is read once on submit and the field is emptied straight away,
  // so it is never held in React state, re-rendered or echoed back.
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const hintId = useId();
  const clear = () => { if (fieldRef.current) fieldRef.current.value = ""; };

  useEffect(() => {
    const field = fieldRef.current;
    return () => { if (field) field.value = ""; };
  }, []);

  // An OAuth connection is renewed by OAuthReauthorizeDialog, never by typing a credential.
  if (input.kind === "oauth") return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = buildReauthorizeSecret(connection.credentialType, fieldRef.current?.value ?? "");
    clear();
    if (!built.ok) { setError(built.error); return; }
    setBusy(true);
    setError(null);
    const result = await sendCommand(`/api/v1/source-connections/${encodeURIComponent(connection.sourceConnectionId)}/reauthorize`, "POST", { secret: built.secret });
    if (result.ok) { await onDone(reauthorizeOutcome(connection.status)); return; }
    setError(`${failureText("reauthorize", result)} The credential field was cleared; enter it again to retry.`);
    setBusy(false);
  };

  return <Modal label={`Reauthorize ${connection.connectionLabel}`} onClose={() => { if (!busy) { clear(); onClose(); } }}>
    <form onSubmit={(event) => void submit(event)} autoComplete="off">
      <div className="dialog-header"><div><p className="eyebrow">Replace credential</p><h2>Reauthorize {connection.connectionLabel}</h2></div></div>
      <div className="dialog-body">
        <ul className="source-connection-consequences">
          <li>The new credential replaces the stored one. Collected documents and the run history are kept.</li>
          <li>The previous credential is destroyed only after the new one is saved and the change is recorded in the audit log.</li>
          <li>{connection.status === "paused" ? "This connection is paused and stays paused until you resume it." : "Collection restarts as soon as the credential is saved."}</li>
        </ul>
        <label className="form-field"><span>{input.label}</span>
          {input.kind === "json"
            ? <textarea ref={fieldRef} className="source-connection-secret-json" rows={6} name="credential-json" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} aria-describedby={hintId} required disabled={busy} data-lpignore="true" data-1p-ignore="true"/>
            : <input ref={fieldRef} className="input-control" type="password" name="credential-token" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} aria-describedby={hintId} required disabled={busy} data-lpignore="true" data-1p-ignore="true"/>}
          <small id={hintId} className="field-hint">{input.hint}</small>
        </label>
        {error && <p role="alert" className="source-connection-dialog-error">{error}</p>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { clear(); onClose(); }}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Replace credential"}</button>
      </div>
    </form>
  </Modal>;
}
