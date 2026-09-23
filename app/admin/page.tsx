"use client";

import { useCallback, useEffect, useState } from "react";
import { GovernanceForms, type AdminFeatureFlag } from "@/features/admin/governance-forms";

type PanelState = { loading: boolean; status: number | null; data: unknown; error: string | null };
const EMPTY: PanelState = { loading: true, status: null, data: null, error: null };
const card = { border: "1px solid #d5d8dc", borderRadius: 12, padding: 20, background: "#fff" } as const;

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

function StructuredPanel({ title, state }: { title: string; state: PanelState }) {
  const value = unwrap(state.data);
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
  const rows = Array.isArray(value) ? value : [];
  return <section style={card}>
    <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{title}</h2>
    {state.loading && <p>Loading…</p>}
    {state.error && <p role="alert" style={{ color: "#991b1b" }}>{state.error}</p>}
    {!state.loading && !state.error && entries.length > 0 && <dl style={{ display: "grid", gridTemplateColumns: "minmax(130px, 1fr) 2fr", gap: "9px 14px", margin: 0 }}>{entries.map(([key, item]) => <div key={key} style={{ display: "contents" }}><dt style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{key.replaceAll("_", " ")}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{scalar(item)}</dd></div>)}</dl>}
    {!state.loading && !state.error && rows.length > 0 && <div style={{ display: "grid", gap: 8 }}>{rows.slice(0, 12).map((item, index) => <div key={index} style={{ borderTop: index ? "1px solid #e5e7eb" : undefined, paddingTop: index ? 8 : 0 }}>{item && typeof item === "object" ? Object.entries(item as Record<string, unknown>).slice(0, 5).map(([key, cell]) => <span key={key} style={{ display: "block", fontSize: 13 }}><strong>{key.replaceAll("_", " ")}:</strong> {scalar(cell)}</span>) : scalar(item)}</div>)}</div>}
    {!state.loading && !state.error && !entries.length && !rows.length && <p>No records returned.</p>}
    {!state.loading && !state.error && <details style={{ marginTop: 14 }}><summary>Advanced raw response</summary><pre style={{ overflow: "auto", maxHeight: 320, fontSize: 11, whiteSpace: "pre-wrap", background: "#f9fafb", padding: 10, borderRadius: 8 }}>{JSON.stringify(state.data, null, 2)}</pre></details>}
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

  return <main style={{ minHeight: "100vh", background: "#f4f6f8", color: "#111827", padding: "32px clamp(16px, 4vw, 56px)" }}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start", marginBottom: 28, flexWrap: "wrap" }}>
      <div><p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>Corvis Operations</p><h1 style={{ margin: 0, fontSize: 32 }}>Admin Console</h1><p style={{ maxWidth: 820, color: "#4b5563" }}>Production administration through typed, tenant-scoped and audited workflows. Every mutation is previewed here and re-authorized server-side with <code>admin:manage</code>.</p></div>
      <button type="button" onClick={() => void refresh()} style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #9ca3af", background: "#fff", cursor: "pointer" }}>Refresh control state</button>
    </header>

    <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", marginBottom: 24 }}><StructuredPanel title="Runtime readiness" state={readiness}/><StructuredPanel title="Feature flags" state={flags}/><StructuredPanel title="Control evidence" state={evidence}/></div>
    <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", marginBottom: 30 }}><StructuredPanel title="Access review" state={accessReview}/><StructuredPanel title="Privileged audit" state={audit}/></div>

    <section style={{ marginBottom: 18 }}><p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: ".12em" }}>PRIVILEGED OPERATIONS</p><h2 style={{ margin: "0 0 6px", fontSize: 24 }}>Governed production workflows</h2><p style={{ margin: 0, color: "#4b5563", maxWidth: 940 }}>Use identifiers from Access review and the relevant incident/change record. Consequential changes require explicit preview/confirmation and return an attributable operation receipt.</p></section>
    <GovernanceForms onSuccess={refresh} featureFlags={governanceFlags(flagGovernance)}/>
  </main>;
}
