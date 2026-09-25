import { randomUUID } from "node:crypto";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { type ServerConfig, getServerConfig } from "./config.ts";
import { ConflictError } from "./platform.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

/** Matches lib/server/customer-implementation.ts's CUSTOMER_KEY: a stable lowercase slug. */
export const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export type ProvisionTenantCommand = {
  tenantSlug: string;
  tenantDisplayName: string;
  workspaceSlug: string;
  workspaceDisplayName: string;
  reason: string;
};

export type ProvisionTenantResult = {
  tenantId: string;
  tenantSlug: string;
  tenantDisplayName: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceDisplayName: string;
};

/**
 * Corvis staff provisioning a brand-new client tenant is fundamentally
 * cross-tenant: there is no existing tenant/workspace membership for the
 * actor to be scoped by (that is the whole point of this operation), so the
 * ordinary tenant-scoped `admin:manage`/`isTenantAdmin` checks every other
 * `/api/v1/admin/**` route relies on cannot gate it by themselves. Gate this
 * one capability to a single designated Corvis-operated tenant instead of
 * letting every client's own tenant_admin mint sibling tenants.
 *
 * Demo mode has no real operations tenant to configure; the caller's own
 * (demo) tenant stands in for it there, matching how demo identities are
 * already trusted with `admin`/`isTenantAdmin` throughout this console.
 * Outside demo mode, an unconfigured `operationsTenantId` disables the
 * capability for everyone (fails closed) until an operator sets it.
 */
export function assertOperationsTenant(identity: RequestIdentity, config: ServerConfig): void {
  const operationsTenantId = config.operationsTenantId ?? (config.demoMode ? identity.tenantId : undefined);
  if (!operationsTenantId || identity.tenantId !== operationsTenantId) {
    throw new AuthorizationError("platform:provision_tenant");
  }
}

function text(value: unknown, min: number, max: number): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length >= min && trimmed.length <= max ? trimmed : undefined;
}

export function normalizeProvisionTenantCommand(body: Record<string, unknown>): ProvisionTenantCommand | undefined {
  const tenantSlug = text(body.tenantSlug, 1, 64)?.toLowerCase();
  const tenantDisplayName = text(body.tenantDisplayName, 1, 200);
  const workspaceSlug = text(body.workspaceSlug, 1, 64)?.toLowerCase();
  const workspaceDisplayName = text(body.workspaceDisplayName, 1, 200);
  const reason = text(body.reason, 1, 1000);
  if (
    !tenantSlug || !TENANT_SLUG.test(tenantSlug) || !tenantDisplayName ||
    !workspaceSlug || !TENANT_SLUG.test(workspaceSlug) || !workspaceDisplayName ||
    !reason
  ) return undefined;
  return { tenantSlug, tenantDisplayName, workspaceSlug, workspaceDisplayName, reason };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23505";
}

export class PostgresTenantProvisioningRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) { this.db = db; }

  /**
   * Atomically creates the tenant, its first workspace and the audited
   * receipt. The caller (the route) must run this inside `withTransaction`
   * so a failure after the tenant insert never leaves an orphaned tenant
   * with no workspace or audit trail.
   */
  async provision(identity: RequestIdentity, correlationId: string, command: ProvisionTenantCommand): Promise<ProvisionTenantResult> {
    const conflict = await this.db.query(`select 1 from corvis_control.tenant where slug=$1`, [command.tenantSlug]);
    if (conflict.length) throw new ConflictError("tenant_slug_taken");

    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    try {
      await this.db.execute(
        `insert into corvis_control.tenant (tenant_id, slug, display_name) values ($1,$2,$3)`,
        [tenantId, command.tenantSlug, command.tenantDisplayName],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("tenant_slug_taken");
      throw error;
    }
    await this.db.execute(
      `insert into corvis_control.workspace (workspace_id, tenant_id, slug, display_name) values ($1,$2,$3,$4)`,
      [workspaceId, tenantId, command.workspaceSlug, command.workspaceDisplayName],
    );
    await new PostgresOperationsRepository(this.db).audit({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      actorSubject: identity.subject,
      sessionId: identity.sessionId,
      action: "tenant.provisioned",
      targetType: "tenant",
      targetId: tenantId,
      outcome: "success",
      correlationId,
      metadata: {
        workspaceId,
        tenantSlug: command.tenantSlug,
        workspaceSlug: command.workspaceSlug,
        reason: command.reason,
      },
    });

    return {
      tenantId,
      tenantSlug: command.tenantSlug,
      tenantDisplayName: command.tenantDisplayName,
      workspaceId,
      workspaceSlug: command.workspaceSlug,
      workspaceDisplayName: command.workspaceDisplayName,
    };
  }
}

let singleton: PostgresTenantProvisioningRepository | undefined;
export function tenantProvisioningRepository(dsn = getServerConfig().postgresDsn): PostgresTenantProvisioningRepository {
  if (!singleton) singleton = new PostgresTenantProvisioningRepository(postgres(dsn));
  return singleton;
}
