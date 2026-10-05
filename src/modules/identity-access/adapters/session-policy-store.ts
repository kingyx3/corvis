import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  SESSION_IDLE_TIMEOUT_BOUNDS,
  SESSION_MAX_LENGTH_BOUNDS,
  type SessionPolicy,
  type SessionPolicyUpdate,
  type SessionPolicyView,
  type SignOutEverywhereCommand,
  type SignOutEverywhereResult,
} from "../domain/session-policy.ts";
import { DataGovernanceError } from "../../governance/server/data-governance.ts";
import type { SessionPolicyBackend, SessionPolicyChange } from "../server/session-policy.ts";

/**
 * In-memory session policy for demo mode and the browser suites; not production evidence. Each demo tenant gets its own
 * state on first use, so a test that changes the policy or signs a colleague out under its own demo tenant header
 * never disturbs another. The rules are the Postgres rules: the same Corvis bounds, a stale version is refused,
 * the same values change nothing, and the caller cannot sign themselves out. Demo mode has no real sessions (every
 * request is a fresh demo identity), so nothing is enforced on requests here: the people and their sessions are a
 * fixed illustration, and signing one out only clears that illustration.
 */

type DemoMember = { userId: string; label: string; subject: string; sessions: number; mfaSessions: number };

type TenantState = { policy: SessionPolicy; members: DemoMember[] };

const NO_POLICY: SessionPolicy = { idleTimeoutMinutes: null, maxSessionMinutes: null, requireSso: false, version: 0, updatedAt: null, updatedBy: null };

/**
 * A demo tenant whose id starts with this prefix illustrates an organization whose identity provider is recorded with token
 * binding on (so Require SSO can be turned on), reports that it enforces MFA and has an end-session endpoint. Any other demo
 * tenant illustrates one whose record binds nothing, reports nothing about MFA and has no endpoint.
 */
export const DEMO_SSO_READY_TENANT_PREFIX = "sso-ready-";

function seed(identity: RequestIdentity): TenantState {
  return {
    policy: NO_POLICY,
    members: [
      { userId: "00000000-0000-4000-8000-0000000000d1", label: identity.subject, subject: identity.subject, sessions: 1, mfaSessions: 0 },
      { userId: "00000000-0000-4000-8000-0000000000d2", label: "morgan.lee@meridian.example", subject: "demo|morgan", sessions: 2, mfaSessions: 1 },
      { userId: "00000000-0000-4000-8000-0000000000d3", label: "alex.chen@meridian.example", subject: "demo|alex", sessions: 1, mfaSessions: 0 },
      { userId: "00000000-0000-4000-8000-0000000000d4", label: "priya.nair@meridian.example", subject: "demo|priya", sessions: 0, mfaSessions: 0 },
    ],
  };
}

export class DemoSessionPolicyStore implements SessionPolicyBackend {
  readonly demo = true;
  private readonly tenants = new Map<string, TenantState>();

  private state(identity: RequestIdentity): TenantState {
    let state = this.tenants.get(identity.tenantId);
    if (!state) { state = seed(identity); this.tenants.set(identity.tenantId, state); }
    return state;
  }

  async view(identity: RequestIdentity): Promise<SessionPolicyView> {
    const state = this.state(identity);
    const ssoReady = identity.tenantId.startsWith(DEMO_SSO_READY_TENANT_PREFIX);
    return {
      policy: state.policy,
      bounds: { idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_BOUNDS, maxSessionMinutes: SESSION_MAX_LENGTH_BOUNDS },
      // A fixed illustration of what Corvis operations record: the organization's own provider and one verified domain.
      identityProvider: { protocol: "oidc", issuer: "https://login.meridian.example/demo", audience: "corvis-meridian", source: "tenant", status: "active", tokenBindingEnforced: ssoReady, idpEnforcesMfa: ssoReady ? true : null, endSessionEndpoint: ssoReady ? "https://login.meridian.example/demo/logout" : null },
      verifiedDomains: [{ domain: "meridian.example", verificationMethod: "dns_txt", verifiedAt: "2026-08-12T09:00:00.000Z" }],
      scim: { configured: true, enabled: true, authMethod: "oidc", defaultWorkspaceName: "Primary Workspace", defaultRole: "viewer", activeUsers: 12, updatedAt: "2026-08-14T09:00:00.000Z" },
      signInMethods: [{ authMethod: "oidc", users: state.members.length }],
      currentSession: { mfaUsed: identity.mfaUsed ?? null, authContext: identity.authContext ?? null },
      members: state.members.map((member) => ({ userId: member.userId, label: member.label, isCurrentUser: member.subject === identity.subject, activeSessions: member.sessions, sessionsWithMfa: member.mfaSessions })),
    };
  }

  async update(identity: RequestIdentity, command: SessionPolicyUpdate): Promise<SessionPolicyChange> {
    const state = this.state(identity);
    const previous = state.policy;
    if (command.expectedVersion !== previous.version) throw new DataGovernanceError("session_policy_version_conflict", 409);
    const requireSso = command.requireSso ?? previous.requireSso;
    // The Postgres rule: Require SSO needs a recorded, bound OpenID Connect provider. The demo session is taken to be the SSO session of a bound organization.
    if (requireSso && !previous.requireSso && !identity.tenantId.startsWith(DEMO_SSO_READY_TENANT_PREFIX)) throw new DataGovernanceError("sso_requires_token_binding", 409);
    if (command.idleTimeoutMinutes === previous.idleTimeoutMinutes && command.maxSessionMinutes === previous.maxSessionMinutes && requireSso === previous.requireSso) {
      return { policy: previous, previous, changed: false };
    }
    state.policy = {
      idleTimeoutMinutes: command.idleTimeoutMinutes,
      maxSessionMinutes: command.maxSessionMinutes,
      requireSso,
      version: previous.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: identity.subject,
    };
    return { policy: state.policy, previous, changed: true };
  }

  async signOut(identity: RequestIdentity, command: SignOutEverywhereCommand): Promise<SignOutEverywhereResult> {
    const member = this.state(identity).members.find((candidate) => candidate.userId === command.userId);
    if (!member) throw new DataGovernanceError("member_not_found", 404);
    if (member.subject === identity.subject) throw new DataGovernanceError("cannot_sign_out_current_user", 409);
    const revokedSessions = member.sessions;
    member.sessions = 0;
    member.mfaSessions = 0;
    return {
      userId: member.userId, label: member.label, revokedSessions,
      idpEndSessionEndpoint: identity.tenantId.startsWith(DEMO_SSO_READY_TENANT_PREFIX) ? "https://login.meridian.example/demo/logout" : null,
    };
  }
}

let singleton: DemoSessionPolicyStore | undefined;
export function demoSessionPolicyStore(): DemoSessionPolicyStore {
  if (!singleton) singleton = new DemoSessionPolicyStore();
  return singleton;
}
