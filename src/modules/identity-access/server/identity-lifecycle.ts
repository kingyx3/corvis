import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { getServerConfig } from "../../../platform/config.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { TenantInvitationError } from "./tenant-invitations.ts";

export type IdentityLifecycleRole = "tenant_admin" | "accountadmin" | "reviewer" | "analyst" | "viewer";
export type HumanAuthMethod = "oidc" | "saml";
export type IdentityLifecycleOperation = "sync" | "disable";

export type IdentityLifecycleMembership = {
  workspaceId: string;
  roleName: IdentityLifecycleRole;
};

export type IdentityLifecycleCommand = {
  tenantId: string;
  eventKey: string;
  actorSubject: string;
  actorWorkspaceId: string;
  correlationId: string;
  operation: IdentityLifecycleOperation;
  authMethod: HumanAuthMethod;
  subject: string;
  userId: string;
  memberships: IdentityLifecycleMembership[];
  reason: string;
};

export type IdentityLifecycleResult = {
  eventKey: string;
  operation: IdentityLifecycleOperation;
  subject: string;
  userId: string;
  activeMemberships: number;
  revokedMemberships: number;
  expiredEntitlements: number;
  disabledSubjects: number;
  disabledServiceGrants: number;
};

export interface IdentityLifecycleRepository {
  apply(command: IdentityLifecycleCommand): Promise<IdentityLifecycleResult>;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("Identity lifecycle repository returned an invalid result");
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Identity lifecycle repository returned an invalid count");
  return parsed;
}

export class PostgresIdentityLifecycleRepository implements IdentityLifecycleRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async apply(command: IdentityLifecycleCommand): Promise<IdentityLifecycleResult> {
    const rows = await this.db.query(`select corvis_control.apply_identity_lifecycle(
      $1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9::uuid,$10::jsonb,$11
    ) as result`, [
      command.tenantId,
      command.eventKey,
      command.actorSubject,
      command.actorWorkspaceId,
      command.correlationId,
      command.operation,
      command.authMethod,
      command.subject,
      command.userId,
      JSON.stringify(command.memberships),
      command.reason,
    ]);
    const raw = object(rows[0]?.result);
    const operation = raw.operation;
    if (operation !== "sync" && operation !== "disable") throw new Error("Identity lifecycle repository returned an invalid operation");
    return {
      eventKey: String(raw.eventKey ?? ""),
      operation,
      subject: String(raw.subject ?? ""),
      userId: String(raw.userId ?? ""),
      activeMemberships: number(raw.activeMemberships),
      revokedMemberships: number(raw.revokedMemberships),
      expiredEntitlements: number(raw.expiredEntitlements),
      disabledSubjects: number(raw.disabledSubjects),
      disabledServiceGrants: number(raw.disabledServiceGrants),
    };
  }
}

/**
 * Operator-side guard for `/admin/identity-lifecycle`, mirroring
 * `deactivateTenantAccessMember`: an administrator cannot disable (or strip
 * the tenant_admin role from) their own identity, and the last active tenant
 * administrator can never be disabled or demoted, which would lock the tenant
 * out of its own administration. Reactivation and any sync that keeps a
 * tenant_admin membership only add or preserve access and are not guarded.
 *
 * Run it on the same transaction handle as the apply. It locks the tenant row
 * (the same lock `changeTenantMemberRole` takes) so two concurrent demotions
 * cannot each see the other admin still present.
 */
export async function guardIdentityLifecycleCommand(
  identity: RequestIdentity,
  command: Pick<IdentityLifecycleCommand, "operation" | "authMethod" | "subject" | "userId" | "memberships">,
  db: PostgresSqlApi,
): Promise<void> {
  const keepsTenantAdmin = command.operation === "sync" && command.memberships.some((entry) => entry.roleName === "tenant_admin");
  if (keepsTenantAdmin) return;
  // Postgres returns canonical lower-case uuids but `::uuid` accepts any case: compare like with like,
  // or an upper-case spelling of the same user id slips past both checks below.
  const targetUserId = command.userId.toLowerCase();

  await db.query("select tenant_id from corvis_control.tenant where tenant_id=$1::uuid for update", [identity.tenantId]);
  const actorRows = identity.authMethod === "oidc" || identity.authMethod === "saml"
    ? await db.query(`select user_id::text from corvis_control.identity_subject
        where tenant_id=$1::uuid and auth_method=$2 and subject=$3 and status='active' limit 1`,
      [identity.tenantId, identity.authMethod, identity.subject])
    : [];
  const actorUserId = actorRows[0]?.user_id == null ? "" : String(actorRows[0].user_id);
  const targetsActor = (actorUserId !== "" && actorUserId === targetUserId)
    || (identity.authMethod === command.authMethod && identity.subject === command.subject);

  const admins = await db.query(`select distinct m.user_id::text as user_id
    from corvis_control.membership m
    join corvis_control.identity_subject s
      on s.tenant_id=m.tenant_id and s.user_id=m.user_id and s.status='active' and s.auth_method in ('oidc','saml')
    where m.tenant_id=$1::uuid and m.role_name='tenant_admin' and m.status='active'
      and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())`, [identity.tenantId]);
  const adminIds = admins.map((row) => String(row.user_id));

  if (targetsActor && (command.operation === "disable" || adminIds.includes(targetUserId) || identity.isTenantAdmin === true)) {
    throw new TenantInvitationError(command.operation === "disable" ? "cannot_deactivate_current_user" : "cannot_change_current_user", 409);
  }
  if (adminIds.includes(targetUserId) && !adminIds.some((id) => id !== targetUserId)) {
    throw new TenantInvitationError("last_tenant_admin", 409);
  }
}

let singleton: IdentityLifecycleRepository | undefined;

export function identityLifecycleRepository(dsn = getServerConfig().postgresDsn): IdentityLifecycleRepository {
  if (!singleton) singleton = new PostgresIdentityLifecycleRepository(postgres(dsn));
  return singleton;
}
