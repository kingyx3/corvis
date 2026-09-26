import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { ConflictError } from "./platform.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export const INVITATION_TTL_DAYS = 7;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITABLE_ROLES = new Set(["tenant_admin", "workspace_admin", "reviewer", "analyst", "viewer"]);

export type CreateTenantInvitation = {
  tenantId: string;
  workspaceId: string;
  email: string;
  roleName: "tenant_admin" | "workspace_admin" | "reviewer" | "analyst" | "viewer";
  reason: string;
  confirmTenantAdmin: boolean;
};

export type TenantInvitation = {
  invitationId: string;
  tenantId: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  roleName: CreateTenantInvitation["roleName"];
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
};

export type AcceptedInvitation = {
  invitationId: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  roleName: CreateTenantInvitation["roleName"];
};

export class TenantInvitationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.name = "TenantInvitationError"; this.code = code; this.status = status; }
}

export function normalizeTenantInvitation(value: Record<string, unknown>): CreateTenantInvitation | undefined {
  const tenantId = typeof value.tenantId === "string" ? value.tenantId.trim() : "";
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const roleName = typeof value.roleName === "string" ? value.roleName.trim() : "";
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  const confirmTenantAdmin = value.confirmTenantAdmin === true;
  if (!UUID.test(tenantId) || !UUID.test(workspaceId) || email.length > 320 || !EMAIL.test(email)
    || !INVITABLE_ROLES.has(roleName) || reason.length < 3 || reason.length > 1000
    || (roleName === "tenant_admin" && !confirmTenantAdmin)) return undefined;
  return { tenantId, workspaceId, email, roleName: roleName as CreateTenantInvitation["roleName"], reason, confirmTenantAdmin };
}

