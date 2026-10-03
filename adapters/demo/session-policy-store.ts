import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  SESSION_IDLE_TIMEOUT_BOUNDS,
  SESSION_MAX_LENGTH_BOUNDS,
  type SessionPolicy,
  type SessionPolicyUpdate,
  type SessionPolicyView,
  type SignOutEverywhereCommand,
  type SignOutEverywhereResult,
} from "../../core/session-policy.ts";
import { DataGovernanceError } from "../../lib/server/data-governance.ts";
import type { SessionPolicyBackend, SessionPolicyChange } from "../../lib/server/session-policy.ts";

/**
 * In-memory session policy for demo mode and the browser suites; not production evidence. Each demo tenant gets its own
 * state on first use, so a test that changes the policy or signs a colleague out under its own demo tenant header
 * never disturbs another. The rules are the Postgres rules: the same Corvis bounds, a stale version is refused,
 * the same values change nothing, and the caller cannot sign themselves out. Demo mode has no real sessions (every
 * request is a fresh demo identity), so nothing is enforced on requests here: the people and their sessions are a
 * fixed illustration, and signing one out only clears that illustration.
 */

type DemoMember = { userId: string; label: string; subject: string; sessions: number };

type TenantState = { policy: SessionPolicy; members: DemoMember[] };

const NO_POLICY: SessionPolicy = { idleTimeoutMinutes: null, maxSessionMinutes: null, version: 0, updatedAt: null, updatedBy: null };

function seed(identity: RequestIdentity): TenantState {
  return {
    policy: NO_POLICY,
    members: [
      { userId: "00000000-0000-4000-8000-0000000000d1", label: identity.subject, subject: identity.subject, sessions: 1 },
      { userId: "00000000-0000-4000-8000-0000000000d2", label: "morgan.lee@meridian.example", subject: "demo|morgan", sessions: 2 },
      { userId: "00000000-0000-4000-8000-0000000000d3", label: "alex.chen@meridian.example", subject: "demo|alex", sessions: 1 },
      { userId: "00000000-0000-4000-8000-0000000000d4", label: "priya.nair@meridian.example", subject: "demo|priya", sessions: 0 },
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
    return {
      policy: state.policy,
      bounds: { idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_BOUNDS, maxSessionMinutes: SESSION_MAX_LENGTH_BOUNDS },
      identityProvider: { protocol: "oidc", issuer: "https://login.meridian.example/demo" },
      scim: { configured: true, enabled: true, authMethod: "oidc", defaultWorkspaceName: "Primary Workspace", defaultRole: "viewer", activeUsers: 12, updatedAt: "2026-08-14T09:00:00.000Z" },
      signInMethods: [{ authMethod: "oidc", users: state.members.length }],
      members: state.members.map((member) => ({ userId: member.userId, label: member.label, isCurrentUser: member.subject === identity.subject, activeSessions: member.sessions })),
    };
  }

  async update(identity: RequestIdentity, command: SessionPolicyUpdate): Promise<SessionPolicyChange> {
    const state = this.state(identity);
    const previous = state.policy;
    if (command.expectedVersion !== previous.version) throw new DataGovernanceError("session_policy_version_conflict", 409);
    if (command.idleTimeoutMinutes === previous.idleTimeoutMinutes && command.maxSessionMinutes === previous.maxSessionMinutes) {
      return { policy: previous, previous, changed: false };
    }
    state.policy = {
      idleTimeoutMinutes: command.idleTimeoutMinutes,
      maxSessionMinutes: command.maxSessionMinutes,
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
    return { userId: member.userId, label: member.label, revokedSessions };
  }
}

let singleton: DemoSessionPolicyStore | undefined;
export function demoSessionPolicyStore(): DemoSessionPolicyStore {
  if (!singleton) singleton = new DemoSessionPolicyStore();
  return singleton;
}
