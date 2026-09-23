"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type PanelState = { loading: boolean; status: number | null; data: unknown; error: string | null };
type CommandState = { sending: boolean; status: number | null; result: unknown; error: string | null };
const EMPTY: PanelState = { loading: true, status: null, data: null, error: null };
const EMPTY_COMMAND: CommandState = { sending: false, status: null, result: null, error: null };
const card = { border: "1px solid #d5d8dc", borderRadius: 12, padding: 20, background: "#fff" } as const;
const input = { width: "100%", boxSizing: "border-box" as const, border: "1px solid #9ca3af", borderRadius: 8, padding: "9px 10px", background: "#fff" };
const label = { display: "grid", gap: 6, fontSize: 13, color: "#374151" } as const;
const grid = { display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" } as const;

async function loadJson(path: string): Promise<PanelState> {
  try {
    const response = await fetch(path, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { loading: false, status: response.status, data: null, error: `Request failed (${response.status})` };
    return { loading: false, status: response.status, data, error: null };
  } catch {
    return { loading: false, status: null, data: null, error: "Request unavailable" };
  }
}

async function loadPanels(): Promise<[PanelState, PanelState, PanelState, PanelState, PanelState]> {
  return Promise.all([
    loadJson("/api/v1/admin/readiness"),
    loadJson("/api/v1/admin/feature-flags"),
    loadJson("/api/v1/admin/control-evidence"),
    loadJson("/api/v1/admin/access-review"),
    loadJson("/api/v1/admin/audit?limit=100"),
  ]);
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "data" in value) return (value as { data: unknown }).data;
  return value;
}

function scalar(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return "Structured data";
}

function StructuredPanel({ title, state }: { title: string; state: PanelState }) {
  const value = unwrap(state.data);
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
  const rows = Array.isArray(value) ? value : [];
  return <section style={card}>
    <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{title}</h2>
    {state.loading && <p>Loading…</p>}
    {state.error && <p role="alert" style={{ color: "#991b1b" }}>{state.error}</p>}
    {!state.loading && !state.error && entries.length > 0 && <dl style={{ display: "grid", gridTemplateColumns: "minmax(130px, 1fr) 2fr", gap: "9px 14px", margin: 0 }}>{entries.map(([key, item]) => <div key={key} style={{ display: "contents" }}><dt style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{key.replaceAll("_", " ")}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{scalar(item)}</dd></div>)}</dl>}
    {!state.loading && !state.error && rows.length > 0 && <div style={{ display: "grid", gap: 8 }}>{rows.slice(0, 12).map((item, index) => <div key={index} style={{ borderTop: index ? "1px solid #e5e7eb" : undefined, paddingTop: index ? 8 : 0 }}>{item && typeof item === "object" ? Object.entries(item as Record<string, unknown>).slice(0, 4).map(([key, cell]) => <span key={key} style={{ display: "block", fontSize: 13 }}><strong>{key.replaceAll("_", " ")}:</strong> {scalar(cell)}</span>) : scalar(item)}</div>)}</div>}
    {!state.loading && !state.error && !entries.length && !rows.length && <p>No records returned.</p>}
    {!state.loading && !state.error && <details style={{ marginTop: 14 }}><summary>Advanced raw response</summary><pre style={{ overflow: "auto", maxHeight: 320, fontSize: 11, whiteSpace: "pre-wrap", background: "#f9fafb", padding: 10, borderRadius: 8 }}>{JSON.stringify(state.data, null, 2)}</pre></details>}
  </section>;
}

function MutationCard({ title, description, endpoint, body, valid, onSuccess, children }: {
  title: string; description: string; endpoint: string; body: Record<string, unknown>; valid: boolean; onSuccess: () => Promise<void>; children: React.ReactNode;
}) {
  const [preview, setPreview] = useState(false);
  const [state, setState] = useState<CommandState>(EMPTY_COMMAND);
  const submit = async () => {
    if (!valid) return;
    setState({ ...EMPTY_COMMAND, sending: true });
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => null);
      if (!response.ok) { setState({ sending: false, status: response.status, result, error: `Command failed (${response.status}).` }); return; }
      setState({ sending: false, status: response.status, result, error: null });
      setPreview(false);
      await onSuccess();
    } catch { setState({ sending: false, status: null, result: null, error: "Command unavailable." }); }
  };
  return <section style={card}>
    <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>{title}</h2><p style={{ margin: "0 0 16px", color: "#4b5563", fontSize: 13 }}>{description}</p>
    {children}
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
      <button type="button" disabled={!valid || state.sending} onClick={() => setPreview(true)} style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid #111827", background: valid ? "#111827" : "#9ca3af", color: "#fff" }}>Review change</button>
      {state.error && <span role="alert" style={{ color: "#991b1b", fontSize: 13 }}>{state.error}</span>}
      {!state.error && state.status && <span role="status" style={{ color: "#166534", fontSize: 13 }}>Applied and audited ({state.status})</span>}
    </div>
    {state.result && <details style={{ marginTop: 12 }}><summary>Operation receipt</summary><pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>{JSON.stringify(state.result, null, 2)}</pre></details>}
    {preview && <div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(15,23,42,.5)", display: "grid", placeItems: "center", padding: 20 }} onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(false); }}><section role="dialog" aria-modal="true" aria-label={`Confirm ${title}`} style={{ ...card, width: "min(620px, 100%)" }}><h2 style={{ marginTop: 0 }}>Confirm privileged change</h2><p>Review the exact tenant-scoped command before applying it. The server will re-authorize and audit the operation.</p><pre style={{ maxHeight: "45vh", overflow: "auto", whiteSpace: "pre-wrap", background: "#f9fafb", padding: 12, borderRadius: 8, fontSize: 12 }}>{JSON.stringify(body, null, 2)}</pre><div style={{ display: "flex", gap: 10 }}><button disabled={state.sending} onClick={() => void submit()} style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid #991b1b", background: "#991b1b", color: "white" }}>{state.sending ? "Applying…" : "Apply privileged change"}</button><button onClick={() => setPreview(false)} style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid #9ca3af", background: "white" }}>Cancel</button></div></section></div>}
  </section>;
}