export function assertInvitationIssuer(identity: RequestIdentity, command: CreateTenantInvitation): void {
  if (identity.isTenantAdmin === true && identity.tenantId === command.tenantId) return;
  const operationsTenant = getServerConfig().operationsTenantId;
  if (operationsTenant && identity.tenantId === operationsTenant && identity.roles.includes("admin")) return;
  throw new AuthorizationError("admin:tenant_manage");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function value(row: PostgresRow, key: string): string { return row[key] == null ? "" : String(row[key]); }
function isUniqueViolation(error: unknown): boolean { return (error as { code?: unknown } | null)?.code === "23505"; }

export async function createTenantInvitation(
  identity: RequestIdentity,
  command: CreateTenantInvitation,
  correlationId: string,
  db: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<{ invitation: TenantInvitation; token: string }> {
  assertInvitationIssuer(identity, command);
  const workspace = (await db.query(`select w.display_name
    from corvis_control.workspace w
    where w.tenant_id=$1::uuid and w.workspace_id=$2::uuid and w.status='active'
    limit 1`, [command.tenantId, command.workspaceId]))[0];
  if (!workspace) throw new TenantInvitationError("workspace_not_found", 404);

  // The first organization-admin invitation is issued only by the configured
  // Corvis operations tenant. Existing tenant administrators may grant the
  // role within their own tenant; every such grant is explicit and audited.
  if (command.roleName === "tenant_admin") {
    const isOperationsActor = identity.tenantId === getServerConfig().operationsTenantId;
    if (!isOperationsActor && identity.tenantId !== command.tenantId) throw new AuthorizationError("admin:tenant_manage");
    if (!isOperationsActor && identity.isTenantAdmin !== true) throw new AuthorizationError("admin:tenant_manage");
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invitationId = randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    await db.execute(`update corvis_control.tenant_invitation set status='expired'
      where tenant_id=$1::uuid and workspace_id=$2::uuid and lower(email)=$3
        and status='pending' and expires_at <= now()`, [command.tenantId,command.workspaceId,command.email]);
    await db.execute(`insert into corvis_control.tenant_invitation
        (invitation_id,tenant_id,workspace_id,email,role_name,token_sha256,invited_by_subject,expires_at)
      values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::timestamptz)`,
    [invitationId,command.tenantId,command.workspaceId,command.email,command.roleName,tokenHash,identity.subject,expiresAt]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("invitation_already_pending");
    throw error;
  }
  await new PostgresOperationsRepository(db).audit({
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: command.tenantId,
    workspaceId: command.workspaceId, actorSubject: identity.subject, sessionId: identity.sessionId,
    action: "tenant_invitation.issued", targetType: "tenant_invitation", targetId: invitationId,
    outcome: "success", correlationId,
    metadata: { email: command.email, roleName: command.roleName, reason: command.reason, expiresAt },
  });

  return {
    token,
    invitation: {
      invitationId, tenantId: command.tenantId, workspaceId: command.workspaceId,
      workspaceName: value(workspace, "display_name"), email: command.email,
      roleName: command.roleName, status: "pending", createdAt: new Date().toISOString(), expiresAt,
    },
  };
}

export async function listTenantInvitations(
  identity: RequestIdentity,
  db: PostgresSqlApi = postgres(getServerConfig().postgresDsn),
): Promise<TenantInvitation[]> {
  if (identity.isTenantAdmin !== true) throw new AuthorizationError("admin:tenant_manage");
  const rows = await db.query(`select i.invitation_id::text,i.tenant_id::text,i.workspace_id::text,
      w.display_name as workspace_name,i.email,i.role_name,
      case when i.status='pending' and i.expires_at <= now() then 'expired' else i.status end as status,
      i.created_at,i.expires_at
    from corvis_control.tenant_invitation i
    join corvis_control.workspace w on w.tenant_id=i.tenant_id and w.workspace_id=i.workspace_id
    where i.tenant_id=$1::uuid
    order by i.created_at desc limit 200`, [identity.tenantId]);
  return rows.map((row) => ({
    invitationId: value(row, "invitation_id"), tenantId: value(row, "tenant_id"),
    workspaceId: value(row, "workspace_id"), workspaceName: value(row, "workspace_name"),
    email: value(row, "email"), roleName: value(row, "role_name") as TenantInvitation["roleName"],
    status: value(row, "status") as TenantInvitation["status"], createdAt: value(row, "created_at"), expiresAt: value(row, "expires_at"),
  }));
}

export async function acceptTenantInvitation(token: string, authMethod: "oidc" | "saml", subject: string, authenticatedEmail: string | undefined, emailVerified: boolean | undefined, correlationId: string,
  db: PostgresSqlApi = postgres(getServerConfig().postgresDsn)): Promise<AcceptedInvitation> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !subject || subject.length > 1024
    || emailVerified !== true || !authenticatedEmail || !EMAIL.test(authenticatedEmail)) {
    if (emailVerified !== true || !authenticatedEmail) throw new TenantInvitationError("verified_email_required", 403);
    throw new TenantInvitationError("invitation_not_found", 404);
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  try {
    const row = (await db.query(`select * from corvis_control.accept_tenant_invitation($1,$2,$3,$4,$5,$6)`,
      [tokenHash, authMethod, subject, authenticatedEmail.trim().toLowerCase(), emailVerified, correlationId]))[0];
    if (!row) throw new TenantInvitationError("invitation_not_found", 404);
    return {
      invitationId: value(row, "invitation_id"), tenantId: value(row, "tenant_id"),
      workspaceId: value(row, "workspace_id"), userId: value(row, "user_id"),
      roleName: value(row, "role_name") as AcceptedInvitation["roleName"],
    };
  } catch (error) {
    if (error instanceof TenantInvitationError) throw error;
    const code = (error as { message?: unknown } | null)?.message;
    const mapping: Record<string, [string, number]> = {
      invitation_not_found: ["invitation_not_found", 404],
      invitation_not_pending: ["invitation_not_pending", 409],
      invitation_expired: ["invitation_expired", 410],
      invitation_identity_disabled: ["invitation_identity_disabled", 409],
      invitation_membership_exists: ["invitation_membership_exists", 409],
      invitation_email_mismatch: ["invitation_email_mismatch", 403],
      invalid_invitation_identity: ["verified_email_required", 403],
    };
    if (typeof code === "string" && mapping[code]) throw new TenantInvitationError(...mapping[code]);
    throw error;
  }
}
