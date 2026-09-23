"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { GovernanceForms, type AdminFeatureFlag } from "@/features/admin/governance-forms";

type PanelState = { loading: boolean; status: number | null; data: unknown; error: string | null };
const EMPTY: PanelState = { loading: true, status: null, data: null, error: null };

async function loadJson(path: string): Promise<PanelState> {
  try {
    const response = await fetch(path, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { loading: false, status: response.status, data: null, error: `Request failed (${response.status})` };
    return { loading: false, status: response.status, data, error: null };
  } catch { return { loading: false, status: null, data: null, error: "Request unavailable" }; }
}

type Panels = [PanelState, PanelState, PanelState, PanelState, PanelState, PanelState];

async function loadPanels(): Promise<Panels> {
  return Promise.all([
    loadJson("/api/v1/admin/readiness"),
    loadJson("/api/v1/admin/feature-flags"),
    loadJson("/api/v1/admin/control-evidence"),
    loadJson("/api/v1/admin/access-review"),
    loadJson("/api/v1/admin/audit?limit=100"),
    loadJson("/api/v1/admin/feature-flags/governance"),
  ]);
}

// The rollout form edits flags in place, so it needs each registered flag's
// current enabled/config/owner/retireBy state from the governance report.
function governanceFlags(state: PanelState): AdminFeatureFlag[] | null {
  if (state.loading || state.error) return null;
  const report = unwrap(state.data) as { flags?: unknown } | null;
  return Array.isArray(report?.flags) ? report.flags as AdminFeatureFlag[] : null;
}

function unwrap(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value) && "data" in value ? (value as { data: unknown }).data : value;
}
function scalar(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return "Structured data";
}

function humanize(key: string): string {
  return key.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function StructuredPanel({ title, state }: { title: string; state: PanelState }) {
  const value = unwrap(state.data);
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
  const rows = Array.isArray(value) ? value : [];
  const ready = !state.loading && !state.error;
  return <section className="admin-card" aria-busy={state.loading}>
    <div className="admin-card-head"><h2>{title}</h2>{ready && Array.isArray(value) && <span className="status-pill">{rows.length} record{rows.length === 1 ? "" : "s"}</span>}</div>
    {state.loading && <div className="skeleton" role="status" aria-label={`Loading ${title}`}><i/><i/><i/></div>}
    {state.error && <p role="alert" className="admin-state error"><Icon name="alert" size={16}/>{state.error}</p>}
    {ready && entries.length > 0 && <dl className="admin-dl">{entries.map(([key, item]) => <div key={key} className="contents"><dt>{humanize(key)}</dt><dd>{scalar(item)}</dd></div>)}</dl>}
    {ready && rows.length > 0 && <div className="admin-records">{rows.slice(0, 12).map((item, index) => <div key={index}>{item && typeof item === "object" ? Object.entries(item as Record<string, unknown>).slice(0, 5).map(([key, cell]) => <span key={key}><strong>{humanize(key)}:</strong> {scalar(cell)}</span>) : scalar(item)}</div>)}</div>}
    {ready && !entries.length && !rows.length && <p className="admin-state">No records returned.</p>}
    {ready && <details><summary>Advanced raw response</summary><pre className="code-block">{JSON.stringify(state.data, null, 2)}</pre></details>}
  </section>;
}

export default function AdminPage() {
  const [readiness, setReadiness] = useState<PanelState>(EMPTY);
  const [flags, setFlags] = useState<PanelState>(EMPTY);
  const [evidence, setEvidence] = useState<PanelState>(EMPTY);
  const [accessReview, setAccessReview] = useState<PanelState>(EMPTY);
  const [audit, setAudit] = useState<PanelState>(EMPTY);
  const [flagGovernance, setFlagGovernance] = useState<PanelState>(EMPTY);

  const applyPanels = useCallback((states: Panels) => {
    setReadiness(states[0]); setFlags(states[1]); setEvidence(states[2]); setAccessReview(states[3]); setAudit(states[4]); setFlagGovernance(states[5]);
  }, []);
  const refresh = useCallback(async () => {
    setReadiness(EMPTY); setFlags(EMPTY); setEvidence(EMPTY); setAccessReview(EMPTY); setAudit(EMPTY); setFlagGovernance(EMPTY);
    applyPanels(await loadPanels());
  }, [applyPanels]);

  useEffect(() => {
    let active = true;
    void loadPanels().then((states) => { if (active) applyPanels(states); });
    return () => { active = false; };
  }, [applyPanels]);

  return <div className="admin-shell">
    <header className="admin-topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">C</span><span>CORVIS</span><small>OPERATIONS</small></div><Link href="/">Back to workspace</Link></header>
    <main className="admin-content">
      <section className="page-heading"><div><p className="eyebrow">Corvis operations</p><h1>Admin Console</h1><p className="lede">Production administration through typed, tenant-scoped and audited workflows. Every mutation is previewed here and re-authorized server-side with <code>admin:manage</code>.</p></div><button type="button" className="secondary-button" onClick={() => void refresh()}><Icon name="clock" size={15}/>Refresh control state</button></section>

      <div className="admin-grid"><StructuredPanel title="Runtime readiness" state={readiness}/><StructuredPanel title="Feature flags" state={flags}/><StructuredPanel title="Control evidence" state={evidence}/></div>
      <div className="admin-grid wide"><StructuredPanel title="Access review" state={accessReview}/><StructuredPanel title="Privileged audit" state={audit}/></div>

      <section className="admin-section-heading"><p className="eyebrow">Privileged operations</p><h2>Governed production workflows</h2><p>Use identifiers from Access review and the relevant incident/change record. Consequential changes require explicit preview/confirmation and return an attributable operation receipt.</p></section>
      <GovernanceForms onSuccess={refresh} featureFlags={governanceFlags(flagGovernance)}/>
    </main>
  </div>;
}
