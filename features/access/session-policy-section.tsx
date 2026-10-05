"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  parseSessionPolicyUpdate,
  SESSION_ACTIVITY_RETENTION_MINUTES,
  SESSION_POLICY_MAX_REASON_LENGTH,
  SESSION_POLICY_MIN_REASON_LENGTH,
  sessionLimitLabel,
  SessionPolicyValidationError,
  type SessionPolicyView,
} from "@/core/session-policy";
import { Icon } from "@/components/ui/icon";
import { getSessionPolicy, saveSessionPolicy, sessionPolicyErrorMessage, signOutEverywhere } from "@/features/access/session-policy-api";
import { displayDate } from "@/lib/display-format";

type Load = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: SessionPolicyView };
type Message = { tone: "success" | "error"; text: string };

const METHOD_LABEL = { oidc: "OpenID Connect", saml: "SAML" } as const;
const PROVIDER_STATUS_LABEL = { pending: "Setup in progress", active: "Active", disabled: "Disabled" } as const;

function time(value: string): string { return displayDate(value, { timeStyle: "short" }); }

/** A limit field: a number of minutes, or "No limit". The text is only parsed on submit, by the same rules the API applies. */
type Field = { none: boolean; minutes: string };
function fieldOf(value: number | null): Field { return value === null ? { none: true, minutes: "" } : { none: false, minutes: String(value) }; }
function valueOf(field: Field): number | null { return field.none ? null : field.minutes.trim() === "" ? Number.NaN : Number(field.minutes); }

/**
 * Sign-in and session policy for Organization Admins (F7, #263), on the access self-service page: the read-only identity
 * provider and SCIM setup, the idle timeout and maximum session length (within the bounds Corvis sets), and "sign out
 * everywhere" for a named person. Every change is audited and every Organization Admin is notified by email.
 */
