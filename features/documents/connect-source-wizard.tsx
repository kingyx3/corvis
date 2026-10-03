"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ContactSupportLink } from "@/components/help/contact-support-link";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { StatusPill } from "@/components/ui/status-pill";
import {
  CONNECT_CONFIRMATION_LABEL,
  CONNECT_CONFIRMATION_REQUIRED,
  OAUTH_ATTEMPT_UNUSABLE,
  OAUTH_COMPLETING,
  OAUTH_DENIED,
  TEST_FAILURE_CONSEQUENCE,
  buildConnectSecret,
  connectCredentialField,
  connectFailureMessage,
  describeTestFailure,
  validateConnectionName,
  type OAuthReturn,
  type SourceProviderDescriptor,
} from "@/core/source-connect-wizard";
import type { SourceConnectionRecord } from "@/core/source-connection-health";
import { apiUrl } from "@/lib/api-url";
import { friendlyErrorMessage, throwIfUnauthenticated } from "@/lib/api-errors";
import { workspaceContextHeaders } from "@/lib/workspace-context";

/**
 * "Connect source" (story B1): pick an approved provider, review exactly what Corvis will access, confirm,
 * authorize (a redirect through the provider's consent page, or a credential typed once), then test. Every step
 * is its own heading that takes focus when it appears. A credential is read once on submit from an uncontrolled
 * field and emptied immediately: it is never held in React state, rendered back, or stored in the browser.
 */

type Provider = SourceProviderDescriptor;
type CredentialKind = "scoped_api_token" | "service_account" | "browser_session";
type TestResult = { ok: boolean; errorClass?: string };

type Step =
  | { id: "providers" }
  | { id: "review"; provider: Provider }
  | { id: "credential"; provider: Provider; credentialType: CredentialKind }
  | { id: "authorize"; provider: Provider }
  /** `label` is null while the sign-in redirect is being completed and the provider is not yet known. */
  | { id: "testing"; label: string | null }
  /** `reauthorized` is set when the sign-in renewed an existing connection instead of creating one. */
  | { id: "success"; connection: SourceConnectionRecord; reauthorized?: boolean }
  | { id: "failed"; connection: SourceConnectionRecord; errorClass?: string }
  | { id: "oauth-problem"; kind: "denied" | "invalid" };

type ProviderList = { kind: "loading" } | { kind: "error" } | { kind: "ready"; providers: Provider[] };

type Reply<T> = { ok: true; data: T } | { ok: false; status?: number; message?: string };

async function request<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<Reply<T>> {
  try {
    const response = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers: { ...workspaceContextHeaders(), accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    throwIfUnauthenticated(response);
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: (await response.json() as { data: T }).data };
  } catch (reason) {
    return { ok: false, message: friendlyErrorMessage(reason, "Corvis could not be reached. Nothing was saved; try again.") };
  }
}

const CONNECTIONS = "/api/v1/source-connections";

function initialStep(resume: OAuthReturn | null): Step {
  if (resume?.kind === "callback") return { id: "testing", label: null };
  if (resume?.kind === "denied" || resume?.kind === "invalid") return { id: "oauth-problem", kind: resume.kind };
  return { id: "providers" };
}