function IdentityLifecycleForm({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [operation, setOperation] = useState<"sync" | "disable" | "reactivate">("sync");
  const [authMethod, setAuthMethod] = useState<"oidc" | "saml">("oidc");
  const [subject, setSubject] = useState(""); const [userId, setUserId] = useState(""); const [eventKey, setEventKey] = useState(""); const [workspaceId, setWorkspaceId] = useState(""); const [roleName, setRoleName] = useState("analyst"); const [reason, setReason] = useState("");
  const memberships = operation === "disable" || !workspaceId ? [] : [{ workspaceId, roleName }];
  const body = { operation, authMethod, subject, userId, eventKey, memberships, reason };
  const valid = Boolean(subject.trim() && userId.trim() && eventKey.trim() && reason.trim() && (operation === "disable" || workspaceId.trim()));
  return <MutationCard title="Identity lifecycle" description="Sync, disable or explicitly reactivate a human identity. Disable is deliberately membership-empty; retries are keyed by event key." endpoint="/api/v1/admin/identity-lifecycle" body={body} valid={valid} onSuccess={onSuccess}><div style={grid}><label style={label}>Operation<select style={input} value={operation} onChange={(e) => setOperation(e.target.value as typeof operation)}><option value="sync">Sync</option><option value="disable">Disable</option><option value="reactivate">Reactivate</option></select></label><label style={label}>Authentication<select style={input} value={authMethod} onChange={(e) => setAuthMethod(e.target.value as typeof authMethod)}><option value="oidc">OIDC</option><option value="saml">SAML</option></select></label><label style={label}>Subject<input style={input} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="IdP subject"/></label><label style={label}>User ID<input style={input} value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="UUID"/></label><label style={label}>Event key<input style={input} value={eventKey} onChange={(e) => setEventKey(e.target.value)} placeholder="change-ticket-or-event-key"/></label>{operation !== "disable" && <><label style={label}>Workspace ID<input style={input} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="UUID"/></label><label style={label}>Role<select style={input} value={roleName} onChange={(e) => setRoleName(e.target.value)}><option>tenant_admin</option><option>workspace_admin</option><option>reviewer</option><option>analyst</option><option>viewer</option></select></label></>}<label style={label}>Reason<input style={input} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this change is required"/></label></div></MutationCard>;
}

function EntitlementForm({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [operation, setOperation] = useState<"grant" | "revoke">("grant"); const [subjectUserId, setSubjectUserId] = useState(""); const [workspaceId, setWorkspaceId] = useState(""); const [resourceType, setResourceType] = useState<"fund" | "document">("fund"); const [resourceId, setResourceId] = useState(""); const [permission, setPermission] = useState("read"); const [validUntil, setValidUntil] = useState(""); const [reason, setReason] = useState("");
  const [validFrom] = useState(() => new Date().toISOString());
  const body = { kind: "resource_entitlement", operation, subjectUserId, workspaceId, resourceType, resourceId, permission, validFrom, validUntil: validUntil || null, reason };
  const valid = Boolean(subjectUserId && workspaceId && resourceId && reason);
  return <MutationCard title="Resource entitlement" description="Grant or revoke a fund/document entitlement. Effective dates narrow access and never substitute for role authorization." endpoint="/api/v1/admin/access-policy" body={body} valid={valid} onSuccess={onSuccess}><div style={grid}><label style={label}>Operation<select style={input} value={operation} onChange={(e) => setOperation(e.target.value as typeof operation)}><option value="grant">Grant</option><option value="revoke">Revoke</option></select></label><label style={label}>User ID<input style={input} value={subjectUserId} onChange={(e) => setSubjectUserId(e.target.value)} placeholder="UUID"/></label><label style={label}>Workspace ID<input style={input} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="UUID"/></label><label style={label}>Resource type<select style={input} value={resourceType} onChange={(e) => setResourceType(e.target.value as typeof resourceType)}><option value="fund">Fund</option><option value="document">Document</option></select></label><label style={label}>Resource ID<input style={input} value={resourceId} onChange={(e) => setResourceId(e.target.value)} /></label><label style={label}>Permission<select style={input} value={permission} onChange={(e) => setPermission(e.target.value)}><option>read</option><option>review</option><option>publish</option><option>admin</option></select></label><label style={label}>Valid until (optional)<input style={input} type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label><label style={label}>Reason<input style={input} value={reason} onChange={(e) => setReason(e.target.value)} /></label></div></MutationCard>;
}

function DataRightsForm({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [operation, setOperation] = useState<"set" | "revoke">("set"); const [resourceType, setResourceType] = useState<"workspace" | "fund" | "document">("workspace"); const [resourceId, setResourceId] = useState(""); const [contractReference, setContractReference] = useState(""); const [reason, setReason] = useState(""); const [rights, setRights] = useState({ clientVisible: true, internalAnalyticsAllowed: false, modelTrainingAllowed: false, redistributionAllowed: false, sourceDocumentAccessAllowed: false }); const [effectiveFrom] = useState(() => new Date().toISOString());
  const body = { kind: "data_right", operation, resourceType, resourceId, ...rights, effectiveFrom, effectiveTo: null, contractReference, reason };
  const valid = Boolean(resourceId && reason);
  const toggle = (key: keyof typeof rights) => setRights((current) => ({ ...current, [key]: !current[key] }));
  return <MutationCard title="Contractual data rights" description="Set or revoke the policy that gates client visibility, source access, analytics, training and redistribution." endpoint="/api/v1/admin/access-policy" body={body} valid={valid} onSuccess={onSuccess}><div style={grid}><label style={label}>Operation<select style={input} value={operation} onChange={(e) => setOperation(e.target.value as typeof operation)}><option value="set">Set</option><option value="revoke">Revoke</option></select></label><label style={label}>Resource type<select style={input} value={resourceType} onChange={(e) => setResourceType(e.target.value as typeof resourceType)}><option value="workspace">Workspace</option><option value="fund">Fund</option><option value="document">Document</option></select></label><label style={label}>Resource ID<input style={input} value={resourceId} onChange={(e) => setResourceId(e.target.value)} /></label><label style={label}>Contract reference<input style={input} value={contractReference} onChange={(e) => setContractReference(e.target.value)} /></label>{Object.entries(rights).map(([key, checked]) => <label key={key} style={{ ...label, display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={checked} onChange={() => toggle(key as keyof typeof rights)}/>{key.replaceAll(/([A-Z])/g, " $1")}</label>)}<label style={label}>Reason<input style={input} value={reason} onChange={(e) => setReason(e.target.value)} /></label></div></MutationCard>;
}

function SupportAccessForm({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [operation, setOperation] = useState<"grant" | "revoke">("grant"); const [supportGrantId, setSupportGrantId] = useState(""); const [authMethod, setAuthMethod] = useState<"oidc" | "saml">("oidc"); const [subject, setSubject] = useState(""); const [userId, setUserId] = useState(""); const [workspaceId, setWorkspaceId] = useState(""); const [roleName, setRoleName] = useState("viewer"); const [purpose, setPurpose] = useState(""); const [approvalReference, setApprovalReference] = useState(""); const [reason, setReason] = useState(""); const [hours, setHours] = useState(4);
  const now = useMemo(() => new Date(), [operation, subject, userId, workspaceId, roleName, purpose, approvalReference, reason, hours]);
  const body = operation === "revoke" ? { operation, supportGrantId, reason } : { operation, authMethod, subject, userId, workspaceId, roleName, purpose, approvalReference, validFrom: now.toISOString(), validUntil: new Date(now.getTime() + Math.max(1, hours) * 60 * 60 * 1000).toISOString(), reason };
  const valid = operation === "revoke" ? Boolean(supportGrantId && reason) : Boolean(subject && userId && workspaceId && purpose && approvalReference && reason && hours > 0);
  return <MutationCard title="Temporary support access" description="Grant an existing role for a bounded support purpose with explicit approval and expiry, or revoke an existing support grant." endpoint="/api/v1/admin/support-access" body={body} valid={valid} onSuccess={onSuccess}><div style={grid}><label style={label}>Operation<select style={input} value={operation} onChange={(e) => setOperation(e.target.value as typeof operation)}><option value="grant">Grant</option><option value="revoke">Revoke</option></select></label>{operation === "revoke" ? <label style={label}>Support grant ID<input style={input} value={supportGrantId} onChange={(e) => setSupportGrantId(e.target.value)} placeholder="UUID"/></label> : <><label style={label}>Authentication<select style={input} value={authMethod} onChange={(e) => setAuthMethod(e.target.value as typeof authMethod)}><option value="oidc">OIDC</option><option value="saml">SAML</option></select></label><label style={label}>Support subject<input style={input} value={subject} onChange={(e) => setSubject(e.target.value)} /></label><label style={label}>User ID<input style={input} value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="UUID"/></label><label style={label}>Workspace ID<input style={input} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="UUID"/></label><label style={label}>Role<select style={input} value={roleName} onChange={(e) => setRoleName(e.target.value)}><option>viewer</option><option>analyst</option><option>reviewer</option><option>workspace_admin</option><option>tenant_admin</option></select></label><label style={label}>Duration (hours)<input style={input} type="number" min={1} max={24} value={hours} onChange={(e) => setHours(Number(e.target.value))}/></label><label style={label}>Purpose<input style={input} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></label><label style={label}>Approval reference<input style={input} value={approvalReference} onChange={(e) => setApprovalReference(e.target.value)} /></label></>}<label style={label}>Reason<input style={input} value={reason} onChange={(e) => setReason(e.target.value)} /></label></div></MutationCard>;
}

export default function AdminPage() {
  const [readiness, setReadiness] = useState<PanelState>(EMPTY); const [flags, setFlags] = useState<PanelState>(EMPTY); const [evidence, setEvidence] = useState<PanelState>(EMPTY); const [accessReview, setAccessReview] = useState<PanelState>(EMPTY); const [audit, setAudit] = useState<PanelState>(EMPTY);
  const applyPanels = useCallback((states: [PanelState, PanelState, PanelState, PanelState, PanelState]) => { setReadiness(states[0]); setFlags(states[1]); setEvidence(states[2]); setAccessReview(states[3]); setAudit(states[4]); }, []);
  const refresh = useCallback(async () => { setReadiness(EMPTY); setFlags(EMPTY); setEvidence(EMPTY); setAccessReview(EMPTY); setAudit(EMPTY); applyPanels(await loadPanels()); }, [applyPanels]);
  useEffect(() => { let active = true; void loadPanels().then((states) => { if (active) applyPanels(states); }); return () => { active = false; }; }, [applyPanels]);

  return <main style={{ minHeight: "100vh", background: "#f4f6f8", color: "#111827", padding: "32px clamp(16px, 4vw, 56px)" }}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start", marginBottom: 28, flexWrap: "wrap" }}><div><p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>Corvis Operations</p><h1 style={{ margin: 0, fontSize: 32 }}>Admin Console</h1><p style={{ maxWidth: 780, color: "#4b5563" }}>Production administration through typed, tenant-scoped and audited workflows. Every mutation is previewed here and re-authorized server-side with <code>admin:manage</code>.</p></div><button type="button" onClick={() => void refresh()} style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #9ca3af", background: "#fff", cursor: "pointer" }}>Refresh control state</button></header>

    <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", marginBottom: 24 }}><StructuredPanel title="Runtime readiness" state={readiness}/><StructuredPanel title="Feature flags" state={flags}/><StructuredPanel title="Control evidence" state={evidence}/></div>
    <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", marginBottom: 30 }}><StructuredPanel title="Access review" state={accessReview}/><StructuredPanel title="Privileged audit" state={audit}/></div>

    <section style={{ marginBottom: 18 }}><p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: ".12em" }}>PRIVILEGED OPERATIONS</p><h2 style={{ margin: "0 0 6px", fontSize: 24 }}>Governed access workflows</h2><p style={{ margin: 0, color: "#4b5563", maxWidth: 900 }}>Use identifiers from Access review. Consequential changes require an explicit preview/confirmation step and return an attributable operation receipt.</p></section>
    <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}><IdentityLifecycleForm onSuccess={refresh}/><EntitlementForm onSuccess={refresh}/><DataRightsForm onSuccess={refresh}/><SupportAccessForm onSuccess={refresh}/></div>
  </main>;
}
