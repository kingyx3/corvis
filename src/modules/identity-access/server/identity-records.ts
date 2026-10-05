import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type {
  DomainVerificationMethod,
  IdentityProtocol,
  IdentityProviderRecord,
  IdentityProviderStatus,
  TenantIdentityCommand,
  VerifiedDomainView,
} from "../domain/identity-records.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "../../../platform/database/postgres.ts";

/**
 * Verified email domains (F7b, #335) and the per-tenant identity-provider record (F7e, #338), over Postgres (migration
 * 095). Both are Corvis-assisted: the tables are written only by the operator functions below (after the route has
 * required the Corvis operations tenant), and an Organization Admin reads them through the session-policy view.
 *
 * What is enforced, and where, is in SQL: the value rules are CHECK constraints, the operator authority, the reason, the
 * one-tenant-per-domain rule, the per-tenant limit, the version compare-and-set and the audit event (written for the
 * TARGET tenant in the same transaction) are in the functions, and the invitation / SCIM domain check is
 * `corvis_control.email_domain_allowed`. This module only maps rows and calls them.
 */
export type TenantIdentityRecords = { identityProvider: IdentityProviderRecord | null; verifiedDomains: VerifiedDomainView[] };
export type TenantIdentityChange = { changed: boolean; version: number | null };

function str(row: PostgresRow, key: string): string { return String(row[key]); }

/** The records of one tenant, with an explicit tenant predicate (the tables have no client policy). Never selects who verified a domain or the evidence reference. */
export async function readTenantIdentityRecords(db: PostgresSqlApi, tenantId: string): Promise<TenantIdentityRecords> {
  const [providerRows, domainRows] = await Promise.all([
    db.query(`select protocol, issuer, audience, status, enforce_token_binding, idp_enforces_mfa, end_session_endpoint, version, updated_at
      from corvis_control.tenant_identity_provider where tenant_id = $1::uuid`, [tenantId]),
    db.query(`select domain, verification_method, verified_at
      from corvis_control.tenant_verified_domain where tenant_id = $1::uuid order by domain limit 100`, [tenantId]),
  ]);
  const provider = providerRows[0];
  return {
    identityProvider: provider
      ? {
        protocol: str(provider, "protocol") as IdentityProtocol,
        issuer: str(provider, "issuer"),
        audience: str(provider, "audience"),
        status: str(provider, "status") as IdentityProviderStatus,
        enforceTokenBinding: provider.enforce_token_binding === true || provider.enforce_token_binding === "true",
        idpEnforcesMfa: provider.idp_enforces_mfa == null ? null : provider.idp_enforces_mfa === true || provider.idp_enforces_mfa === "true",
        endSessionEndpoint: provider.end_session_endpoint == null ? null : str(provider, "end_session_endpoint"),
        version: Number(provider.version),
        updatedAt: str(provider, "updated_at"),
      }
      : null,
    verifiedDomains: domainRows.map((row) => ({
      domain: str(row, "domain"),
      verificationMethod: str(row, "verification_method") as DomainVerificationMethod,
      verifiedAt: str(row, "verified_at"),
    })),
  };
}

/**
 * Whether an address may be invited or provisioned into the tenant (SQL: `email_domain_allowed`). True when the tenant
 * has no verified domain (the check is off) or the address is on one. Anything but an explicit true is a refusal, so a
 * missing answer fails closed. Called only where a NEW invitation or SCIM user is created, never at sign-in.
 */
export async function emailDomainAllowed(db: PostgresSqlApi, tenantId: string, email: string): Promise<boolean> {
  const rows = await db.query(`select corvis_control.email_domain_allowed($1::uuid,$2) as allowed`, [tenantId, email]);
  return rows[0]?.allowed === true || rows[0]?.allowed === "true";
}

/**
 * Applies one operator command to the target tenant's records. The caller (the route) has already required the operations
 * tenant and `tenant_admin`; the SQL function independently requires the actor to be an active Organization Admin and
 * writes the audit event for the target tenant in the same transaction.
 */
export async function applyTenantIdentityCommand(
  identity: RequestIdentity,
  command: TenantIdentityCommand,
  correlationId: string,
  db: PostgresSqlApi = postgres(getServerConfig().databaseDsn),
): Promise<TenantIdentityChange> {
  const actor = [identity.tenantId, identity.authMethod, identity.subject];
  const rows = command.kind === "verified_domain_add"
    ? await db.query(`select (r->>'changed')::boolean as changed, null::integer as version from
        (select corvis_control.set_tenant_verified_domain($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9) as r) x`,
    [command.tenantId, ...actor, command.domain, command.verificationMethod, command.evidence, command.reason, correlationId])
    : command.kind === "verified_domain_remove"
      ? await db.query(`select (r->>'changed')::boolean as changed, null::integer as version from
          (select corvis_control.remove_tenant_verified_domain($1::uuid,$2::uuid,$3,$4,$5,$6,$7) as r) x`,
      [command.tenantId, ...actor, command.domain, command.reason, correlationId])
      : await db.query(`select (r->>'changed')::boolean as changed, (r->>'version')::integer as version from
          (select corvis_control.set_tenant_identity_provider($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::boolean,$10::integer,$11,$12,$13::boolean,$14) as r) x`,
      [command.tenantId, ...actor, command.protocol, command.issuer, command.audience, command.status, command.enforceTokenBinding, command.expectedVersion, command.reason, correlationId, command.idpEnforcesMfa, command.endSessionEndpoint]);
  const row = rows[0];
  return { changed: row?.changed === true || row?.changed === "true", version: row?.version == null ? null : Number(row.version) };
}
