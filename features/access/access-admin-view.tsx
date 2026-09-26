"use client";

import { useEffect, useState } from "react";
import type { DeactivateTenantAccessResult, TenantAccessMember } from "@/core/workspace";
import { workspacePort } from "@/runtime/workspace-services";
import { Modal } from "@/components/ui/modal";
import { Icon } from "@/components/ui/icon";

function roleLabel(role: string): string {
  if (role === "tenant_admin") return "Organization Admin";
  if (role === "accountadmin" || role === "workspace_admin") return "Workspace Admin";
  if (role === "reviewer") return "Review Analyst";
  if (role === "analyst") return "Analyst";
  if (role === "viewer") return "Viewer";
  return role.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function identityLabel(member: TenantAccessMember): string {
  return member.subjects[0]?.subject ?? member.userId;
}

export function AccessAdminView() {
  const [members, setMembers] = useState<TenantAccessMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TenantAccessMember | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeactivateTenantAccessResult | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setMembers(await workspacePort.listAccessMembers());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Access inventory could not be loaded");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void workspacePort.listAccessMembers()
      .then((items) => {
        if (!active) return;
        setMembers(items);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Access inventory could not be loaded");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const openDeactivate = (member: TenantAccessMember) => {
    if (member.isCurrentUser) return;
    setSelected(member);
    setReason("");
    setError(null);
  };

  const deactivate = async () => {
    if (!selected || !reason.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await workspacePort.deactivateAccessMember({ userId: selected.userId, reason: reason.trim() });
      setResult(outcome);
      setMembers((current) => current.filter((member) => member.userId !== selected.userId));
      setSelected(null);
      setReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "User could not be deactivated");
    } finally {
      setBusy(false);
    }
  };

  return <>
    <section className="page-heading"><div><p className="eyebrow">Organization access</p><h1>Access administration</h1><p className="lede">Review active named users and revoke a departing user&apos;s access across every workspace in this organization with one governed action.</p></div><button className="secondary-button" disabled={loading} onClick={() => void load()}><Icon name="clock" size={15}/>Refresh</button></section>

    {error && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Access administration needs attention</strong><span>{error}</span></div></div>}
    {result && <div className="lineage-note tone-success" role="status" aria-label="User deactivated everywhere"><Icon name="check"/><div><strong>User deactivated everywhere</strong><span>{result.revokedMemberships} membership{result.revokedMemberships === 1 ? "" : "s"} revoked · {result.expiredEntitlements} entitlement{result.expiredEntitlements === 1 ? "" : "s"} expired · {result.disabledSubjects} sign-in identit{result.disabledSubjects === 1 ? "y" : "ies"} disabled.</span></div></div>}

    <section className="panel" aria-labelledby="access-members-heading">
      <div className="panel-heading"><div><p className="eyebrow">Active access</p><h2 id="access-members-heading">Organization members</h2></div><span className="table-muted">{members.length} active</span></div>
      <div className="table-card" tabIndex={0} role="region" aria-label="Organization access members"><table className="data-table"><thead><tr><th>Identity</th><th>Workspace roles</th><th>Entitlements</th><th>Action</th></tr></thead><tbody>
        {loading && <tr><td colSpan={4} className="empty-cell">Loading tenant-scoped access…</td></tr>}
        {!loading && members.length === 0 && <tr><td colSpan={4} className="empty-cell">No active named users are available.</td></tr>}
        {!loading && members.map((member) => <tr key={member.userId}>
          <td><strong>{identityLabel(member)}</strong><span className="table-secondary">{member.subjects.map((subject) => subject.authMethod.toUpperCase()).join(" · ")} · {member.userId}</span></td>
          <td>{member.memberships.length ? member.memberships.map((membership) => <span className="table-secondary" key={`${membership.workspaceId}:${membership.roleName}`}><strong>{membership.workspaceName}</strong> · {roleLabel(membership.roleName)}</span>) : <span className="table-muted">No active memberships</span>}</td>
          <td>{member.entitlements.length}</td>
          <td>{member.isCurrentUser ? <span className="table-muted">Current user</span> : <button className="secondary-button button-small" onClick={() => openDeactivate(member)}>Deactivate everywhere</button>}</td>
        </tr>)}
      </tbody></table></div>
    </section>

    <div className="lineage-note"><Icon name="shield"/><div><strong>Offboarding is immediate and tenant-scoped.</strong><span>The confirmation below lists the active memberships and entitlements that will be revoked. The server disables every identity for the selected user and records the operation as one lifecycle audit event.</span></div></div>

    {selected && <Modal label={`Deactivate ${identityLabel(selected)} everywhere`} onClose={() => { if (!busy) setSelected(null); }} width="min(760px, 100%)">
      <div className="dialog-header"><div><p className="eyebrow">Confirm offboarding</p><h2>Deactivate everywhere?</h2><p>This action immediately disables the selected user&apos;s sign-in identities and revokes all access listed below. It does not delete historical audit evidence.</p></div><button className="icon-button" aria-label="Close deactivation confirmation" disabled={busy} onClick={() => setSelected(null)}>×</button></div>
      <div className="dialog-body">
        <div className="lineage-note tone-warning" role="status"><Icon name="alert"/><div><strong>{identityLabel(selected)}</strong><span>{selected.subjects.length} sign-in identit{selected.subjects.length === 1 ? "y" : "ies"} · {selected.memberships.length} membership{selected.memberships.length === 1 ? "" : "s"} · {selected.entitlements.length} active entitlement{selected.entitlements.length === 1 ? "" : "s"}</span></div></div>
        <h3>Workspace access to revoke</h3>
        <div className="table-card" tabIndex={0} role="region" aria-label="Memberships to revoke"><table className="data-table"><thead><tr><th>Workspace</th><th>Role</th></tr></thead><tbody>{selected.memberships.length ? selected.memberships.map((membership) => <tr key={`${membership.workspaceId}:${membership.roleName}`}><td>{membership.workspaceName}<span className="table-secondary">{membership.workspaceId}</span></td><td>{roleLabel(membership.roleName)}</td></tr>) : <tr><td colSpan={2} className="empty-cell">No active memberships.</td></tr>}</tbody></table></div>
        <h3>Entitlements to expire</h3>
        <div className="table-card" tabIndex={0} role="region" aria-label="Entitlements to expire"><table className="data-table"><thead><tr><th>Workspace</th><th>Resource</th><th>Permission</th></tr></thead><tbody>{selected.entitlements.length ? selected.entitlements.map((entitlement) => <tr key={`${entitlement.workspaceId}:${entitlement.resourceType}:${entitlement.resourceId}:${entitlement.permission}`}><td>{entitlement.workspaceName}</td><td>{entitlement.resourceType} · {entitlement.resourceId}</td><td>{entitlement.permission}</td></tr>) : <tr><td colSpan={3} className="empty-cell">No active resource entitlements.</td></tr>}</tbody></table></div>
        <label className="form-field"><span>Offboarding reason</span><textarea value={reason} maxLength={1000} rows={3} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Employment ended; revoke all organization access"/><small>Recorded in the lifecycle audit event.</small></label>
      </div>
      <div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => setSelected(null)}>Cancel</button><button className="primary-button" disabled={busy || !reason.trim()} onClick={() => void deactivate()}>{busy ? "Deactivating…" : "Deactivate everywhere"}</button></div>
    </Modal>}
  </>;
}
