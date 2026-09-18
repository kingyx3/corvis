"use client";

import type { ReadinessReport, WorkspaceSession } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";

export function AdminView({ session, readiness }: { session: WorkspaceSession; readiness: ReadinessReport | null }) {
  return <>
    <section className="page-heading"><div><p className="eyebrow">ADMINISTRATION</p><h1>Workspace controls</h1><p className="lede">Identity, tenant isolation and enterprise control posture for this workspace.</p></div><div className="answer-mode"><Icon name="shield" size={15}/>{readiness?.demoMode ? "Demo controls" : "Production controls"}</div></section>
    <div className="review-summary"><div><span>Tenant</span><strong>{session.tenantId}</strong></div><div><span>Roles</span><strong>{session.roles.join(", ")}</strong></div><div><span>Environment</span><strong>{readiness?.environment || "Loading"}</strong></div><div><span>Control mode</span><strong>{readiness?.demoMode ? "Demo" : "Enforced"}</strong></div></div>
    <div className="table-card"><table className="data-table"><thead><tr><th>Control</th><th>Status</th><th>Implementation</th></tr></thead><tbody>{(readiness?.controls || []).map((control) => <tr key={control.id}><td><strong>{control.id}</strong></td><td><span className={`status-pill ${control.status === "configured" ? "published" : "review"}`}>{control.status}</span></td><td>{control.detail}</td></tr>)}</tbody></table></div>
    <div className="lineage-note"><Icon name="shield"/><div><strong>Administrative operations are audited.</strong><span>Entitlement changes, exports, source reads, review actions and retention/deletion operations emit tenant-scoped audit events.</span></div></div>
  </>;
}
