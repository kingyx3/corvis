"use client";

import { useEffect, useState } from "react";
import type { WorkspaceMembershipSummary } from "@/core/enterprise";
import type { WorkspaceIdentity } from "@/core/workspace";
import { workspacePort } from "@/runtime/workspace-services";
import { WORKSPACE_CONTEXT_KEY } from "@/lib/workspace-context";

export function WorkspaceSwitcher({ identity }: { identity: WorkspaceIdentity | null }) {
  const [memberships, setMemberships] = useState<WorkspaceMembershipSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void workspacePort.listMyWorkspaces().then((items) => { if (active) setMemberships(items); }).catch(() => { if (active) setError("Workspace choices are unavailable. Reload to retry."); });
    // All page state (dialogs, evidence, search, analytics and async responses)
    // belongs to the old workspace. A document reload is an intentional boundary.
    const changed = (event: StorageEvent) => { if (event.key === WORKSPACE_CONTEXT_KEY) window.location.reload(); };
    window.addEventListener("storage", changed);
    return () => { active = false; window.removeEventListener("storage", changed); };
  }, []);

  const select = async (workspaceId: string) => {
    if (!identity?.tenantId || busy || workspaceId === identity.workspaceId || !memberships.some((item) => item.workspaceId === workspaceId)) return;
    setBusy(true); setError("");
    try {
      const context = { tenantId: identity.tenantId, workspaceId };
      if (process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE !== "true") {
        const base = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") ?? "";
        const response = await fetch(`${base}/api/v1/me`, { credentials: "include", cache: "no-store", headers: { "x-corvis-tenant": context.tenantId, "x-corvis-workspace": context.workspaceId } });
        if (!response.ok) throw new Error("Workspace access could not be verified. Your current workspace is unchanged.");
        const body = await response.json() as { data?: WorkspaceIdentity };
        if (body.data?.tenantId !== context.tenantId || body.data.workspaceId !== context.workspaceId) throw new Error("The server did not select this workspace.");
      }
      window.localStorage.setItem(WORKSPACE_CONTEXT_KEY, JSON.stringify(context));
      window.location.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Workspace could not be selected."); setBusy(false); }
  };
  return <div className="sidebar-section"><p>WORKSPACE</p>
    {memberships.length > 1 && identity?.tenantId ? <div className="profile"><span className="workspace-dot" aria-hidden="true">{(identity.workspaceDisplayName ?? identity.tenantDisplayName ?? "W")[0].toUpperCase()}</span><div className="form-field"><select aria-label="Current workspace" disabled={busy} value={identity.workspaceId ?? ""} onChange={(event) => void select(event.target.value)}>{memberships.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.workspaceDisplayName ?? item.workspaceId}</option>)}</select><small>{identity.tenantDisplayName}</small></div></div>
      : <div className="profile"><span className="workspace-dot" aria-hidden="true">{(identity?.workspaceDisplayName ?? "W")[0].toUpperCase()}</span><span><strong>{identity?.workspaceDisplayName ?? "Current workspace"}</strong><small>{identity?.tenantDisplayName ?? "Tenant-scoped"}</small></span></div>}
    {busy && <p role="status">Switching workspace…</p>}{error && <div><p role="alert">{error}</p>{!identity && <button className="secondary-button" onClick={() => { window.localStorage.removeItem(WORKSPACE_CONTEXT_KEY); window.location.reload(); }}>Reset workspace selection</button>}</div>}
  </div>;
}
