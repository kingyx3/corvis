import { randomUUID } from "node:crypto";
import type { AuditEvent, RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { AUDIENCE_ROLES } from "../../../notifications/domain/notifications.ts";
import {
  SESSION_IDLE_TIMEOUT_BOUNDS,
  SESSION_MAX_LENGTH_BOUNDS,
  SessionPolicyValidationError,
  type IdentityProviderView,
  type ScimView,
  type SessionMemberView,
  type SessionPolicy,
  type SessionPolicyUpdate,
  type SessionPolicyView,
  type SignInMethodView,
  type SignOutEverywhereCommand,
  type SignOutEverywhereResult,
} from "../../domain/session-policy.ts";
import { demoSessionPolicyStore } from "../../adapters/session-policy-store.ts";
import { runAuditedMutation } from "../../../governance/server/evidence/audited-mutation.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { assertOrganizationAdmin, DataGovernanceError } from "../../../governance/server/lifecycle/data-governance.ts";
import { readTenantIdentityRecords, type TenantIdentityRecords } from "../directory/identity-records.ts";
import { apiError, json } from "../../../../platform/http/api/http.ts";
import { bestEffortNotification, enqueueForRoleAudience } from "../../../notifications/server/notifications.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";

/**
 * Organization sign-in and session policy (F7, #263), behind `/api/v1/access/session-policy/**`, over either backend
 * (Postgres, or the in-memory demo store in demo mode).
 *
 * What is enforced, and where. The two limits and "sign out everywhere" are decided in SQL (migration 087): the policy
 * bounds are CHECK constraints, the Organization-Admin and compare-and-set rules are in the functions, and the
 * limits are applied by `corvis_control.enforce_session_policy` on every authoritative request
 * (authorization.ts), never only in the UI. This module only authorizes the caller, runs each change together with
 * its audit event in one transaction (`runAuditedMutation`) and queues the mandatory security notice.
 */
export type SessionPolicyChange = { policy: SessionPolicy; previous: SessionPolicy; changed: boolean };

export interface SessionPolicyBackend {
  readonly demo: boolean;
  view(identity: RequestIdentity): Promise<SessionPolicyView>;
  update(identity: RequestIdentity, command: SessionPolicyUpdate, db?: PostgresSqlApi): Promise<SessionPolicyChange>;
  signOut(identity: RequestIdentity, command: SignOutEverywhereCommand, db?: PostgresSqlApi): Promise<SignOutEverywhereResult>;
}

export interface SessionPolicyService {
  view(identity: RequestIdentity): Promise<SessionPolicyView>;
  update(identity: RequestIdentity, command: SessionPolicyUpdate, correlationId: string): Promise<SessionPolicy>;
  signOut(identity: RequestIdentity, command: SignOutEverywhereCommand, correlationId: string): Promise<SignOutEverywhereResult>;
}

/** The session id the OIDC verifier synthesises from the token when the identity provider sends neither `sid` nor `jti`. */
const UNSTABLE_SESSION_PREFIX = "token-";

export const SESSION_POLICY_BOUNDS = {
  idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_BOUNDS,
  maxSessionMinutes: SESSION_MAX_LENGTH_BOUNDS,
} as const;

/** A stale or missing policy as the view shows it: no limits, version 0 (the version a first change is based on). */
export const NO_SESSION_POLICY: SessionPolicy = { idleTimeoutMinutes: null, maxSessionMinutes: null, requireSso: false, version: 0, updatedAt: null, updatedBy: null };

function sessionAuditEvent(identity: RequestIdentity, correlationId: string, action: string, targetType: string, targetId: string, metadata: AuditEvent["metadata"]): AuditEvent {
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType, targetId,
    outcome: "success", correlationId, metadata,
  };
}

