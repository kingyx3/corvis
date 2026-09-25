"use client";

import { useState, type ReactNode } from "react";
import { Modal } from "@/components/ui/modal";

type SubmitState = { sending: boolean; status?: number; result?: unknown; error?: string };
type FormProps = { onSuccess: () => Promise<void> };
type CommandBody = Record<string, unknown>;
/** A feature flag as reported by GET /api/v1/admin/feature-flags/governance. */
export type AdminFeatureFlag = {
  key: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  owner?: string;
  retireBy?: string;
  registered: boolean;
  retired: boolean;
  description?: string;
};
const lifecycleRoles = ["tenant_admin", "accountadmin", "reviewer", "analyst", "viewer"] as const;
type LifecycleRole = (typeof lifecycleRoles)[number];
const lifecycleRoleLabels: Record<LifecycleRole, string> = {
  tenant_admin: "Organization Admin",
  accountadmin: "Workspace Admin",
  reviewer: "Review Analyst",
  analyst: "Analyst",
  viewer: "Viewer",
};

function hoursFromNow(hours: number) { return new Date(Date.now() + Math.max(1, hours) * 3_600_000).toISOString(); }
function list(value: string) { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function dateIso(value: string) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; }
function localInput(iso: string | undefined) {
  const parsed = iso ? new Date(iso) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function Select({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: ReactNode }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>;
}

function Text({ value, onChange, placeholder, type = "text" }: { value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return <input className="input-control" type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}/>;
}

function GovernedMutation({ title, description, endpoint, body, valid, onSuccess, children, method = "POST", destructive = false }: {
  title: string;
  description: string;
  endpoint: string;
  /** A function is evaluated when the preview opens, so time-relative values are computed then, not at page load. */
  body: CommandBody | (() => CommandBody);
  valid: boolean;
  onSuccess: () => Promise<void>;
  children: ReactNode;
  method?: "POST" | "PUT";
  destructive?: boolean;
}) {
  // The previewed command is frozen when the preview opens and is exactly what
  // Apply sends, including the endpoint (which may carry target ids).
  const [preview, setPreview] = useState<{ endpoint: string; body: CommandBody } | null>(null);
  const [state, setState] = useState<SubmitState>({ sending: false });

  const openPreview = () => setPreview({ endpoint, body: typeof body === "function" ? body() : body });

  const submit = async () => {
    if (!valid || !preview) return;
    setState({ sending: true });
    try {
      const response = await fetch(preview.endpoint, {
        method,
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(preview.body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        setState({ sending: false, status: response.status, result, error: `Command failed (${response.status}).` });
        return;
      }
      setState({ sending: false, status: response.status, result });
      setPreview(null);
      await onSuccess();
    } catch {
      setState({ sending: false, error: "Command unavailable." });
    }
  };

  return <section className="admin-card">
    <h2>{title}</h2>
    <p className="admin-card-description">{description}</p>
    {children}
    <div className="admin-card-actions">
      <button type="button" className={destructive ? "danger-button" : "primary-button"} disabled={!valid || state.sending} onClick={openPreview}>Review change</button>
      {state.error && <span role="alert" className="inline-status error">{state.error}</span>}
      {!state.error && state.status && <span role="status" className="inline-status success">Applied and audited ({state.status})</span>}
      {!valid && !state.error && !state.status && <span className="field-hint">Complete the required fields to review.</span>}
    </div>
    {state.result != null && <details><summary>Operation receipt</summary><pre className="code-block">{JSON.stringify(state.result, null, 2)}</pre></details>}
    {preview && <Modal label={`Confirm ${title}`} onClose={() => setPreview(null)}><div className="dialog-body">
      <h2>{destructive ? "Confirm destructive change" : "Confirm privileged change"}</h2>
      <p>The exact command below will be re-authorized and audited by the server.</p>
      <dl className="preview-dl">
        <div className="form-field"><dt>Request</dt><dd><pre className="code-block">{`${method} ${preview.endpoint}`}</pre></dd></div>
        <div className="form-field"><dt>Body</dt><dd><pre className="code-block preview-body">{Object.keys(preview.body).length ? JSON.stringify(preview.body, null, 2) : "(empty — the target is identified by the endpoint path)"}</pre></dd></div>
      </dl>
      <div className="dialog-actions">
        <button className="secondary-button" data-autofocus={destructive ? "" : undefined} onClick={() => setPreview(null)}>Cancel</button>
        <button className={destructive ? "danger-button" : "primary-button"} disabled={state.sending} onClick={() => void submit()}>{state.sending ? "Applying…" : destructive ? "Apply destructive change" : "Apply privileged change"}</button>
      </div>
    </div></Modal>}
  </section>;
}

function IdentityLifecycle({ onSuccess }: FormProps) {
  const [operation, setOperation] = useState("sync");
  const [authMethod, setAuthMethod] = useState("oidc");
  const [subject, setSubject] = useState("");
  const [userId, setUserId] = useState("");
  const [eventKey, setEventKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [roleName, setRoleName] = useState("analyst");
  const [reason, setReason] = useState("");
  const body = { operation, authMethod, subject, userId, eventKey, memberships: operation === "disable" ? [] : [{ workspaceId, roleName }], reason };
  const valid = Boolean(subject && userId && eventKey && reason && (operation === "disable" || workspaceId));
  return <GovernedMutation title="Identity lifecycle" description="Sync, disable or explicitly reactivate a human identity. Role labels are presentation-safe; the submitted command retains the stable lifecycle-role identifier." endpoint="/api/v1/admin/identity-lifecycle" body={body} valid={valid} onSuccess={onSuccess} destructive={operation === "disable"}>
    <div className="form-grid">
      <label className="form-field">Operation<Select value={operation} onChange={setOperation}><option value="sync">Sync</option><option value="disable">Disable</option><option value="reactivate">Reactivate</option></Select></label>
      <label className="form-field">Authentication<Select value={authMethod} onChange={setAuthMethod}><option value="oidc">OIDC</option><option value="saml">SAML</option></Select></label>
      <label className="form-field">Subject<Text value={subject} onChange={setSubject} placeholder="IdP subject"/></label>
      <label className="form-field">User ID<Text value={userId} onChange={setUserId} placeholder="UUID"/></label>
      <label className="form-field">Event key<Text value={eventKey} onChange={setEventKey} placeholder="change/event key"/></label>
      {operation !== "disable" && <><label className="form-field">Workspace ID<Text value={workspaceId} onChange={setWorkspaceId} placeholder="UUID"/></label><label className="form-field">Role<Select value={roleName} onChange={setRoleName}>{lifecycleRoles.map((role) => <option key={role} value={role}>{lifecycleRoleLabels[role]}</option>)}</Select></label></>}
      <label className="form-field">Reason<Text value={reason} onChange={setReason}/></label>
    </div>
  </GovernedMutation>;
}

function Entitlement({ onSuccess }: FormProps) {
  const [operation, setOperation] = useState("grant");
  const [subjectUserId, setSubjectUserId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [resourceType, setResourceType] = useState("fund");
  const [resourceId, setResourceId] = useState("");
  const [permission, setPermission] = useState("read");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  // validFrom is omitted: the server makes the entitlement effective at apply time.
  const body = { kind: "resource_entitlement", operation, subjectUserId, workspaceId, resourceType, resourceId, permission, validUntil: validUntil ? dateIso(validUntil) : null, reason };
  return <GovernedMutation title="Resource entitlement" description="Grant or revoke an effective-dated fund/document entitlement." endpoint="/api/v1/admin/access-policy" body={body} valid={Boolean(subjectUserId && workspaceId && resourceId && reason)} onSuccess={onSuccess} destructive={operation === "revoke"}>
    <div className="form-grid">
      <label className="form-field">Operation<Select value={operation} onChange={setOperation}><option value="grant">Grant</option><option value="revoke">Revoke</option></Select></label>
      <label className="form-field">User ID<Text value={subjectUserId} onChange={setSubjectUserId}/></label>
      <label className="form-field">Workspace ID<Text value={workspaceId} onChange={setWorkspaceId}/></label>
      <label className="form-field">Resource type<Select value={resourceType} onChange={setResourceType}><option value="fund">Fund</option><option value="document">Document</option></Select></label>
      <label className="form-field">Resource ID<Text value={resourceId} onChange={setResourceId}/></label>
      <label className="form-field">Permission<Select value={permission} onChange={setPermission}><option>read</option><option>review</option><option>publish</option><option>admin</option></Select></label>
      <label className="form-field">Valid until (optional)<Text type="datetime-local" value={validUntil} onChange={setValidUntil}/></label>
      <label className="form-field">Reason<Text value={reason} onChange={setReason}/></label>
    </div>
  </GovernedMutation>;
}

function DataRights({ onSuccess }: FormProps) {
  const [operation, setOperation] = useState("set");
  const [resourceType, setResourceType] = useState("workspace");
  const [resourceId, setResourceId] = useState("");
  const [contractReference, setContractReference] = useState("");
  const [reason, setReason] = useState("");
  const [rights, setRights] = useState({ clientVisible: true, internalAnalyticsAllowed: false, modelTrainingAllowed: false, redistributionAllowed: false, sourceDocumentAccessAllowed: false });
  // effectiveFrom is omitted: the server makes the right effective at apply time.
  const body = { kind: "data_right", operation, resourceType, resourceId, ...rights, effectiveTo: null, contractReference, reason };
  return <GovernedMutation title="Contractual data rights" description="Set or revoke visibility, source access, analytics, training and redistribution rights." endpoint="/api/v1/admin/access-policy" body={body} valid={Boolean(resourceId && reason)} onSuccess={onSuccess} destructive={operation === "revoke"}>
    <div className="form-grid">
      <label className="form-field">Operation<Select value={operation} onChange={setOperation}><option value="set">Set</option><option value="revoke">Revoke</option></Select></label>
      <label className="form-field">Resource type<Select value={resourceType} onChange={setResourceType}><option value="workspace">Workspace</option><option value="fund">Fund</option><option value="document">Document</option></Select></label>
      <label className="form-field">Resource ID<Text value={resourceId} onChange={setResourceId}/></label>
      <label className="form-field">Contract reference<Text value={contractReference} onChange={setContractReference}/></label>
      {Object.entries(rights).map(([key, value]) => <label key={key} className="check-field"><input type="checkbox" checked={value} onChange={() => setRights((current) => ({ ...current, [key]: !current[key as keyof typeof current] }))}/><span className="capitalize">{key.replaceAll(/([A-Z])/g, " $1").toLowerCase()}</span></label>)}
      <label className="form-field">Reason<Text value={reason} onChange={setReason}/></label>
    </div>
  </GovernedMutation>;
}

function SupportAccess({ onSuccess }: FormProps) {
  const [operation, setOperation] = useState("grant");
  const [grantId, setGrantId] = useState("");
  const [authMethod, setAuthMethod] = useState("oidc");
  const [subject, setSubject] = useState("");
  const [userId, setUserId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [roleName, setRoleName] = useState("viewer");
  const [purpose, setPurpose] = useState("");
  const [approvalReference, setApprovalReference] = useState("");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(4);
  // Built when the preview opens: the grant starts when applied (server
  // default) and validUntil is computed from the chosen duration at preview.
  const body = () => operation === "revoke" ? { operation, supportGrantId: grantId, reason } : { operation, authMethod, subject, userId, workspaceId, roleName, purpose, approvalReference, validUntil: hoursFromNow(hours), reason };
  const valid = operation === "revoke" ? Boolean(grantId && reason) : Boolean(subject && userId && workspaceId && purpose && approvalReference && reason && hours > 0);
  return <GovernedMutation title="Temporary support access" description="Grant a time-bounded existing lifecycle role with approval evidence, or revoke an active grant. Human-facing labels are translated to stable role identifiers in the command." endpoint="/api/v1/admin/support-access" body={body} valid={valid} onSuccess={onSuccess} destructive={operation === "revoke"}>
    <div className="form-grid">
      <label className="form-field">Operation<Select value={operation} onChange={setOperation}><option value="grant">Grant</option><option value="revoke">Revoke</option></Select></label>
      {operation === "revoke" ? <label className="form-field">Support grant ID<Text value={grantId} onChange={setGrantId}/></label> : <>
        <label className="form-field">Authentication<Select value={authMethod} onChange={setAuthMethod}><option value="oidc">OIDC</option><option value="saml">SAML</option></Select></label>
        <label className="form-field">Subject<Text value={subject} onChange={setSubject}/></label>
        <label className="form-field">User ID<Text value={userId} onChange={setUserId}/></label>
        <label className="form-field">Workspace ID<Text value={workspaceId} onChange={setWorkspaceId}/></label>
        <label className="form-field">Role<Select value={roleName} onChange={setRoleName}>{lifecycleRoles.map((role) => <option key={role} value={role}>{lifecycleRoleLabels[role]}</option>)}</Select></label>
        <label className="form-field">Duration (hours, from when applied)<input className="input-control" type="number" min={1} max={24} value={hours} onChange={(event) => setHours(Number(event.target.value))}/></label>
        <label className="form-field">Purpose<Text value={purpose} onChange={setPurpose}/></label>
        <label className="form-field">Approval reference<Text value={approvalReference} onChange={setApprovalReference}/></label>
      </>}
      <label className="form-field">Reason<Text value={reason} onChange={setReason}/></label>
    </div>
  </GovernedMutation>;
}

function FeatureFlag({ onSuccess, flags }: FormProps & { flags: AdminFeatureFlag[] | null }) {
  const selectable = (flags ?? []).filter((flag) => flag.registered && !flag.retired);
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [owner, setOwner] = useState("");
  const [retireBy, setRetireBy] = useState("");
  const current = selectable.find((flag) => flag.key === key);
  const choose = (next: string) => {
    const flag = selectable.find((item) => item.key === next);
    setKey(next);
    setEnabled(flag?.enabled ?? false);
    setOwner(flag?.owner ?? "");
    setRetireBy(localInput(flag?.retireBy));
  };
  // The datetime input is minute-precision; keep the stored instant unless edited.
  const retireByIso = current?.retireBy && retireBy === localInput(current.retireBy) ? current.retireBy : dateIso(retireBy);
  // setFeatureFlag replaces the stored configuration, so the current rollout
  // configuration is sent back unchanged rather than wiped.
  const config = current?.config ?? {};
  return <GovernedMutation title="Feature flag rollout" description="Change registered rollout state with mandatory ownership and retirement metadata. Existing rollout configuration is preserved." endpoint="/api/v1/admin/feature-flags" method="PUT" body={{ key, enabled, config, owner, retireBy: retireByIso }} valid={Boolean(current && owner && retireByIso)} onSuccess={onSuccess}>
    <div className="form-grid">
      <label className="form-field">Flag key<Select value={key} onChange={choose}><option value="">{flags == null ? "Flag registry unavailable" : selectable.length ? "Choose a registered flag" : "No active registered flags"}</option>{selectable.map((flag) => <option key={flag.key} value={flag.key}>{flag.key}</option>)}</Select>{current?.description && <span className="field-hint">{current.description}</span>}</label>
      <label className="check-field"><input type="checkbox" checked={enabled} disabled={!current} onChange={(event) => setEnabled(event.target.checked)}/>Enabled</label>
      <label className="form-field">Owner<Text value={owner} onChange={setOwner}/></label>
      <label className="form-field">Retire by<Text type="datetime-local" value={retireBy} onChange={setRetireBy}/></label>
      {current && <div className="form-field span-all">Rollout configuration (preserved)<pre className="code-block">{JSON.stringify(config, null, 2)}</pre></div>}
    </div>
  </GovernedMutation>;
}

function SessionRevocation({ onSuccess }: FormProps) {
  const [authMethod, setAuthMethod] = useState("oidc");
  const [subject, setSubject] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [reason, setReason] = useState("");
  return <GovernedMutation title="Session revocation" description="Immediately revoke one authenticated session without altering broader identity state." endpoint="/api/v1/admin/session-revocations" body={{ authMethod, subject, sessionId, reason }} valid={Boolean(subject && sessionId && reason)} onSuccess={onSuccess} destructive>
    <div className="form-grid">
      <label className="form-field">Authentication<Select value={authMethod} onChange={setAuthMethod}><option value="oidc">OIDC</option><option value="saml">SAML</option><option value="service_account">Service account</option></Select></label>
      <label className="form-field">Subject<Text value={subject} onChange={setSubject}/></label>
      <label className="form-field">Session ID<Text value={sessionId} onChange={setSessionId}/></label>
      <label className="form-field">Reason<Text value={reason} onChange={setReason}/></label>
    </div>
  </GovernedMutation>;
}

function DataCorrection({ onSuccess }: FormProps) {
  const [action, setAction] = useState("open");
  const [incidentId, setIncidentId] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [fundId, setFundId] = useState("");
  const [reportPeriod, setReportPeriod] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [correctionIntent, setCorrectionIntent] = useState("");
  const [replacementSnapshotId, setReplacementSnapshotId] = useState("");
  const [replacementSnapshotVersion, setReplacementSnapshotVersion] = useState(1);
  const body = action === "open" ? { action, idempotencyKey, fundId, reportPeriod, rootCause, correctionIntent } : action === "replay" ? { action, incidentId } : { action, incidentId, replacementSnapshotId, replacementSnapshotVersion, evidence: { operatorNote: "Resolved through governed admin workflow" } };
  const valid = action === "open" ? Boolean(idempotencyKey && fundId && reportPeriod && rootCause && correctionIntent) : action === "replay" ? Boolean(incidentId) : Boolean(incidentId && replacementSnapshotId && replacementSnapshotVersion > 0);
  return <GovernedMutation title="Data correction & replay" description="Open a governed correction, trigger bounded replay, or resolve against a separately versioned replacement snapshot." endpoint="/api/v1/admin/data-corrections" body={body} valid={valid} onSuccess={onSuccess}>
    <div className="form-grid">
      <label className="form-field">Action<Select value={action} onChange={setAction}><option value="open">Open incident</option><option value="replay">Replay correction</option><option value="resolve">Resolve incident</option></Select></label>
      {action === "open" ? <><label className="form-field">Idempotency key<Text value={idempotencyKey} onChange={setIdempotencyKey}/></label><label className="form-field">Fund ID<Text value={fundId} onChange={setFundId}/></label><label className="form-field">Report period<Text value={reportPeriod} onChange={setReportPeriod} placeholder="2026-Q3"/></label><label className="form-field">Root cause<Text value={rootCause} onChange={setRootCause}/></label><label className="form-field">Correction intent<Text value={correctionIntent} onChange={setCorrectionIntent}/></label></> : <><label className="form-field">Incident ID<Text value={incidentId} onChange={setIncidentId}/></label>{action === "resolve" && <><label className="form-field">Replacement snapshot ID<Text value={replacementSnapshotId} onChange={setReplacementSnapshotId}/></label><label className="form-field">Replacement version<input className="input-control" type="number" min={1} value={replacementSnapshotVersion} onChange={(event) => setReplacementSnapshotVersion(Number(event.target.value))}/></label></>}</>}
    </div>
  </GovernedMutation>;
}

function Deletion({ onSuccess }: FormProps) {
  const [action, setAction] = useState("request");
  const [dataClasses, setDataClasses] = useState("");
  const [targetKind, setTargetKind] = useState("none");
  const [targetIds, setTargetIds] = useState("");
  const [requestId, setRequestId] = useState("");
  const [reason, setReason] = useState("");
  const scope = { dataClasses: list(dataClasses), documentIds: targetKind === "document" ? list(targetIds) : [], fundIds: targetKind === "fund" ? list(targetIds) : [], subjectIds: targetKind === "subject" ? list(targetIds) : [] };
  const endpoint = action === "request" ? "/api/v1/admin/deletion-requests" : `/api/v1/admin/deletion-requests/${encodeURIComponent(requestId)}/execute`;
  const valid = action === "request" ? Boolean(scope.dataClasses.length && reason && (targetKind === "none" || targetIds.trim())) : Boolean(requestId);
  return <GovernedMutation title="Retention-aware deletion" description="Create or execute a deletion request scoped by retention-policy data classes and optional entity identifiers." endpoint={endpoint} body={action === "request" ? { scope, reason } : {}} valid={valid} onSuccess={onSuccess} destructive>
    <div className="form-grid">
      <label className="form-field">Action<Select value={action} onChange={setAction}><option value="request">Create request</option><option value="execute">Execute request</option></Select></label>
      {action === "request" ? <><label className="form-field">Data classes<Text value={dataClasses} onChange={setDataClasses} placeholder="financials, source_documents"/><span className="field-hint">Comma-separated classes must have effective retention coverage.</span></label><label className="form-field">Target scope<Select value={targetKind} onChange={setTargetKind}><option value="none">All records in named data classes</option><option value="document">Document IDs</option><option value="fund">Fund IDs</option><option value="subject">Subject IDs</option></Select></label>{targetKind !== "none" && <label className="form-field">Target IDs<Text value={targetIds} onChange={setTargetIds} placeholder="comma-separated IDs"/></label>}<label className="form-field">Reason<Text value={reason} onChange={setReason}/></label></> : <label className="form-field">Deletion request ID<Text value={requestId} onChange={setRequestId}/></label>}
    </div>
  </GovernedMutation>;
}

export function GovernanceForms({ onSuccess, featureFlags }: FormProps & { featureFlags: AdminFeatureFlag[] | null }) {
  return <div className="admin-grid wide">
    <IdentityLifecycle onSuccess={onSuccess}/>
    <Entitlement onSuccess={onSuccess}/>
    <DataRights onSuccess={onSuccess}/>
    <SupportAccess onSuccess={onSuccess}/>
    <FeatureFlag onSuccess={onSuccess} flags={featureFlags}/>
    <SessionRevocation onSuccess={onSuccess}/>
    <DataCorrection onSuccess={onSuccess}/>
    <Deletion onSuccess={onSuccess}/>
  </div>;
}