export function SessionPolicySection() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [idle, setIdle] = useState<Field>({ none: true, minutes: "" });
  const [max, setMax] = useState<Field>({ none: true, minutes: "" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [signOutReason, setSignOutReason] = useState("");
  const ids = { idle: useId(), idleHint: useId(), max: useId(), maxHint: useId(), reason: useId(), signOutReason: useId(), error: useId() };
  const latest = useRef(0);

  const apply = useCallback((value: SessionPolicyView) => {
    setState({ kind: "ready", value });
    setIdle(fieldOf(value.policy.idleTimeoutMinutes));
    setMax(fieldOf(value.policy.maxSessionMinutes));
  }, []);

  const refresh = useCallback(async () => {
    const current = ++latest.current;
    try {
      const value = await getSessionPolicy();
      if (current === latest.current) apply(value);
    } catch { /* the previous values stay on screen; the action's own message explains what happened */ }
  }, [apply]);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++latest.current;
    void getSessionPolicy(controller.signal)
      .then((value) => { if (current === latest.current) apply(value); })
      .catch(() => { if (current === latest.current && !controller.signal.aborted) setState({ kind: "error" }); });
    return () => controller.abort();
  }, [reloadKey, apply]);

  const view = state.kind === "ready" ? state.value : null;
  const policy = view?.policy;

  // The same validation the API applies, so the form and the server cannot disagree about what is allowed.
  let change: ReturnType<typeof parseSessionPolicyUpdate> | null = null;
  let problem: string | null = null;
  if (policy) {
    try {
      change = parseSessionPolicyUpdate({ idleTimeoutMinutes: valueOf(idle), maxSessionMinutes: valueOf(max), expectedVersion: policy.version, reason });
    } catch (error) {
      problem = error instanceof SessionPolicyValidationError ? error.code : "invalid_request";
    }
  }
  const limitProblem = problem === "invalid_idle_timeout" || problem === "invalid_max_session" || problem === "idle_exceeds_max_session" ? problem : null;
  const changed = Boolean(policy && change && (change.idleTimeoutMinutes !== policy.idleTimeoutMinutes || change.maxSessionMinutes !== policy.maxSessionMinutes));

  const save = async () => {
    if (!change || !changed || busy !== null) return;
    setBusy("save");
    setMessage(null);
    try {
      await saveSessionPolicy(change);
      setReason("");
      setMessage({ tone: "success", text: "Session policy saved. It applies to the next request each session makes, and every Organization Admin has been notified." });
      await refresh();
    } catch (failure) {
      setMessage({ tone: "error", text: sessionPolicyErrorMessage(failure, "The session policy could not be saved. Try again.") });
      await refresh();
    } finally { setBusy(null); }
  };

  const signOut = async (userId: string, label: string) => {
    setBusy(`signout:${userId}`);
    setMessage(null);
    try {
      const result = await signOutEverywhere(userId, signOutReason.trim());
      setSigningOut(null);
      setSignOutReason("");
      setMessage({ tone: "success", text: `${label} was signed out of every session (${result.revokedSessions} ended). They can sign in again. Every Organization Admin has been notified.` });
      await refresh();
    } catch (failure) {
      setMessage({ tone: "error", text: sessionPolicyErrorMessage(failure, "That person could not be signed out. Try again.") });
      await refresh();
    } finally { setBusy(null); }
  };

  const signOutReasonValid = signOutReason.trim().length >= SESSION_POLICY_MIN_REASON_LENGTH && signOutReason.trim().length <= SESSION_POLICY_MAX_REASON_LENGTH;

  return <section className="panel" aria-labelledby="session-policy-heading">
    <div className="panel-heading"><div><p className="eyebrow">Sign-in and sessions</p><h2 id="session-policy-heading">Sign-in and session policy</h2></div></div>
    <p className="lede">See how your organization signs in to Corvis, set how long a session may sit idle and how long it may last, and sign a person out of every session at once. Corvis sets the limits these settings must stay within.</p>
    {state.kind === "loading" && <p className="empty-cell" role="status">Loading sign-in settings…</p>}
    {state.kind === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Sign-in settings are unavailable</strong><span>Nothing was changed. <button type="button" className="text-button" onClick={() => { setState({ kind: "loading" }); setReloadKey((key) => key + 1); }}>Try again</button></span></div></div>}
    <div className="data-issues-status" role="status" aria-live="polite">{message?.tone === "success" ? message.text : ""}</div>
    {message?.tone === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Something went wrong</strong><span>{message.text}</span></div></div>}
    {view && policy && <>
      <h3 className="retention-holds-heading">Identity provider</h3>
      <div className="table-card" tabIndex={0} role="region" aria-label="Identity provider and provisioning"><table className="data-table">
        <thead><tr><th>Setting</th><th>Current value</th></tr></thead>
        <tbody>
          <tr><td><strong>Sign-in protocol</strong></td><td>{METHOD_LABEL[view.identityProvider.protocol]}</td></tr>
          <tr><td><strong>Identity provider</strong></td><td>{view.identityProvider.issuer ? <code>{view.identityProvider.issuer}</code> : <span className="table-muted">Not configured</span>}{view.identityProvider.source === "global" && view.identityProvider.issuer ? <span className="table-muted"> · shared sign-in provider, not recorded for this organization</span> : null}</td></tr>
          {view.identityProvider.source === "tenant" && <>
            <tr><td><strong>Provider audience</strong></td><td>{view.identityProvider.audience ? <code>{view.identityProvider.audience}</code> : <span className="table-muted">Not set</span>}</td></tr>
            <tr><td><strong>Provider status</strong></td><td>{view.identityProvider.status ? PROVIDER_STATUS_LABEL[view.identityProvider.status] : "Unknown"} · {view.identityProvider.tokenBindingEnforced ? "tokens are accepted only from this issuer and audience" : "tokens are not restricted to this issuer and audience"}</td></tr>
          </>}
          <tr><td><strong>Verified email domains</strong></td><td>{view.verifiedDomains.length
            ? <>{view.verifiedDomains.map((domain, index) => <span key={domain.domain}>{index > 0 ? ", " : ""}<code>{domain.domain}</code></span>)} · new invitations and provisioned users must use one of these</>
            : <span className="table-muted">None verified · new invitations are not restricted by email domain</span>}</td></tr>
          <tr><td><strong>Users by sign-in method</strong></td><td>{view.signInMethods.length ? view.signInMethods.map((method) => `${METHOD_LABEL[method.authMethod]}: ${method.users}`).join(" · ") : <span className="table-muted">No active users</span>}</td></tr>
          <tr><td><strong>SCIM provisioning</strong></td><td>{view.scim.configured
            ? <>{view.scim.enabled ? "Enabled" : "Disabled"} · {view.scim.activeUsers} active {view.scim.activeUsers === 1 ? "user" : "users"}{view.scim.defaultWorkspaceName ? ` · new users join ${view.scim.defaultWorkspaceName}` : ""}{view.scim.defaultRole ? ` as ${view.scim.defaultRole}` : ""}{view.scim.updatedAt ? ` · updated ${time(view.scim.updatedAt)}` : ""}</>
            : <span className="table-muted">Not set up</span>}</td></tr>
        </tbody>
      </table></div>
      <p className="table-muted">Identity-provider, verified-domain and SCIM setup is done with Corvis support, so it is read-only here. Contact Corvis support to change it.</p>

      <h3 className="retention-holds-heading">Session limits</h3>
      <form className="data-export-request" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-describedby={limitProblem ? ids.error : undefined}>
        <fieldset className="form-field" aria-describedby={ids.idleHint}>
          <legend>Idle timeout</legend>
          <label htmlFor={ids.idle}><span>Minutes without activity before a session ends</span></label>
          <input id={ids.idle} className="input-control" type="number" inputMode="numeric" step={1} min={view.bounds.idleTimeoutMinutes.min} max={view.bounds.idleTimeoutMinutes.max}
            value={idle.minutes} disabled={idle.none || busy !== null} onChange={(event) => setIdle({ none: false, minutes: event.target.value })} />
          <label className="check-field"><input type="checkbox" checked={idle.none} disabled={busy !== null} onChange={(event) => setIdle(event.target.checked ? { none: true, minutes: "" } : { none: false, minutes: String(view.bounds.idleTimeoutMinutes.max) })} /><span>No idle limit</span></label>
          <small id={ids.idleHint}>{view.bounds.idleTimeoutMinutes.min} to {view.bounds.idleTimeoutMinutes.max} minutes. Now: {sessionLimitLabel(policy.idleTimeoutMinutes)}.</small>
        </fieldset>
        <fieldset className="form-field" aria-describedby={ids.maxHint}>
          <legend>Maximum session length</legend>
          <label htmlFor={ids.max}><span>Minutes after which a session ends, however active</span></label>
          <input id={ids.max} className="input-control" type="number" inputMode="numeric" step={1} min={view.bounds.maxSessionMinutes.min} max={view.bounds.maxSessionMinutes.max}
            value={max.minutes} disabled={max.none || busy !== null} onChange={(event) => setMax({ none: false, minutes: event.target.value })} />
          <label className="check-field"><input type="checkbox" checked={max.none} disabled={busy !== null} onChange={(event) => setMax(event.target.checked ? { none: true, minutes: "" } : { none: false, minutes: String(view.bounds.maxSessionMinutes.max) })} /><span>No maximum length</span></label>
          <small id={ids.maxHint}>{view.bounds.maxSessionMinutes.min} to {view.bounds.maxSessionMinutes.max} minutes. Now: {sessionLimitLabel(policy.maxSessionMinutes)}.</small>
        </fieldset>
        {limitProblem && <p id={ids.error} className="lineage-note tone-warning" role="alert">{sessionPolicyErrorMessage({ code: limitProblem }, "")}</p>}
        <label className="form-field" htmlFor={ids.reason}><span>Why are you changing this?</span>
          <textarea id={ids.reason} className="input-control" rows={2} maxLength={SESSION_POLICY_MAX_REASON_LENGTH} value={reason} disabled={busy !== null} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Align with our information security policy" />
        </label>
        <p className="table-muted">A session that passes a limit ends and the person signs in again at your identity provider. Limits are measured from when Corvis first sees a session, and need your identity provider to send a session id (<code>sid</code>). {policy.updatedAt ? `Last changed ${time(policy.updatedAt)}${policy.updatedBy ? ` by ${policy.updatedBy}` : ""}.` : "No limit has been set yet."}</p>
        <p className="table-muted">Corvis keeps a record of each session, and when it was last used, for {SESSION_ACTIVITY_RETENTION_MINUTES / 1440} days after its last use, to apply these limits and to sign people out. Older records are deleted automatically; the record holds only a sign-in identity and times, never data from your work.</p>
        <button type="submit" className="primary-button" disabled={!change || !changed || busy !== null}>{busy === "save" ? "Saving…" : "Save session policy"}</button>
      </form>

      <h3 className="retention-holds-heading">Sign out everywhere</h3>
      <p className="table-muted">Ends every session Corvis has seen for a person, effective on their next request. They keep their access and can sign in again; to remove access, deactivate them in Access administration.</p>
      {view.members.length === 0
        ? <p className="empty-cell">No active members.</p>
        : <div className="table-card" tabIndex={0} role="region" aria-label="Members and their sessions"><table className="data-table">
          <thead><tr><th>Person</th><th>Active sessions</th><th>Action</th></tr></thead>
          <tbody>{view.members.map((member) => <tr key={member.userId}>
            <td>{member.label}{member.isCurrentUser && <span className="table-secondary"> (you)</span>}</td>
            <td>{member.activeSessions}</td>
            <td>{member.isCurrentUser
              ? <span className="table-muted">Use your own sign-out</span>
              : signingOut === member.userId
                ? <div className="form-field" role="group" aria-label={`Confirm signing out ${member.label}`}>
                  <label htmlFor={ids.signOutReason}><span>Why are you signing {member.label} out?</span></label>
                  <textarea id={ids.signOutReason} className="input-control" rows={2} maxLength={SESSION_POLICY_MAX_REASON_LENGTH} value={signOutReason} disabled={busy !== null} onChange={(event) => setSignOutReason(event.target.value)} />
                  <div className="dialog-actions">
                    <button type="button" className="primary-button button-small" disabled={!signOutReasonValid || busy !== null} onClick={() => void signOut(member.userId, member.label)}>{busy === `signout:${member.userId}` ? "Signing out…" : "Confirm sign out everywhere"}</button>
                    <button type="button" className="secondary-button button-small" disabled={busy !== null} onClick={() => { setSigningOut(null); setSignOutReason(""); }}>Cancel</button>
                  </div>
                </div>
                : <button type="button" className="secondary-button button-small" aria-label={`Sign out ${member.label} everywhere`} disabled={busy !== null} onClick={() => { setSigningOut(member.userId); setSignOutReason(""); }}>Sign out everywhere</button>}</td>
          </tr>)}</tbody></table></div>}
    </>}
  </section>;
}
