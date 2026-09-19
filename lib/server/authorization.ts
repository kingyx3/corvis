import type { RequestIdentity, Role } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

export type AuthorizationPrincipal = Pick<RequestIdentity, "subject" | "tenantId" | "workspaceId" | "authMethod">;

export type MembershipAuthorization = {
  roles: Role[];
  workspaceIds: string[];
};

export interface MembershipAuthorizationRepository {
  resolve(principal: AuthorizationPrincipal): Promise<MembershipAuthorization | null>;
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
    const rows = await this.db.query(`select m.workspace_id::text as workspace_id, m.role_name
      from corvis_control.identity_subject s
      join corvis_control.tenant t
        on t.tenant_id=s.tenant_id and t.status='active'
      join corvis_control.membership m
        on m.tenant_id=s.tenant_id and m.user_id=s.user_id
      join corvis_control.workspace w
        on w.tenant_id=m.tenant_id and w.workspace_id=m.workspace_id and w.status='active'
      where s.tenant_id=$1::uuid
        and s.subject=$2
        and s.auth_method=$3
        and s.status='active'
        and m.status='active'
        and m.valid_from <= now()
        and (m.valid_to is null or m.valid_to > now())
      order by m.workspace_id, m.role_name`, [principal.tenantId, principal.subject, principal.authMethod]);

    const workspaceIds = [...new Set(rows.map((row) => text(row.workspace_id)).filter(Boolean))];
    if (!workspaceIds.includes(principal.workspaceId)) return null;

    const roles = [...new Set(rows
      .filter((row) => text(row.workspace_id) === principal.workspaceId)
      .map((row) => ROLE_MAP[text(row.role_name)])
      .filter((role): role is Role => role !== undefined))];
    if (roles.length === 0) return null;

    return { roles, workspaceIds };
  }
}

let singleton: MembershipAuthorizationRepository | undefined;

export function membershipAuthorizationRepository(dsn = getServerConfig().postgresDsn): MembershipAuthorizationRepository {
  if (!singleton) singleton = new PostgresMembershipAuthorizationRepository(postgres(dsn));
  return singleton;
}
