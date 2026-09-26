import { randomUUID } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type {
  DeactivateTenantAccessResult,
  TenantAccessEntitlement,
  TenantAccessMember,
  TenantAccessMembership,
} from "../../core/workspace.ts";
import { getServerConfig } from "./config.ts";
import {
  identityLifecycleRepository,
  type HumanAuthMethod,
  type IdentityLifecycleRepository,
} from "./identity-lifecycle.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export class TenantAccessError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "TenantAccessError";
    this.code = code;
    this.status = status;
  }
}

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function humanAuthMethod(value: string): HumanAuthMethod | undefined {
  return value === "oidc" || value === "saml" ? value : undefined;
}

function memberMap(subjectRows: PostgresRow[], identity: RequestIdentity): Map<string, TenantAccessMember> {
  const members = new Map<string, TenantAccessMember>();
  for (const row of subjectRows) {
    const userId = text(row, "user_id");
    const authMethod = humanAuthMethod(text(row, "auth_method"));
    const subject = text(row, "subject");
    if (!userId || !authMethod || !subject) continue;
    const current = members.get(userId) ?? {
      userId,
      subjects: [],
      memberships: [],
      entitlements: [],
      isCurrentUser: false,
    };
    if (!current.subjects.some((entry) => entry.authMethod === authMethod && entry.subject === subject)) {
      current.subjects.push({ authMethod, subject });
    }
    if (identity.authMethod === authMethod && identity.subject === subject) current.isCurrentUser = true;
    members.set(userId, current);
  }
  return members;
}

/**
 * Tenant-admin customer projection used only for access administration.
 * It intentionally returns no credentials, sessions, support grants or data-right
 * clauses: only the exact memberships and active entitlements that C14 will revoke.
 */
export async function listTenantAccessMembers(
  identity: RequestIdentity,
  db: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<TenantAccessMember[]> {
  const [subjects, memberships, entitlements] = await Promise.all([
    db.query(`select user_id::text,auth_method,subject
      from corvis_control.identity_subject
      where tenant_id=$1::uuid
        and status='active'
        and auth_method in ('oidc','saml')
      order by user_id,auth_method,subject`, [identity.tenantId]),
    db.query(`select m.user_id::text,m.workspace_id::text,w.display_name as workspace_name,m.role_name
      from corvis_control.membership m
      join corvis_control.workspace w
        on w.tenant_id=m.tenant_id and w.workspace_id=m.workspace_id
      where m.tenant_id=$1::uuid
        and m.status='active'
        and m.valid_from <= now()
        and (m.valid_until is null or m.valid_until > now())
      order by m.user_id,w.display_name,m.role_name`, [identity.tenantId]),
    db.query(`select e.subject_user_id::text as user_id,e.workspace_id::text,w.display_name as workspace_name,
        e.resource_type,e.resource_id,e.permission
      from corvis_control.resource_entitlement e
      join corvis_control.workspace w
        on w.tenant_id=e.tenant_id and w.workspace_id=e.workspace_id
      where e.tenant_id=$1::uuid
        and e.valid_from <= now()
        and (e.valid_until is null or e.valid_until > now())
      order by e.subject_user_id,w.display_name,e.resource_type,e.resource_id,e.permission`, [identity.tenantId]),
  ]);

  const members = memberMap(subjects, identity);
  for (const row of memberships) {
    const userId = text(row, "user_id");
    const member = members.get(userId);
    if (!member) continue;
    const entry: TenantAccessMembership = {
      workspaceId: text(row, "workspace_id"),
      workspaceName: text(row, "workspace_name"),
      roleName: text(row, "role_name"),
    };
    if (!member.memberships.some((value) => value.workspaceId === entry.workspaceId && value.roleName === entry.roleName)) {
      member.memberships.push(entry);
    }
  }
  for (const row of entitlements) {
    const userId = text(row, "user_id");
    const member = members.get(userId);
    if (!member) continue;
    const entry: TenantAccessEntitlement = {
      workspaceId: text(row, "workspace_id"),
      workspaceName: text(row, "workspace_name"),
      resourceType: text(row, "resource_type"),
      resourceId: text(row, "resource_id"),
      permission: text(row, "permission"),
    };
    const key = `${entry.workspaceId}:${entry.resourceType}:${entry.resourceId}:${entry.permission}`;
    if (!member.entitlements.some((value) => `${value.workspaceId}:${value.resourceType}:${value.resourceId}:${value.permission}` === key)) {
      member.entitlements.push(entry);
    }
  }
  return [...members.values()].sort((a, b) => {
    if (a.isCurrentUser !== b.isCurrentUser) return a.isCurrentUser ? -1 : 1;
    return (a.subjects[0]?.subject ?? a.userId).localeCompare(b.subjects[0]?.subject ?? b.userId);
  });
}

type DeactivateDependencies = {
  db?: PostgresSqlApi;
  lifecycle?: IdentityLifecycleRepository;
  eventKey?: string;
};

export async function deactivateTenantAccessMember(
  identity: RequestIdentity,
  userId: string,
  reason: string,
  correlationId: string,
  dependencies: DeactivateDependencies = {},
): Promise<DeactivateTenantAccessResult> {
  const db = dependencies.db ?? postgres(getServerConfig().postgresDsn);
  const lifecycle = dependencies.lifecycle ?? identityLifecycleRepository();
  const rows = await db.query(`select user_id::text,auth_method,subject
    from corvis_control.identity_subject
    where tenant_id=$1::uuid
      and user_id=$2::uuid
      and status='active'
      and auth_method in ('oidc','saml')
    order by auth_method,subject`, [identity.tenantId, userId]);
  if (!rows.length) throw new TenantAccessError("member_not_found", 404);

  const actorRows = identity.authMethod === "oidc" || identity.authMethod === "saml"
    ? await db.query(`select user_id::text
        from corvis_control.identity_subject
        where tenant_id=$1::uuid and auth_method=$2 and subject=$3 and status='active'
        limit 1`, [identity.tenantId, identity.authMethod, identity.subject])
    : [];
  if (text(actorRows[0] ?? {}, "user_id") === userId) {
    throw new TenantAccessError("cannot_deactivate_current_user", 409);
  }

  const authMethod = humanAuthMethod(text(rows[0], "auth_method"));
  const subject = text(rows[0], "subject");
  if (!authMethod || !subject) throw new TenantAccessError("member_not_found", 404);

  return lifecycle.apply({
    tenantId: identity.tenantId,
    eventKey: dependencies.eventKey ?? `tenant-admin-deactivate:${userId}:${randomUUID()}`,
    actorSubject: identity.subject,
    actorWorkspaceId: identity.workspaceId,
    correlationId,
    operation: "disable",
    authMethod,
    subject,
    userId,
    memberships: [],
    reason,
  });
}
