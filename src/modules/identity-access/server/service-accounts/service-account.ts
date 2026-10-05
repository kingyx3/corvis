import { randomUUID } from "node:crypto";
import type { AuditEvent, RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import {
  SERVICE_ACCOUNT_CREDENTIAL_HISTORY,
  SERVICE_ACCOUNT_ENTITLEMENT_LIMIT,
  SERVICE_ACCOUNT_GRANTABLE_LIMIT,
  SERVICE_ACCOUNT_LIMIT,
  credentialStatus,
  expiresSoon,
  isServiceAccountId,
  serviceAccountLifecycle,
  type CreateServiceAccountCommand,
  type ServiceAccount,
  type ServiceAccountCommand,
  type ServiceAccountCreated,
  type ServiceAccountCredential,
  type ServiceAccountEntitlement,
  type ServiceAccountGrantableResource,
  type ServiceAccountList,
  type ServiceAccountCredentialIssued,
  type ServiceAccountResourceType,
  type ServiceAccountRole,
} from "../../domain/service-account.ts";
import { mintCredential } from "./service-account-credential.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { rfc3339FromPostgres } from "../../../../platform/database/timestamps.ts";

/**
 * Service accounts (F6, #262), Postgres side. An account is the identity-subject, membership and lifecycle-grant rows
 * the authorization lookup already resolves, plus `corvis_control.service_account` and its credential records
 * (migration 088). Who may act, and every state rule, is enforced in the SQL functions; nothing here can create an
 * administrator account or accept an action from anyone who is not an active Organization Admin.
 */

/** A request the caller cannot make (403), names nothing visible (404) or lost a race and is safe to retry (409). */
export class ServiceAccountError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 422;
  constructor(code: string, status: 400 | 403 | 404 | 409 | 422) {
    super(code);
    this.name = "ServiceAccountError";
    this.code = code;
    this.status = status;
  }
}

/** Only a person (never a service account) who is an Organization Admin may manage service accounts. */
export function assertCanManageServiceAccounts(identity: RequestIdentity): void {
  if (identity.isTenantAdmin !== true || identity.authMethod === "service_account") throw new ServiceAccountError("tenant_admin_required", 403);
}

/** Where accounts live. Postgres in production, an in-memory store in demo mode; both enforce the same rules. */
export interface ServiceAccountBackend {
  readonly demo: boolean;
  list(identity: RequestIdentity, db?: PostgresSqlApi): Promise<ServiceAccountList>;
  get(identity: RequestIdentity, serviceAccountId: string, db?: PostgresSqlApi): Promise<ServiceAccount>;
  create(identity: RequestIdentity, command: CreateServiceAccountCommand, db?: PostgresSqlApi): Promise<ServiceAccountCreated>;
  /** Issues the first credential of an account that has none in use, or rotates the current one. */
  issueCredential(identity: RequestIdentity, serviceAccountId: string, command: Extract<ServiceAccountCommand, { action: "issue" | "rotate" }>, db?: PostgresSqlApi): Promise<ServiceAccountCredentialIssued>;
  /** Revokes every credential in use, immediately. */
  revoke(identity: RequestIdentity, serviceAccountId: string, db?: PostgresSqlApi): Promise<{ serviceAccount: ServiceAccount; revokedCredentials: number }>;
  /** Deactivates the account everywhere: identity, memberships, entitlements and credentials. */
  disable(identity: RequestIdentity, serviceAccountId: string, reason: string, db?: PostgresSqlApi): Promise<ServiceAccount>;
  /**
   * Moves the account's expiry (and with it its lifecycle review date) to `expiresInDays` from now, which must be later than
   * the current expiry and within the maximum lifetime. Refused for a deactivated account and for one without an active owner.
   */
  extend(identity: RequestIdentity, serviceAccountId: string, command: Extract<ServiceAccountCommand, { action: "extend" }>, db?: PostgresSqlApi): Promise<{ serviceAccount: ServiceAccount; previousExpiresAt: string }>;
  /** Hands the account to another active Organization Admin. */
  transferOwner(identity: RequestIdentity, serviceAccountId: string, ownerSubject: string, db?: PostgresSqlApi): Promise<{ serviceAccount: ServiceAccount; previousOwner: string }>;
  /**
   * Gives the account read access to one fund or document, in its own workspace, through the same entitlement rows a person's
   * access comes from. Refused unless the organization owns the resource AND holds an effective client-visible data right for it.
   */
  grantEntitlement(identity: RequestIdentity, serviceAccountId: string, resource: ServiceAccountResourceRef, db?: PostgresSqlApi): Promise<{ serviceAccount: ServiceAccount }>;
  /** Ends everything the account holds on one fund or document, effective now; never refused for a data-right reason. */
  revokeEntitlement(identity: RequestIdentity, serviceAccountId: string, resource: ServiceAccountResourceRef, db?: PostgresSqlApi): Promise<{ serviceAccount: ServiceAccount; endedEntitlements: number }>;
}