export function ConnectSourceWizard({ resume, onClose, onConnected }: {
  /** Set when the administrator has just been redirected back from a provider's consent page. */
  resume: OAuthReturn | null;
  onClose: () => void;
  /** Called with the new connection's id as soon as it exists, so the list behind the dialog refreshes. */
  onConnected: (sourceConnectionId: string) => void;
}) {
  const [step, setStep] = useState<Step>(() => initialStep(resume));
  const [providers, setProviders] = useState<ProviderList>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSeq, setErrorSeq] = useState(0);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const credentialRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const focusTarget = useRef<"name" | "confirm" | "credential">("name");
  const resumed = useRef(false);
  const errorId = useId();
  const hintId = useId();

  // Each step announces itself by taking focus on its heading. Deferred one tick so it wins over the dialog's own initial focus.
  const stepKey = step.id;
  useEffect(() => {
    const timer = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [stepKey]);

  // A refused step moves focus to the control that needs fixing (named before the error counter changes).
  useEffect(() => {
    if (errorSeq === 0) return;
    const control = { name: nameRef, confirm: confirmRef, credential: credentialRef }[focusTarget.current].current;
    control?.focus();
  }, [errorSeq]);

  useEffect(() => {
    const controller = new AbortController();
    void request<Provider[]>(`${CONNECTIONS}/providers`, "GET").then((reply) => {
      if (!controller.signal.aborted) setProviders(reply.ok ? { kind: "ready", providers: reply.data } : { kind: "error" });
    });
    return () => controller.abort();
  }, [reloadKey]);

  // The redirect back from the provider is processed exactly once (also under React Strict Mode's second effect run).
  useEffect(() => {
    if (!resume || resumed.current) return;
    resumed.current = true;
    if (resume.kind !== "callback") {
      // The administrator declined (or the response was unusable): destroy the pending attempt server-side.
      void request(`${CONNECTIONS}/oauth/complete`, "POST", { denied: true });
      return;
    }
    void request<{ outcome: string; connection: SourceConnectionRecord; test: TestResult }>(`${CONNECTIONS}/oauth/complete`, "POST", { code: resume.code, state: resume.state }).then((reply) => {
      if (!reply.ok) { setStep({ id: "oauth-problem", kind: "invalid" }); return; }
      showResult(reply.data.connection, reply.data.test, reply.data.outcome === "reauthorized");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per redirect; `showResult` only reads stable setters and the prop callback.
  }, [resume]);

  function fail(message: string, focus?: "name" | "confirm" | "credential") {
    setError(message);
    if (focus) { focusTarget.current = focus; setErrorSeq((seq) => seq + 1); }
  }

  function showResult(connection: SourceConnectionRecord, test: TestResult, reauthorized = false) {
    setBusy(false);
    onConnected(connection.sourceConnectionId);
    setStep(test.ok ? { id: "success", connection, ...(reauthorized ? { reauthorized: true } : {}) } : { id: "failed", connection, ...(test.errorClass ? { errorClass: test.errorClass } : {}) });
  }

  function choose(provider: Provider) {
    setName(provider.displayName);
    setConfirmed(false);
    setError(null);
    setStep({ id: "review", provider });
  }

  function confirmReview(event: FormEvent, provider: Provider) {
    event.preventDefault();
    const checked = validateConnectionName(name);
    if (!checked.ok) { fail(checked.error, "name"); return; }
    if (!confirmed) { fail(CONNECT_CONFIRMATION_REQUIRED, "confirm"); return; }
    setError(null);
    setStep(provider.connect.method === "oauth" ? { id: "authorize", provider } : { id: "credential", provider, credentialType: provider.connect.credentialType });
  }

  async function startOAuth(provider: Provider) {
    setBusy(true);
    setError(null);
    const reply = await request<{ authorizationUrl: string }>(`${CONNECTIONS}/oauth/start`, "POST", { providerKey: provider.providerKey, connectionLabel: name.trim(), scopeConfirmed: true });
    if (!reply.ok) { setBusy(false); fail(reply.message ?? connectFailureMessage(reply.status)); return; }
    // Leaves the app for the provider's consent page; the provider redirects back with a one-time code.
    window.location.assign(reply.data.authorizationUrl);
  }

  async function saveCredential(event: FormEvent, provider: Provider, credentialType: CredentialKind) {
    event.preventDefault();
    const raw = credentialRef.current?.value ?? "";
    if (credentialRef.current) credentialRef.current.value = "";
    const built = buildConnectSecret(credentialType, raw);
    if (!built.ok) { fail(built.error, "credential"); return; }
    setBusy(true);
    setError(null);
    setStep({ id: "testing", label: provider.displayName });
    const reply = await request<{ connection: SourceConnectionRecord; test: TestResult }>(`${CONNECTIONS}/connect`, "POST", {
      providerKey: provider.providerKey, connectionLabel: name.trim(), scopeConfirmed: true, secret: built.secret,
    });
    if (!reply.ok) {
      setBusy(false);
      setStep({ id: "credential", provider, credentialType });
      fail(`${reply.message ?? connectFailureMessage(reply.status)} The credential field was cleared; enter it again to retry.`);
      return;
    }
    showResult(reply.data.connection, reply.data.test);
  }

  async function testAgain(connection: SourceConnectionRecord) {
    setBusy(true);
    setStep({ id: "testing", label: connection.connectionLabel });
    const reply = await request<TestResult>(`${CONNECTIONS}/${encodeURIComponent(connection.sourceConnectionId)}/test`, "POST");
    setBusy(false);
    if (!reply.ok) { setStep({ id: "failed", connection }); return; }
    showResult(connection, reply.data);
  }

  const heading = (text: string) => <h2 ref={headingRef} tabIndex={-1} className="connect-source-heading">{text}</h2>;
  const eyebrow = (text: string) => <p className="eyebrow">{text}</p>;
  const errorBox = error && <p id={errorId} role="alert" className="source-connection-dialog-error">{error}</p>;

  return <Modal label="Connect source" width="min(680px, 100%)" onClose={() => { if (!busy) onClose(); }}>
    {step.id === "providers" && <>
      <div className="dialog-header"><div>{eyebrow("Step 1 of 4 · Connect source")}{heading("Choose a source")}<p>Only providers Corvis has approved are listed. Nothing is accessed until you review and confirm in the next steps.</p></div></div>
      <div className="dialog-body">
        {providers.kind === "loading" && <p role="status">Loading approved sources…</p>}
        {providers.kind === "error" && <div role="alert" className="source-connection-dialog-error">The list of approved sources could not be loaded. <button type="button" className="text-button" onClick={() => { setProviders({ kind: "loading" }); setReloadKey((key) => key + 1); }}>Retry</button></div>}
        {providers.kind === "ready" && providers.providers.length === 0 && <div className="lineage-note" data-testid="connect-source-empty"><Icon name="source"/><div><strong>No sources are approved for your workspace yet.</strong><span>Corvis turns on a source only after its integration has been certified. When one is available for you it will appear here. Questions about a specific portal? <ContactSupportLink className="text-button" view="documents">Contact support</ContactSupportLink>.</span></div></div>}
        {providers.kind === "ready" && providers.providers.length > 0 && <ul className="connect-source-providers" aria-label="Approved sources">
          {providers.providers.map((provider) => <li key={provider.providerKey}>
            <button type="button" className="connect-source-provider" onClick={() => choose(provider)}>
              <span className="connect-source-provider-name"><strong>{provider.displayName}</strong>{provider.demo && <StatusPill status="Demo"/>}</span>
              <span className="table-secondary">{provider.summary}</span>
            </button>
          </li>)}
        </ul>}
      </div>
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Close</button></div>
    </>}

    {step.id === "review" && (() => {
      const provider = step.provider;
      const nameMissing = !validateConnectionName(name).ok;
      return <form onSubmit={(event) => confirmReview(event, provider)} autoComplete="off" noValidate>
        <div className="dialog-header"><div>{eyebrow("Step 2 of 4 · Review access")}{heading("Review what Corvis will access")}<p>{provider.displayName}{provider.demo && " · demonstration provider, no real portal is contacted"}</p></div></div>
        <div className="dialog-body">
          <section aria-labelledby="connect-reads"><h3 id="connect-reads">What Corvis will read</h3><ul className="source-connection-consequences">{provider.disclosure.reads.map((line) => <li key={line}>{line}</li>)}</ul>
            <p className="table-secondary">In scope:</p><ul className="source-connection-consequences">{provider.scope.map((item) => <li key={`${item.label}|${item.path ?? ""}`}>{item.label}{item.path && <span className="table-secondary"> · {item.path}</span>}</li>)}</ul></section>
          <section aria-labelledby="connect-behaviour"><h3 id="connect-behaviour">How it works</h3><ul className="source-connection-consequences">{provider.disclosure.behaviour.map((line) => <li key={line}>{line}</li>)}</ul></section>
          <section aria-labelledby="connect-limits"><h3 id="connect-limits">What Corvis will not do</h3><ul className="source-connection-consequences">{provider.disclosure.limits.map((line) => <li key={line}>{line}</li>)}</ul></section>
          <label className="form-field"><span>Connection name</span>
            <input ref={nameRef} className="input-control" name="connection-name" value={name} onChange={(event) => setName(event.target.value)} aria-invalid={error && nameMissing ? true : undefined} aria-describedby={error && nameMissing ? errorId : undefined} autoComplete="off"/>
            <small className="field-hint">The name you will recognise in the list of source connections.</small>
          </label>
          <label className="connect-source-confirm"><input ref={confirmRef} type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); if (event.target.checked) setError(null); }} aria-invalid={error && !nameMissing && !confirmed ? true : undefined} aria-describedby={error && !nameMissing ? errorId : undefined}/><span>{CONNECT_CONFIRMATION_LABEL}</span></label>
          {errorBox}
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={() => { setError(null); setStep({ id: "providers" }); }}>Back</button>
          <button type="submit" className="primary-button">{provider.connect.method === "oauth" ? "Continue to sign-in" : "Continue to enter credential"}</button>
        </div>
      </form>;
    })()}

    {step.id === "credential" && (() => {
      const { provider, credentialType } = step;
      const field = connectCredentialField(credentialType);
      const describedBy = error ? `${hintId} ${errorId}` : hintId;
      return <form onSubmit={(event) => void saveCredential(event, provider, credentialType)} autoComplete="off">
        <div className="dialog-header"><div>{eyebrow("Step 3 of 4 · Authorize")}{heading("Enter the credential")}<p>{provider.displayName}</p></div></div>
        <div className="dialog-body">
          <label className="form-field"><span>{field.label}</span>
            {field.kind === "json"
              ? <textarea ref={credentialRef as never} className="source-connection-secret-json" rows={6} name="credential-json" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} aria-describedby={describedBy} aria-invalid={error ? true : undefined} disabled={busy} data-lpignore="true" data-1p-ignore="true"/>
              : <input ref={credentialRef as never} className="input-control" type="password" name="credential-token" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} aria-describedby={describedBy} aria-invalid={error ? true : undefined} disabled={busy} data-lpignore="true" data-1p-ignore="true"/>}
            <small id={hintId} className="field-hint">{field.hint}{provider.credentialHint && <> {provider.credentialHint}</>}</small>
          </label>
          {errorBox}
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { if (credentialRef.current) credentialRef.current.value = ""; setError(null); setStep({ id: "review", provider }); }}>Back</button>
          <button type="submit" className="primary-button" disabled={busy}>Save and test connection</button>
        </div>
      </form>;
    })()}

    {step.id === "authorize" && (() => {
      const provider = step.provider;
      return <>
        <div className="dialog-header"><div>{eyebrow("Step 3 of 4 · Authorize")}{heading("Authorize with the provider")}<p>{provider.displayName}</p></div></div>
        <div className="dialog-body">
          <ul className="source-connection-consequences">
            <li>You will leave Corvis and sign in on the provider&apos;s own page, where you approve exactly the access you just reviewed.</li>
            <li>Corvis never sees your provider password. When you approve, you are brought back here and Corvis tests the connection.</li>
            <li>If you decline or close the provider&apos;s page, nothing is connected and nothing is stored.</li>
          </ul>
          {errorBox}
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { setError(null); setStep({ id: "review", provider }); }}>Back</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void startOAuth(provider)}>{busy ? "Opening the provider…" : "Go to the provider"}</button>
        </div>
      </>;
    })()}

    {step.id === "testing" && <>
      <div className="dialog-header"><div>{eyebrow("Step 4 of 4 · Test")}{heading("Testing the connection")}</div></div>
      <div className="dialog-body"><p role="status">{step.label === null ? OAUTH_COMPLETING : `Corvis is checking that it can reach ${step.label} with the access you confirmed. This usually takes a few seconds.`}</p></div>
    </>}

    {step.id === "success" && <>
      <div className="dialog-header"><div>{eyebrow(step.reauthorized ? "Reauthorization · Test" : "Step 4 of 4 · Test")}{heading(step.reauthorized ? "Connection reauthorized" : "Connection verified")}<p>{step.connection.connectionLabel}</p></div></div>
      <div className="dialog-body">
        <div className="lineage-note tone-success"><Icon name="check"/><div><strong>Corvis can reach the provider with the access you confirmed.</strong><span>{step.reauthorized
          ? `The new credential is saved and the previous one was retired. ${step.connection.status === "paused" ? "The connection is paused and stays paused until you resume it." : "The connection is active again."}`
          : "The connection is active. Scheduled collection is not switched on yet, so nothing has been collected; once it is, documents enter the normal Corvis review process."}</span></div></div>
        <p>You can test again, pause, reauthorize or revoke this connection from the Source connections list.</p>
      </div>
      <div className="dialog-actions"><button type="button" className="primary-button" onClick={onClose}>Done</button></div>
    </>}

    {step.id === "failed" && (() => {
      const failure = describeTestFailure(step.errorClass);
      const connection = step.connection;
      return <>
        <div className="dialog-header"><div>{eyebrow("Step 4 of 4 · Test")}{heading("The connection test did not pass")}<p>{connection.connectionLabel}</p></div></div>
        <div className="dialog-body">
          <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>{failure.reason}</strong><span>{TEST_FAILURE_CONSEQUENCE}</span></div></div>
          <p>{failure.nextStep}</p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Close</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void testAgain(connection)}>Test again</button>
        </div>
      </>;
    })()}

    {step.id === "oauth-problem" && <>
      <div className="dialog-header"><div>{eyebrow("Authorization")}{heading("Authorization was not completed")}</div></div>
      <div className="dialog-body"><div className="lineage-note tone-warning" role="alert"><Icon name="alert"/><div><strong>{step.kind === "denied" ? OAUTH_DENIED : OAUTH_ATTEMPT_UNUSABLE}</strong><span>You can start again whenever you are ready.</span></div></div></div>
      <div className="dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
        <button type="button" className="primary-button" onClick={() => { setError(null); setReloadKey((key) => key + 1); setProviders({ kind: "loading" }); setStep({ id: "providers" }); }}>Start over</button>
      </div>
    </>}
  </Modal>;
}
