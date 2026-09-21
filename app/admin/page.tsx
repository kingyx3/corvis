"use client";

import { useCallback, useEffect, useState } from "react";

type PanelState = {
  loading: boolean;
  status: number | null;
  data: unknown;
  error: string | null;
};

const EMPTY: PanelState = { loading: true, status: null, data: null, error: null };

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

async function loadPanels(): Promise<[PanelState, PanelState, PanelState]> {
  return Promise.all([
    loadJson("/api/v1/admin/readiness"),
    loadJson("/api/v1/admin/feature-flags"),
    loadJson("/api/v1/admin/control-evidence"),
  ]);
}

function Panel({ title, state }: { title: string; state: PanelState }) {
  return (
    <section style={{ border: "1px solid #d5d8dc", borderRadius: 12, padding: 20, background: "#fff" }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{title}</h2>
      {state.loading ? <p>Loading…</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {!state.loading && !state.error ? (
        <pre style={{ margin: 0, overflow: "auto", maxHeight: 320, fontSize: 12, whiteSpace: "pre-wrap" }}>
          {JSON.stringify(state.data, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}

export default function AdminPage() {
  const [readiness, setReadiness] = useState<PanelState>(EMPTY);
  const [flags, setFlags] = useState<PanelState>(EMPTY);
  const [evidence, setEvidence] = useState<PanelState>(EMPTY);

  const refresh = useCallback(async () => {
    setReadiness(EMPTY);
    setFlags(EMPTY);
    setEvidence(EMPTY);
    const [nextReadiness, nextFlags, nextEvidence] = await loadPanels();
    setReadiness(nextReadiness);
    setFlags(nextFlags);
    setEvidence(nextEvidence);
  }, []);

  useEffect(() => {
    let active = true;
    void loadPanels().then(([nextReadiness, nextFlags, nextEvidence]) => {
      if (!active) return;
      setReadiness(nextReadiness);
      setFlags(nextFlags);
      setEvidence(nextEvidence);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main style={{ minHeight: "100vh", background: "#f4f6f8", color: "#111827", padding: "32px clamp(16px, 4vw, 56px)" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start", marginBottom: 28 }}>
        <div>
          <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>Corvis Operations</p>
          <h1 style={{ margin: 0, fontSize: 32 }}>Admin Console</h1>
          <p style={{ maxWidth: 720, color: "#4b5563" }}>
            Production readiness, feature governance and control evidence. API authorization remains enforced server-side with the admin:manage permission.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #9ca3af", background: "#fff", cursor: "pointer" }}>
          Refresh
        </button>
      </header>

      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Panel title="Runtime readiness" state={readiness} />
        <Panel title="Feature flags" state={flags} />
        <Panel title="Control evidence" state={evidence} />
      </div>
    </main>
  );
}