/** The fund or document an entitlement command names. */
export type ServiceAccountResourceRef = { resourceType: ServiceAccountResourceType; resourceId: string };

/** The most Organization Admins offered as a new owner. */
const SERVICE_ACCOUNT_OWNER_CANDIDATE_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
export function daysFromNow(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

export function serviceAccountAuditEvent(
  identity: RequestIdentity,
  correlationId: string,
  action: string,
  item: Pick<ServiceAccount, "serviceAccountId" | "workspaceId">,
  detail: Record<string, string | number | boolean | null> = {},
): AuditEvent {
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: item.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType: "service_account", targetId: item.serviceAccountId,
    outcome: "success", correlationId, metadata: detail,
  };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function str(row: PostgresRow, key: string): string { return String(row[key]); }
function optionalStr(row: PostgresRow, key: string): string | null { return row[key] == null ? null : String(row[key]); }
/** Postgres timestamptz text as an ISO instant: the lifecycle derivation compares instants, never strings. */
function instant(value: string): string { return new Date(rfc3339FromPostgres(value)).toISOString(); }
function optionalInstant(row: PostgresRow, key: string): string | null { return row[key] == null ? null : instant(str(row, key)); }

export function toServiceAccountCredential(row: PostgresRow, now: Date): ServiceAccountCredential {
  const expiresAt = instant(str(row, "expires_at"));
  const endsAt = optionalInstant(row, "ends_at");
  const status = credentialStatus({ revoked: str(row, "status") === "revoked", expiresAt, endsAt }, now);
  return {
    credentialId: str(row, "credential_id"),
    status,
    createdBy: str(row, "created_by_subject"),
    createdAt: instant(str(row, "created_at")),
    expiresAt,
    endsAt,
    revokedAt: optionalInstant(row, "revoked_at"),
    lastUsedAt: optionalInstant(row, "last_used_at"),
    expiringSoon: status === "active" && expiresSoon(expiresAt, now),
  };
}

export function toServiceAccountEntitlement(row: PostgresRow): ServiceAccountEntitlement {
  return {
    resourceType: str(row, "resource_type") as ServiceAccountResourceType,
    resourceId: str(row, "resource_id"),
    label: str(row, "label"),
    permission: str(row, "permission"),
    grantedAt: instant(str(row, "valid_from")),
    withinDataRights: row.within_data_rights === true,
  };
}

export function toServiceAccount(row: PostgresRow, credentialRows: PostgresRow[], entitlementRows: PostgresRow[], now: Date): ServiceAccount {
  const entitlements = entitlementRows.map(toServiceAccountEntitlement);
  const credentials = credentialRows.map((credential) => toServiceAccountCredential(credential, now));
  const expiresAt = instant(str(row, "expires_at"));
  const ownerActive = row.owner_active === true;
  return {
    serviceAccountId: str(row, "service_account_id"),
    userId: str(row, "user_id"),
    name: str(row, "display_name"),
    purpose: str(row, "purpose"),
    workspaceId: str(row, "workspace_id"),
    workspaceName: str(row, "workspace_name"),
    roleName: str(row, "role_name") as ServiceAccountRole,
    createdBy: str(row, "created_by_subject"),
    createdAt: instant(str(row, "created_at")),
    expiresAt,
    disabledAt: optionalInstant(row, "disabled_at"),
    disabledBy: optionalStr(row, "disabled_by_subject"),
    disableReason: optionalStr(row, "disable_reason"),
    ownerSubject: str(row, "owner_subject"),
    ownerAssignedAt: instant(str(row, "owner_assigned_at")),
    ownerActive,
    credentials,
    entitlements,
    ...serviceAccountLifecycle({ disabled: str(row, "status") === "disabled", expiresAt, ownerActive, credentials, entitlementCount: entitlements.length }, now),
  };
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

export class PostgresServiceAccountBackend implements ServiceAccountBackend {
  readonly demo = false;
  private readonly defaultDb: () => PostgresSqlApi;

  constructor(defaultDb: () => PostgresSqlApi) { this.defaultDb = defaultDb; }

  /** The tenant's accounts (or one), each with its newest credentials. Always bound to the caller's tenant. */
  private async read(identity: RequestIdentity, serviceAccountId: string | null, db: PostgresSqlApi): Promise<ServiceAccount[]> {
    const accounts = await db.query(`select a.service_account_id::text as service_account_id, a.user_id::text as user_id, a.display_name, a.purpose,
        a.workspace_id::text as workspace_id, w.display_name as workspace_name, a.role_name, a.status, a.created_by_subject, a.created_at,
        a.expires_at, a.disabled_at, a.disabled_by_subject, a.disable_reason, a.owner_subject, a.owner_assigned_at,
        corvis_control.service_account_owner_active(a.tenant_id, a.owner_user_id) as owner_active
      from corvis_control.service_account a
      join corvis_control.workspace w on w.tenant_id = a.tenant_id and w.workspace_id = a.workspace_id
      where a.tenant_id = $1::uuid and ($2::uuid is null or a.service_account_id = $2::uuid)
      order by a.created_at desc, a.service_account_id desc limit ${SERVICE_ACCOUNT_LIMIT * 2}`, [identity.tenantId, serviceAccountId]);
    if (accounts.length === 0) return [];
    const credentials = await db.query(`select * from (
        select c.service_account_id::text as service_account_id, c.credential_id::text as credential_id, c.status, c.created_by_subject,
          c.created_at, c.expires_at, c.ends_at, c.revoked_at, c.last_used_at,
          row_number() over (partition by c.service_account_id order by c.created_at desc, c.credential_id desc) as position
        from corvis_control.service_account_credential c
        where c.tenant_id = $1::uuid and ($2::uuid is null or c.service_account_id = $2::uuid)
      ) ranked where position <= ${SERVICE_ACCOUNT_CREDENTIAL_HISTORY}
      order by position`, [identity.tenantId, serviceAccountId]);
    // What each account can read now: its effective entitlements, named, and whether the organization's data right still covers each.
    const entitlements = await db.query(`select * from (
        select a.service_account_id::text as service_account_id, e.resource_type, e.resource_id, e.permission, e.valid_from,
          case when e.resource_type = 'fund' then coalesce(f.canonical_name, e.resource_id) else coalesce(d.display_name, e.resource_id) end as label,
          corvis_control.service_account_data_right_effective(e.tenant_id, e.resource_type, e.resource_id) as within_data_rights,
          row_number() over (partition by a.service_account_id order by e.resource_type, e.resource_id, e.permission) as position
        from corvis_control.service_account a
        join corvis_control.resource_entitlement e on e.tenant_id = a.tenant_id and e.subject_user_id = a.user_id
          and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now()) and e.resource_type in ('fund','document')
        left join corvis_identity.fund f on e.resource_type = 'fund' and f.global_fund_id = e.resource_id
        left join corvis_source.document d on e.resource_type = 'document' and d.tenant_id = e.tenant_id and d.document_id::text = e.resource_id
        where a.tenant_id = $1::uuid and ($2::uuid is null or a.service_account_id = $2::uuid)
      ) ranked where position <= ${SERVICE_ACCOUNT_ENTITLEMENT_LIMIT}
      order by service_account_id, position`, [identity.tenantId, serviceAccountId]);
    const now = new Date();
    const ofAccount = (rows: PostgresRow[], row: PostgresRow) => rows.filter((candidate) => str(candidate, "service_account_id") === str(row, "service_account_id"));
    return accounts.map((row) => toServiceAccount(row, ofAccount(credentials, row), ofAccount(entitlements, row), now));
  }

  async list(identity: RequestIdentity, db: PostgresSqlApi = this.defaultDb()): Promise<ServiceAccountList> {
    const [serviceAccounts, workspaces, owners, grantable] = await Promise.all([
      this.read(identity, null, db),
      db.query(`select workspace_id::text as workspace_id, display_name from corvis_control.workspace
        where tenant_id = $1::uuid and status = 'active' order by display_name, workspace_id`, [identity.tenantId]),
      // Who an account can be handed to: the organization's active Organization Admins, by the same test the SQL applies.
      db.query(`select distinct s.subject from corvis_control.identity_subject s
        where s.tenant_id = $1::uuid and s.auth_method in ('oidc','saml') and corvis_control.service_account_owner_active(s.tenant_id, s.user_id)
        order by s.subject limit ${SERVICE_ACCOUNT_OWNER_CANDIDATE_LIMIT}`, [identity.tenantId]),
      // What an admin may grant: the organization's own funds and documents that hold an effective, client-visible data right.
      // The same two tests the grant function applies, so nothing is offered that the function would refuse.
      db.query(`select resource_type, resource_id, label from (
          select 'fund'::text as resource_type, r.resource_id, coalesce(f.canonical_name, r.resource_id) as label
          from (select distinct dr.resource_id from corvis_control.data_rights dr where dr.tenant_id = $1::uuid and dr.resource_type = 'fund') r
          left join corvis_identity.fund f on f.global_fund_id = r.resource_id
          where corvis_control.service_account_data_right_effective($1::uuid, 'fund', r.resource_id)
            and corvis_control.access_policy_resource_belongs_to_tenant($1::uuid, 'fund', r.resource_id)
          union all
          select 'document'::text, r.resource_id, coalesce(d.display_name, r.resource_id)
          from (select distinct dr.resource_id from corvis_control.data_rights dr where dr.tenant_id = $1::uuid and dr.resource_type = 'document') r
          left join corvis_source.document d on d.tenant_id = $1::uuid and d.document_id::text = r.resource_id
          where corvis_control.service_account_data_right_effective($1::uuid, 'document', r.resource_id)
            and corvis_control.access_policy_resource_belongs_to_tenant($1::uuid, 'document', r.resource_id)
        ) grantable order by resource_type, label, resource_id limit ${SERVICE_ACCOUNT_GRANTABLE_LIMIT}`, [identity.tenantId]),
    ]);
    return {
      serviceAccounts,
      workspaces: workspaces.map((row) => ({ workspaceId: str(row, "workspace_id"), name: str(row, "display_name") })),
      owners: owners.map((row) => ({ subject: str(row, "subject") })),
      grantable: grantable.map((row): ServiceAccountGrantableResource => ({
        resourceType: str(row, "resource_type") as ServiceAccountResourceType, resourceId: str(row, "resource_id"), label: str(row, "label"),
      })),
    };
  }

  async get(identity: RequestIdentity, serviceAccountId: string, db: PostgresSqlApi = this.defaultDb()): Promise<ServiceAccount> {
    // A missing or malformed id is the same 404, and the query is bound to the caller's tenant.
    if (!isServiceAccountId(serviceAccountId)) throw new ServiceAccountError("service_account_not_found", 404);
    const account = (await this.read(identity, serviceAccountId, db))[0];
    if (!account) throw new ServiceAccountError("service_account_not_found", 404);
    return account;
  }

  async create(identity: RequestIdentity, command: CreateServiceAccountCommand, db: PostgresSqlApi = this.defaultDb()): Promise<ServiceAccountCreated> {
    if (!isServiceAccountId(command.workspaceId)) throw new ServiceAccountError("invalid_workspace", 400);
    const serviceAccountId = randomUUID();
    const minted = mintCredential();
    await db.query(`select 1 from corvis_control.create_service_account($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9,$10::timestamptz,$11::timestamptz,$12,$13)`, [
      identity.tenantId, serviceAccountId, minted.credentialId, identity.authMethod, identity.subject, command.name, command.purpose,
      command.workspaceId, command.roleName, daysFromNow(command.expiresInDays), daysFromNow(command.credentialExpiresInDays), minted.secretSha256, SERVICE_ACCOUNT_LIMIT,
    ]);
    const serviceAccount = await this.get(identity, serviceAccountId, db);
    const stored = serviceAccount.credentials.find((credential) => credential.credentialId === minted.credentialId)!;
    return { serviceAccount, credential: { credentialId: minted.credentialId, secret: minted.secret, expiresAt: stored.expiresAt } };
  }

  async issueCredential(identity: RequestIdentity, serviceAccountId: string, command: Extract<ServiceAccountCommand, { action: "issue" | "rotate" }>, db: PostgresSqlApi = this.defaultDb()): Promise<ServiceAccountCredentialIssued> {
    if (!isServiceAccountId(serviceAccountId)) throw new ServiceAccountError("service_account_not_found", 404);
    const minted = mintCredential();
    await db.query(`select corvis_control.issue_service_account_credential($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::timestamptz,$9) as credential_id`, [
      identity.tenantId, serviceAccountId, minted.credentialId, command.action, identity.authMethod, identity.subject, minted.secretSha256,
      daysFromNow(command.credentialExpiresInDays), command.action === "rotate" ? command.overlapMinutes : 0,
    ]);
    const serviceAccount = await this.get(identity, serviceAccountId, db);
    const stored = serviceAccount.credentials.find((credential) => credential.credentialId === minted.credentialId)!;
    return { serviceAccount, credential: { credentialId: minted.credentialId, secret: minted.secret, expiresAt: stored.expiresAt } };
  }

  async revoke(identity: RequestIdentity, serviceAccountId: string, db: PostgresSqlApi = this.defaultDb()): Promise<{ serviceAccount: ServiceAccount; revokedCredentials: number }> {
    if (!isServiceAccountId(serviceAccountId)) throw new ServiceAccountError("service_account_not_found", 404);
    const rows = await db.query(`select corvis_control.revoke_service_account_credentials($1::uuid,$2::uuid,$3,$4) as revoked`, [
      identity.tenantId, serviceAccountId, identity.authMethod, identity.subject,
    ]);
    return { serviceAccount: await this.get(identity, serviceAccountId, db), revokedCredentials: Number(rows[0]!.revoked) };
  }

  async disable(identity: RequestIdentity, serviceAccountId: string, reason: string, db: PostgresSqlApi = this.defaultDb()): Promise<ServiceAccount> {
    if (!isServiceAccountId(serviceAccountId)) throw new ServiceAccountError("service_account_not_found", 404);
    await db.query(`select 1 from corvis_control.disable_service_account($1::uuid,$2::uuid,$3,$4,$5)`, [
      identity.tenantId, serviceAccountId, identity.authMethod, identity.subject, reason,
    ]);
    return this.get(identity, serviceAccountId, db);
  }

  async extend(identity: RequestIdentity, serviceAccountId: string, command: Extract<ServiceAccountCommand, { action: "extend" }>, db: PostgresSqlApi = this.defaultDb()): Promise<{ serviceAccount: ServiceAccount; previousExpiresAt: string }> {
    if (!isServiceAccountId(serviceAccountId)) throw new ServiceAccountError("service_account_not_found", 404);
    const rows = await db.query(`select corvis_control.extend_service_account($1::uuid,$2::uuid,$3,$4,$5::timestamptz) as previous_expires_at`, [
      identity.tenantId, serviceAccountId, identity.authMethod, identity.subject, daysFromNow(command.expiresInDays),
    ]);
    return { serviceAccount: await this.get(identity, serviceAccountId, db), previousExpiresAt: instant(str(rows[0]!, "previous_expires_at")) };
  }

  async transferOwner(identity: RequestIdentity, serviceAccountId: string, ownerSubject: string, db: PostgresSqlApi = this.defaultDb()): Promise<{ serviceAccount: ServiceAccount; previousOwner: string }> {
    if (!isServiceAccountId(serviceAccountId)) throw new ServiceAccountError("service_account_not_found", 404);
    const rows = await db.query(`select corvis_control.transfer_service_account_owner($1::uuid,$2::uuid,$3,$4,$5) as previous_owner`, [
      identity.tenantId, serviceAccountId, identity.authMethod, identity.subject, ownerSubject,
    ]);
    return { serviceAccount: await this.get(identity, serviceAccountId, db), previousOwner: str(rows[0]!, "previous_owner") };
  }

  async grantEntitlement(identity: RequestIdentity, serviceAccountId: string, resource: ServiceAccountResourceRef, db: PostgresSqlApi = this.defaultDb()): Promise<{ serviceAccount: ServiceAccount }> {
    if (!isServiceAccountId(serviceAccountId)) throw new ServiceAccountError("service_account_not_found", 404);
    await db.query(`select corvis_control.grant_service_account_entitlement($1::uuid,$2::uuid,$3,$4,$5,$6,$7::integer)`, [
      identity.tenantId, serviceAccountId, identity.authMethod, identity.subject, resource.resourceType, resource.resourceId, SERVICE_ACCOUNT_ENTITLEMENT_LIMIT,
    ]);
    return { serviceAccount: await this.get(identity, serviceAccountId, db) };
  }

  async revokeEntitlement(identity: RequestIdentity, serviceAccountId: string, resource: ServiceAccountResourceRef, db: PostgresSqlApi = this.defaultDb()): Promise<{ serviceAccount: ServiceAccount; endedEntitlements: number }> {
    if (!isServiceAccountId(serviceAccountId)) throw new ServiceAccountError("service_account_not_found", 404);
    const rows = await db.query(`select corvis_control.revoke_service_account_entitlement($1::uuid,$2::uuid,$3,$4,$5,$6) as ended`, [
      identity.tenantId, serviceAccountId, identity.authMethod, identity.subject, resource.resourceType, resource.resourceId,
    ]);
    return { serviceAccount: await this.get(identity, serviceAccountId, db), endedEntitlements: Number(rows[0]!.ended) };
  }
}