export function createSessionPolicyService(backend: SessionPolicyBackend): SessionPolicyService {
  return {
    async view(identity) {
      assertOrganizationAdmin(identity);
      return backend.view(identity);
    },
    async update(identity, command, correlationId) {
      assertOrganizationAdmin(identity);
      // Lock-out safeguard. A limit cannot be measured on a session whose id is not stable (the verifier's `token-<hash>`
      // fallback), and such sessions are refused while a limit is set. If the caller's own session is one, every
      // session of the organization probably is: saving would lock the whole organization out, including the admin who
      // would need to undo it. Clearing both limits is always allowed.
      if ((command.idleTimeoutMinutes !== null || command.maxSessionMinutes !== null) && identity.sessionId.startsWith(UNSTABLE_SESSION_PREFIX)) {
        throw new DataGovernanceError("session_not_measurable", 409);
      }
      const change = await runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.update(identity, command, db),
        // Setting the values the policy already has changed nothing, so there is nothing to audit or announce.
        audit: ({ policy, previous, changed }) => changed ? sessionAuditEvent(identity, correlationId, "access.session_policy.updated", "session_policy", identity.tenantId, {
          previousIdleTimeoutMinutes: previous.idleTimeoutMinutes,
          previousMaxSessionMinutes: previous.maxSessionMinutes,
          previousRequireSso: previous.requireSso,
          idleTimeoutMinutes: policy.idleTimeoutMinutes,
          maxSessionMinutes: policy.maxSessionMinutes,
          requireSso: policy.requireSso,
          version: policy.version,
          reason: command.reason,
        }) : undefined,
      });
      return change.policy;
    },
    async signOut(identity, command, correlationId) {
      assertOrganizationAdmin(identity);
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.signOut(identity, command, db),
        audit: (result) => sessionAuditEvent(identity, correlationId, "access.session.signed_out_everywhere", "user_sessions", result.userId, {
          revokedSessions: result.revokedSessions,
          // F7c (#336): Corvis ends its own sessions but never calls the identity provider. When Corvis support recorded the
          // provider's end-session endpoint, the audit trail says the person's session there still has to be ended.
          idpSessionEndRequired: result.idpEndSessionEndpoint !== null,
          idpEndSessionEndpoint: result.idpEndSessionEndpoint,
          reason: command.reason,
        }),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

function str(row: PostgresRow, key: string): string { return String(row[key]); }
function optionalStr(row: PostgresRow, key: string): string | null { return row[key] == null ? null : String(row[key]); }
function optionalInt(row: PostgresRow, key: string): number | null { return row[key] == null ? null : Number(row[key]); }
function flag(row: PostgresRow, key: string): boolean { return row[key] === true || row[key] === "true"; }

function toPolicy(row: PostgresRow | undefined): SessionPolicy {
  if (!row) return NO_SESSION_POLICY;
  return {
    idleTimeoutMinutes: optionalInt(row, "idle_timeout_minutes"),
    maxSessionMinutes: optionalInt(row, "max_session_minutes"),
    requireSso: flag(row, "require_sso"),
    version: Number(row.version),
    updatedAt: optionalStr(row, "updated_at"),
    updatedBy: optionalStr(row, "updated_by_subject"),
  };
}

const POLICY_COLUMNS = "idle_timeout_minutes, max_session_minutes, require_sso, version, updated_at, updated_by_subject";

/** How a person is named to an administrator: the address they were invited with, otherwise their identity subject. */
/** The sessions of the person `s` that are active now (seen within the idle limit, a day when none is set, inside the maximum length, not signed out); `extra` narrows them. */
const ACTIVE_SESSIONS_SQL = (extra: string): string => `(select count(*) from corvis_control.tenant_session_activity a
            where a.tenant_id = s.tenant_id
              and exists (select 1 from corvis_control.identity_subject x
                where x.tenant_id = a.tenant_id and x.user_id = s.user_id and x.auth_method = a.auth_method and x.subject = a.subject)
              and not exists (select 1 from corvis_control.session_revocation r
                where r.tenant_id = a.tenant_id and r.auth_method = a.auth_method and r.subject = a.subject and r.session_id = a.session_id)
              and a.last_seen_at > now() - make_interval(mins => coalesce(p.idle_timeout_minutes, 1440))
              and (p.max_session_minutes is null or a.first_seen_at > now() - make_interval(mins => p.max_session_minutes))
              ${extra})`;

const MEMBER_LABEL_SQL = `coalesce((select i.email from corvis_control.tenant_invitation i
    where i.tenant_id = s.tenant_id and i.accepted_user_id = s.user_id and i.status = 'accepted' order by i.accepted_at desc limit 1), min(s.subject))`;

export class PostgresSessionPolicyBackend implements SessionPolicyBackend {
  readonly demo = false;
  private readonly defaultDb: () => PostgresSqlApi;
  private readonly issuer: () => string | null;

  constructor(defaultDb: () => PostgresSqlApi, issuer: () => string | null) {
    this.defaultDb = defaultDb;
    this.issuer = issuer;
  }

  async view(identity: RequestIdentity, db: PostgresSqlApi = this.defaultDb()): Promise<SessionPolicyView> {
    const [policyRows, scimRows, methodRows, memberRows, records] = await Promise.all([
      db.query(`select ${POLICY_COLUMNS} from corvis_control.tenant_session_policy where tenant_id = $1::uuid`, [identity.tenantId]),
      // The token hash is never selected: the view says whether SCIM is on, never how to call it.
      db.query(`select c.enabled, c.auth_method, c.default_role_name, c.updated_at, w.display_name as workspace_name,
          (select count(*) from corvis_control.tenant_scim_identity i where i.tenant_id = c.tenant_id and i.active) as active_users
        from corvis_control.tenant_scim_configuration c
        left join corvis_control.workspace w on w.tenant_id = c.tenant_id and w.workspace_id = c.default_workspace_id
        where c.tenant_id = $1::uuid`, [identity.tenantId]),
      db.query(`select auth_method, count(distinct user_id) as users from corvis_control.identity_subject
        where tenant_id = $1::uuid and status = 'active' and auth_method in ('oidc','saml')
        group by auth_method order by auth_method`, [identity.tenantId]),
      // Active sessions: seen within the idle limit (a day when none is set), inside the maximum length, and not signed out.
      db.query(`select s.user_id::text as user_id, ${MEMBER_LABEL_SQL} as label,
          coalesce(bool_or(s.auth_method = $2 and s.subject = $3), false) as is_current,
          ${ACTIVE_SESSIONS_SQL("")} as active_sessions,
          ${ACTIVE_SESSIONS_SQL("and a.mfa_used")} as sessions_with_mfa
        from corvis_control.identity_subject s
        left join corvis_control.tenant_session_policy p on p.tenant_id = s.tenant_id
        where s.tenant_id = $1::uuid and s.status = 'active' and s.auth_method in ('oidc','saml')
        group by s.tenant_id, s.user_id, p.idle_timeout_minutes, p.max_session_minutes
        order by is_current desc, label
        limit 500`, [identity.tenantId, identity.authMethod, identity.subject]),
      // The operator-managed records (migration 095): read-only here, with this tenant's predicate.
      readTenantIdentityRecords(db, identity.tenantId),
    ]);
    const scimRow = scimRows[0];
    const scim: ScimView = scimRow
      ? {
        configured: true,
        enabled: flag(scimRow, "enabled"),
        authMethod: str(scimRow, "auth_method") === "saml" ? "saml" : "oidc",
        defaultWorkspaceName: optionalStr(scimRow, "workspace_name"),
        defaultRole: optionalStr(scimRow, "default_role_name"),
        activeUsers: Number(scimRow.active_users),
        updatedAt: optionalStr(scimRow, "updated_at"),
      }
      : { configured: false, enabled: false, authMethod: null, defaultWorkspaceName: null, defaultRole: null, activeUsers: 0, updatedAt: null };
    const signInMethods: SignInMethodView[] = methodRows.map((row) => ({ authMethod: str(row, "auth_method") === "saml" ? "saml" : "oidc", users: Number(row.users) }));
    const members: SessionMemberView[] = memberRows.map((row) => ({
      userId: str(row, "user_id"),
      label: str(row, "label"),
      isCurrentUser: flag(row, "is_current"),
      activeSessions: Number(row.active_sessions),
      sessionsWithMfa: Number(row.sessions_with_mfa),
    }));
    return {
      policy: toPolicy(policyRows[0]),
      bounds: SESSION_POLICY_BOUNDS,
      identityProvider: this.identityProvider(records.identityProvider),
      verifiedDomains: records.verifiedDomains,
      scim,
      signInMethods,
      // The administrator's own verified token: what the identity provider reported about THIS sign-in, not a stored claim.
      currentSession: { mfaUsed: identity.mfaUsed ?? null, authContext: identity.authContext ?? null },
      members,
    };
  }

  /** The tenant's own recorded provider when Corvis operations set one up; otherwise the single provider every organization shares. */
  private identityProvider(record: TenantIdentityRecords["identityProvider"]): IdentityProviderView {
    if (!record) return { protocol: "oidc", issuer: this.issuer(), audience: null, source: "global", status: null, tokenBindingEnforced: false, idpEnforcesMfa: null, endSessionEndpoint: null };
    return {
      protocol: record.protocol, issuer: record.issuer, audience: record.audience, source: "tenant", status: record.status,
      tokenBindingEnforced: record.enforceTokenBinding, idpEnforcesMfa: record.idpEnforcesMfa, endSessionEndpoint: record.endSessionEndpoint,
    };
  }

  async update(identity: RequestIdentity, command: SessionPolicyUpdate, db: PostgresSqlApi = this.defaultDb()): Promise<SessionPolicyChange> {
    const previous = toPolicy((await db.query(`select ${POLICY_COLUMNS} from corvis_control.tenant_session_policy where tenant_id = $1::uuid`, [identity.tenantId]))[0]);
    const rows = await db.query(`select ${POLICY_COLUMNS} from corvis_control.set_tenant_session_policy($1::uuid,$2,$3,$4::integer,$5::integer,$6::integer,$7::boolean,$8,$9)`, [
      identity.tenantId, identity.authMethod, identity.subject, command.idleTimeoutMinutes, command.maxSessionMinutes, command.expectedVersion,
      // Left out, Require SSO keeps its stored value. The actor's own verified issuer and audience let SQL refuse enabling it from a session it would refuse.
      command.requireSso ?? null, identity.tokenIssuer ?? null, identity.tokenAudience ?? null,
    ]);
    // No row: nothing was set and nothing was asked for, so the policy is still "none".
    const policy = toPolicy(rows[0]);
    const changed = policy.version !== previous.version;
    if (changed) await this.announce(db, identity, "policy_changed");
    return { policy, previous, changed };
  }

  async signOut(identity: RequestIdentity, command: SignOutEverywhereCommand, db: PostgresSqlApi = this.defaultDb()): Promise<SignOutEverywhereResult> {
    const rows = await db.query(`select corvis_control.sign_out_user_everywhere($1::uuid,$2,$3,$4::uuid,$5) as revoked`, [
      identity.tenantId, identity.authMethod, identity.subject, command.userId, command.reason,
    ]);
    const labelRows = await db.query(`select ${MEMBER_LABEL_SQL} as label from corvis_control.identity_subject s
      where s.tenant_id = $1::uuid and s.user_id = $2::uuid group by s.tenant_id, s.user_id`, [identity.tenantId, command.userId]);
    // The recorded end-session endpoint of the identity provider, if Corvis support recorded one: shown to the administrator
    // and written to the audit event, never called (ending the IdP session needs the person's id token or an IdP admin API).
    const endpointRows = await db.query(`select end_session_endpoint from corvis_control.tenant_identity_provider where tenant_id = $1::uuid`, [identity.tenantId]);
    await this.announce(db, identity, "user_signed_out");
    return { userId: command.userId, label: str(labelRows[0]!, "label"), revokedSessions: Number(rows[0]!.revoked), idpEndSessionEndpoint: optionalStr(endpointRows[0] ?? {}, "end_session_endpoint") };
  }

  /**
   * The mandatory security notice to every Organization Admin, queued in the same transaction as the change. It never
   * names the people involved or the new values (emails carry only a short event description); the audit trail does.
   * A failure to queue it is logged but never undoes the change.
   */
  private async announce(db: PostgresSqlApi, identity: RequestIdentity, event: "policy_changed" | "user_signed_out"): Promise<void> {
    await bestEffortNotification(db, `security_policy:${identity.tenantId}`, () => enqueueForRoleAudience(db, {
      tenantId: identity.tenantId,
      workspaceId: null,
      roles: AUDIENCE_ROLES.organization_admins,
      category: "security_policy",
      params: { event },
      dedupeBase: `security_policy:${randomUUID()}`,
    }), { inTransaction: true });
  }
}

export const postgresSessionPolicyService: SessionPolicyService = createSessionPolicyService(
  new PostgresSessionPolicyBackend(() => postgres(getServerConfig().databaseDsn), () => getServerConfig().authIssuer ?? null),
);
export const demoSessionPolicyService: SessionPolicyService = createSessionPolicyService(demoSessionPolicyStore());

let override: SessionPolicyService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideSessionPolicyService(service?: SessionPolicyService): void { override = service; }

export function sessionPolicyService(): SessionPolicyService {
  return override ?? (getServerConfig().demoMode ? demoSessionPolicyService : postgresSessionPolicyService);
}

/** Typed failures keep their stable code and status; everything else goes through the shared API error mapper. */
export function sessionPolicyErrorResponse(error: unknown, correlationId: string): Response {
  if (error instanceof DataGovernanceError || error instanceof SessionPolicyValidationError) {
    return json({ error: error.code, correlationId }, { status: error.status });
  }
  return apiError(error, correlationId);
}
