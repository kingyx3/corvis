import type { RequestIdentity, Role } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

export type AuthorizationPrincipal = Pick<RequestIdentity, "subject" | "tenantId" | "workspaceId" | "authMethod" | "sessionId">;

export type MembershipAuthorization = {
  roles: Role[];
  workspaceIds: string[];
  fundIds: string[];
  documentIds: string[];
};

export type SessionRevocation = {
  tenantId: string;
  authMethod: Exclude<RequestIdentity["authMethod"], "demo">;
  subject: string;
  sessionId: string;
  revokedBySubject: string;
  reason: string;
};

export interface MembershipAuthorizationRepository {
  resolve(principal: AuthorizationPrincipal): Promise<MembershipAuthorization | null>;
}

export interface SessionRevocationRepository {
  revoke(command: SessionRevocation): Promise<void>;
}

const ROLE_MAP: Record<string, Role | undefined> = {
  tenant_admin: "admin",
  workspace_admin: "admin",
  reviewer: "reviewer",
  analyst: "analyst",
  viewer: "read_only",
};

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

export class PostgresMembershipAuthorizationRepository implements MembershipAuthorizationRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async resolve(principal: AuthorizationPrincipal): Promise<MembershipAuthorization | null> {
    if (principal.authMethod === "demo") return null;
    const rows = await this.db.query(`select m.workspace_id::text as workspace_id, m.role_name,
        e.resource_type, e.resource_id, e.permission as resource_permission
      from corvis_control.identity_subject s
      join corvis_control.tenant t
        on t.tenant_id=s.tenant_id and t.status='active'
      join corvis_control.membership m
        on m.tenant_id=s.tenant_id and m.user_id=s.user_id
      join corvis_control.workspace w
        on w.tenant_id=m.tenant_id and w.workspace_id=m.workspace_id and w.status='active'
      left join corvis_control.resource_entitlement e
        on e.tenant_id=s.tenant_id
       and e.workspace_id=m.workspace_id
       and e.subject_user_id=s.user_id
       and e.valid_from <= now()
       and (e.valid_until is null or e.valid_until > now())
      where s.tenant_id=$1::uuid
        and s.subject=$2
        and s.auth_method=$3
        and s.status='active'
        and (
          s.auth_method <> 'service_account'
          or exists (
            select 1
            from corvis_control.service_identity_grant g
            where g.tenant_id=s.tenant_id
              and g.auth_method=s.auth_method
              and g.subject=s.subject
              and g.status='active'
              and g.valid_from <= now()
              and g.valid_until > now()
              and g.reviewed_at <= now()
              and g.next_review_at > now()
          )
        )
        and not exists (
          select 1
          from corvis_control.session_revocation r
          where r.tenant_id=s.tenant_id
            and r.auth_method=s.auth_method
            and r.subject=s.subject
            and r.session_id=$4
        )
        and m.status='active'
        and m.valid_from <= now()
        and (m.valid_until is null or m.valid_until > now())
      order by m.workspace_id, m.role_name, e.resource_type, e.resource_id`,
    [principal.tenantId, principal.subject, principal.authMethod, principal.sessionId]);

    const workspaceIds = [...new Set(rows.map((row) => text(row.workspace_id)).filter(Boolean))];
    if (!workspaceIds.includes(principal.workspaceId)) return null;

    const requestedWorkspaceRows = rows.filter((row) => text(row.workspace_id) === principal.workspaceId);
    const roles = [...new Set(requestedWorkspaceRows
      .map((row) => ROLE_MAP[text(row.role_name)])
      .filter((role): role is Role => role !== undefined))];
    if (roles.length === 0) return null;

    const readableResourceIds = (resourceType: "fund" | "document") => [...new Set(requestedWorkspaceRows
      .filter((row) => text(row.resource_type) === resourceType && text(row.resource_permission) === "read")
      .map((row) => text(row.resource_id))
      .filter(Boolean))];

    return {
      roles,
      workspaceIds,
      fundIds: readableResourceIds("fund"),
      documentIds: readableResourceIds("document"),
    };
  }
}

export class PostgresSessionRevocationRepository implements SessionRevocationRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async revoke(command: SessionRevocation): Promise<void> {
    await this.db.execute(`insert into corvis_control.session_revocation
        (tenant_id,auth_method,subject,session_id,revoked_by_subject,reason)
      values ($1::uuid,$2,$3,$4,$5,$6)
      on conflict (tenant_id,auth_method,subject,session_id) do nothing`,
    [command.tenantId, command.authMethod, command.subject, command.sessionId, command.revokedBySubject, command.reason]);
  }
}

let membershipSingleton: MembershipAuthorizationRepository | undefined;
let revocationSingleton: SessionRevocationRepository | undefined;

export function membershipAuthorizationRepository(dsn = getServerConfig().postgresDsn): MembershipAuthorizationRepository {
  if (!membershipSingleton) membershipSingleton = new PostgresMembershipAuthorizationRepository(postgres(dsn));
  return membershipSingleton;
}

export function sessionRevocationRepository(dsn = getServerConfig().postgresDsn): SessionRevocationRepository {
  if (!revocationSingleton) revocationSingleton = new PostgresSessionRevocationRepository(postgres(dsn));
  return revocationSingleton;
}
