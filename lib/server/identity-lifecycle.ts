import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

export type IdentityLifecycleRole = "tenant_admin" | "workspace_admin" | "reviewer" | "analyst" | "viewer";
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

let singleton: IdentityLifecycleRepository | undefined;

export function identityLifecycleRepository(dsn = getServerConfig().postgresDsn): IdentityLifecycleRepository {
  if (!singleton) singleton = new PostgresIdentityLifecycleRepository(postgres(dsn));
  return singleton;
}
