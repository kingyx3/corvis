"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

type PanelState = {
  loading: boolean;
  status: number | null;
  data: unknown;
  error: string | null;
};

type CommandState = {
  sending: boolean;
  status: number | null;
  result: unknown;
  error: string | null;
};

const EMPTY: PanelState = { loading: true, status: null, data: null, error: null };
const EMPTY_COMMAND: CommandState = { sending: false, status: null, result: null, error: null };

async function loadJson(path: string): Promise<PanelState> {
  try {
    const response = await fetch(path, {
      credentials: "include",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { loading: false, status: response.status, data: null, error: `Request failed (${response.status})` };
    }
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

function Panel({ title, state, height = 320 }: { title: string; state: PanelState; height?: number }) {
  return (
    <section style={{ border: "1px solid #d5d8dc", borderRadius: 12, padding: 20, background: "#fff" }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{title}</h2>
      {state.loading ? <p>Loading…</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {!state.loading && !state.error ? (
        <pre style={{ margin: 0, overflow: "auto", maxHeight: height, fontSize: 12, whiteSpace: "pre-wrap" }}>
          {JSON.stringify(state.data, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}

function JsonCommand({
  title,
  description,
  endpoint,
  buildInitialValue,
  onSuccess,
}: {
  title: string;
  description: string;
  endpoint: string;
  buildInitialValue: (now: Date) => string;
  onSuccess: () => Promise<void>;
}) {
  // The prerendered HTML and the hydrating render show an empty editor; the
  // example is rendered only once hydrated, stamped with the time the page was
  // opened in the browser. `edited` is null until the operator types.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const [openedAt] = useState(() => new Date());
  const [edited, setValue] = useState<string | null>(null);
  const value = edited ?? (hydrated ? buildInitialValue(openedAt) : null);
  const [state, setState] = useState<CommandState>(EMPTY_COMMAND);

  const submit = async () => {
    if (value === null) return;
    let body: unknown;
    try {
      body = JSON.parse(value);
    } catch {
      setState({ sending: false, status: null, result: null, error: "Command must be valid JSON." });
      return;
    }
    setState({ ...EMPTY_COMMAND, sending: true });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        setState({ sending: false, status: response.status, result, error: `Command failed (${response.status}).` });
        return;
      }
      setState({ sending: false, status: response.status, result, error: null });
      await onSuccess();
    } catch {
      setState({ sending: false, status: null, result: null, error: "Command unavailable." });
    }
  };

  return (
    <section style={{ border: "1px solid #d5d8dc", borderRadius: 12, padding: 20, background: "#fff" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>{title}</h2>
      <p style={{ margin: "0 0 12px", color: "#4b5563", fontSize: 13 }}>{description}</p>
      <textarea
        aria-label={`${title} JSON command`}
        value={value ?? ""}
        placeholder="Loading example command…"
        onChange={(event) => setValue(event.target.value)}
        rows={13}
        spellCheck={false}
        style={{ width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 12, padding: 12, borderRadius: 8, border: "1px solid #9ca3af" }}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
        <button
          type="button"
          disabled={state.sending}
          onClick={() => void submit()}
          style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: state.sending ? "wait" : "pointer" }}
        >
          {state.sending ? "Applying…" : "Apply"}
        </button>
        {state.error ? <span role="alert" style={{ color: "#991b1b", fontSize: 13 }}>{state.error}</span> : null}
        {!state.error && state.status ? <span style={{ color: "#166534", fontSize: 13 }}>Applied ({state.status})</span> : null}
      </div>
      {state.result ? (
        <pre style={{ margin: "12px 0 0", overflow: "auto", maxHeight: 180, fontSize: 11, whiteSpace: "pre-wrap", background: "#f9fafb", padding: 10, borderRadius: 8 }}>
          {JSON.stringify(state.result, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}

// Example commands are built in the browser after hydration, not at
// module scope: module-scope timestamps are baked in at prerender time
// (hydration mismatch, and a stale validity window for the support grant).
const identityCommand = () => JSON.stringify({
  operation: "sync",
  authMethod: "oidc",
  subject: "oidc-subject",
  userId: "00000000-0000-4000-8000-000000000001",
  eventKey: "uat-user-change-001",
  memberships: [{ workspaceId: "00000000-0000-4000-8000-000000000002", roleName: "analyst" }],
  reason: "UAT access provisioning",
}, null, 2);

const entitlementCommand = (now: Date) => JSON.stringify({
  kind: "resource_entitlement",
  operation: "grant",
  subjectUserId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  resourceType: "fund",
  resourceId: "fund-id",
  permission: "read",
  validFrom: now.toISOString(),
  validUntil: null,
  reason: "UAT fund access",
}, null, 2);

const dataRightCommand = (now: Date) => JSON.stringify({
  kind: "data_right",
  operation: "set",
  resourceType: "workspace",
  resourceId: "00000000-0000-4000-8000-000000000002",
  clientVisible: true,
  internalAnalyticsAllowed: false,
  modelTrainingAllowed: false,
  redistributionAllowed: true,
  sourceDocumentAccessAllowed: false,
  effectiveFrom: now.toISOString(),
  effectiveTo: null,
  contractReference: "UAT approval",
  reason: "Enable approved UAT delivery rights",
}, null, 2);

const supportCommand = (now: Date) => JSON.stringify({
  operation: "grant",
  authMethod: "oidc",
  subject: "support-oidc-subject",
  userId: "00000000-0000-4000-8000-000000000003",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  roleName: "viewer",
  purpose: "Investigate UAT customer-reported issue",
  approvalReference: "UAT-support-approval-001",
  validFrom: now.toISOString(),
  validUntil: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
  reason: "Approved temporary support access",
}, null, 2);

export default function AdminPage() {
  const [readiness, setReadiness] = useState<PanelState>(EMPTY);
  const [flags, setFlags] = useState<PanelState>(EMPTY);
  const [evidence, setEvidence] = useState<PanelState>(EMPTY);
  const [accessReview, setAccessReview] = useState<PanelState>(EMPTY);
  const [audit, setAudit] = useState<PanelState>(EMPTY);

  const applyPanels = useCallback((states: [PanelState, PanelState, PanelState, PanelState, PanelState]) => {
    setReadiness(states[0]);
    setFlags(states[1]);
    setEvidence(states[2]);
    setAccessReview(states[3]);
    setAudit(states[4]);
  }, []);

  const refresh = useCallback(async () => {
    setReadiness(EMPTY);
    setFlags(EMPTY);
    setEvidence(EMPTY);
    setAccessReview(EMPTY);
    setAudit(EMPTY);
    applyPanels(await loadPanels());
  }, [applyPanels]);

  useEffect(() => {
    let active = true;
    void loadPanels().then((states) => {
      if (active) applyPanels(states);
    });
    return () => {
      active = false;
    };
  }, [applyPanels]);

  return (
    <main style={{ minHeight: "100vh", background: "#f4f6f8", color: "#111827", padding: "32px clamp(16px, 4vw, 56px)" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start", marginBottom: 28 }}>
        <div>
          <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>Corvis Operations</p>
          <h1 style={{ margin: 0, fontSize: 32 }}>Admin Console</h1>
          <p style={{ maxWidth: 760, color: "#4b5563" }}>
            Launch-critical UAT administration. Every command is re-authorized server-side with admin:manage; identity, access-policy and support changes are tenant-scoped and audited.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #9ca3af", background: "#fff", cursor: "pointer" }}>
          Refresh
        </button>
      </header>

      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", marginBottom: 24 }}>
        <Panel title="Runtime readiness" state={readiness} />
        <Panel title="Feature flags" state={flags} />
        <Panel title="Control evidence" state={evidence} />
      </div>

      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", marginBottom: 24 }}>
        <Panel title="Access review" state={accessReview} height={520} />
        <Panel title="Privileged audit" state={audit} height={520} />
      </div>

      <h2 style={{ margin: "30px 0 8px", fontSize: 24 }}>UAT access operations</h2>
      <p style={{ margin: "0 0 18px", color: "#4b5563", maxWidth: 850 }}>
        Replace the example identifiers with values from Access review. Use identity operation <code>reactivate</code> only for a deliberately disabled human identity; ordinary <code>sync</code> remains unable to revive one.
      </p>
      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
        <JsonCommand
          title="Identity lifecycle"
          description="Sync roles/workspaces, disable an identity, or explicitly reactivate a disabled identity. Event keys make retries replay-safe."
          endpoint="/api/v1/admin/identity-lifecycle"
          buildInitialValue={identityCommand}
          onSuccess={refresh}
        />
        <JsonCommand
          title="Resource entitlement"
          description="Grant or revoke a fund/document entitlement with optional effective expiry. Revocation never broadens access."
          endpoint="/api/v1/admin/access-policy"
          buildInitialValue={entitlementCommand}
          onSuccess={refresh}
        />
        <JsonCommand
          title="Data rights"
          description="Set or revoke the contractual policy used by authorization for visibility, source access, analytics, training and redistribution."
          endpoint="/api/v1/admin/access-policy"
          buildInitialValue={dataRightCommand}
          onSuccess={refresh}
        />
        <JsonCommand
          title="Temporary support access"
          description="Grant a time-bounded existing role to an active support identity with explicit purpose and approval reference, or revoke by supportGrantId."
          endpoint="/api/v1/admin/support-access"
          buildInitialValue={supportCommand}
          onSuccess={refresh}
        />
      </div>
    </main>
  );
}
