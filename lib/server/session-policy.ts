import { randomUUID } from "node:crypto";
import type { AuditEvent, RequestIdentity } from "../../core/enterprise.ts";
import { AUDIENCE_ROLES } from "../../core/notifications.ts";
import {
  SESSION_IDLE_TIMEOUT_BOUNDS,
  SESSION_MAX_LENGTH_BOUNDS,
  SessionPolicyValidationError,
  type ScimView,
  type SessionMemberView,
  type SessionPolicy,
  type SessionPolicyUpdate,
  type SessionPolicyView,
  type SignInMethodView,
  type SignOutEverywhereCommand,
  type SignOutEverywhereResult,
} from "../../core/session-policy.ts";
import { demoSessionPolicyStore } from "../../adapters/demo/session-policy-store.ts";
import { runAuditedMutation } from "./audited-mutation.ts";
import { getServerConfig } from "./config.ts";
import { assertOrganizationAdmin, DataGovernanceError } from "./data-governance.ts";
import { apiError, json } from "./http.ts";
import { bestEffortNotification, enqueueForRoleAudience } from "./notifications.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

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

export const SESSION_POLICY_BOUNDS = {
  idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_BOUNDS,
  maxSessionMinutes: SESSION_MAX_LENGTH_BOUNDS,
} as const;

/** A stale or missing policy as the view shows it: no limits, version 0 (the version a first change is based on). */
export const NO_SESSION_POLICY: SessionPolicy = { idleTimeoutMinutes: null, maxSessionMinutes: null, version: 0, updatedAt: null, updatedBy: null };

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
      const change = await runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.update(identity, command, db),
        // Setting the values the policy already has changed nothing, so there is nothing to audit or announce.
        audit: ({ policy, previous, changed }) => changed ? sessionAuditEvent(identity, correlationId, "access.session_policy.updated", "session_policy", identity.tenantId, {
          previousIdleTimeoutMinutes: previous.idleTimeoutMinutes,
          previousMaxSessionMinutes: previous.maxSessionMinutes,
          idleTimeoutMinutes: policy.idleTimeoutMinutes,
          maxSessionMinutes: policy.maxSessionMinutes,
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
    version: Number(row.version),
    updatedAt: optionalStr(row, "updated_at"),
    updatedBy: optionalStr(row, "updated_by_subject"),
  };
}

const POLICY_COLUMNS = "idle_timeout_minutes, max_session_minutes, version, updated_at, updated_by_subject";

/** How a person is named to an administrator: the address they were invited with, otherwise their identity subject. */
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
    const [policyRows, scimRows, methodRows, memberRows] = await Promise.all([
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
          (select count(*) from corvis_control.tenant_session_activity a
            where a.tenant_id = s.tenant_id
              and exists (select 1 from corvis_control.identity_subject x
                where x.tenant_id = a.tenant_id and x.user_id = s.user_id and x.auth_method = a.auth_method and x.subject = a.subject)
              and not exists (select 1 from corvis_control.session_revocation r
                where r.tenant_id = a.tenant_id and r.auth_method = a.auth_method and r.subject = a.subject and r.session_id = a.session_id)
              and a.last_seen_at > now() - make_interval(mins => coalesce(p.idle_timeout_minutes, 1440))
              and (p.max_session_minutes is null or a.first_seen_at > now() - make_interval(mins => p.max_session_minutes))) as active_sessions
        from corvis_control.identity_subject s
        left join corvis_control.tenant_session_policy p on p.tenant_id = s.tenant_id
        where s.tenant_id = $1::uuid and s.status = 'active' and s.auth_method in ('oidc','saml')
        group by s.tenant_id, s.user_id, p.idle_timeout_minutes, p.max_session_minutes
        order by is_current desc, label
        limit 500`, [identity.tenantId, identity.authMethod, identity.subject]),
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
    }));
    return {
      policy: toPolicy(policyRows[0]),
      bounds: SESSION_POLICY_BOUNDS,
      identityProvider: { protocol: "oidc", issuer: this.issuer() },
      scim,
      signInMethods,
      members,
    };
  }

  async update(identity: RequestIdentity, command: SessionPolicyUpdate, db: PostgresSqlApi = this.defaultDb()): Promise<SessionPolicyChange> {
    const previous = toPolicy((await db.query(`select ${POLICY_COLUMNS} from corvis_control.tenant_session_policy where tenant_id = $1::uuid`, [identity.tenantId]))[0]);
    const rows = await db.query(`select ${POLICY_COLUMNS} from corvis_control.set_tenant_session_policy($1::uuid,$2,$3,$4::integer,$5::integer,$6::integer)`, [
      identity.tenantId, identity.authMethod, identity.subject, command.idleTimeoutMinutes, command.maxSessionMinutes, command.expectedVersion,
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
    await this.announce(db, identity, "user_signed_out");
    return { userId: command.userId, label: str(labelRows[0]!, "label"), revokedSessions: Number(rows[0]!.revoked) };
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
  new PostgresSessionPolicyBackend(() => postgres(getServerConfig().postgresDsn), () => getServerConfig().authIssuer ?? null),
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
