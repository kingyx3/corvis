import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  SERVICE_ACCOUNT_LIMIT,
  SERVICE_ACCOUNT_CREDENTIAL_HISTORY,
  credentialStatus,
  expiresSoon,
  serviceAccountLifecycle,
  type CreateServiceAccountCommand,
  type ServiceAccount,
  type ServiceAccountCommand,
  type ServiceAccountCreated,
  type ServiceAccountCredential,
  type ServiceAccountCredentialIssued,
  type ServiceAccountList,
  type ServiceAccountRole,
} from "../../core/service-account.ts";
import { ServiceAccountError, daysFromNow, type ServiceAccountBackend } from "../../lib/server/service-account.ts";
import { hashCredentialSecret, mintCredential } from "../../lib/server/service-account-credential.ts";

/**
 * In-memory service accounts for demo mode and the browser suites; not production evidence. Each demo tenant gets its
 * own seeded accounts on first use (one whose credential expires soon and so is flagged, one in regular use, and one
 * that was deactivated), so a test that creates, rotates or revokes under its own demo tenant header never disturbs
 * another. The rules are the Postgres rules (migration 088): the same roles, lifetimes, one current credential, a
 * rotation overlap that ends any earlier overlap, immediate revocation, a name that is unique among active accounts,
 * and a quota. Secrets are minted and hashed exactly as in production and only the hash is held.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COLLEAGUE = "morgan.lee@meridian.example";

type StoredCredential = {
  credentialId: string;
  secretSha256: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  endsAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
type StoredAccount = {
  serviceAccountId: string;
  userId: string;
  name: string;
  purpose: string;
  workspaceId: string;
  workspaceName: string;
  roleName: ServiceAccountRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  disabled: { at: string; by: string; reason: string } | null;
  credentials: StoredCredential[];
};

export class DemoServiceAccountStore implements ServiceAccountBackend {
  readonly demo = true;
  private readonly tenants = new Map<string, StoredAccount[]>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) { this.now = now; }

  private iso(offsetMs = 0): string { return new Date(this.now().getTime() + offsetMs).toISOString(); }

  private accounts(identity: RequestIdentity): StoredAccount[] {
    let accounts = this.tenants.get(identity.tenantId);
    if (!accounts) {
      accounts = this.seeds(identity);
      this.tenants.set(identity.tenantId, accounts);
    }
    return accounts;
  }

  private workspaceName(identity: RequestIdentity): string { return identity.workspaceDisplayName ?? "Primary Workspace"; }

  private seeds(identity: RequestIdentity): StoredAccount[] {
    const credential = (createdOffset: number, expiresOffset: number, lastUsedOffset: number | null, extra: Partial<StoredCredential> = {}): StoredCredential => ({
      credentialId: randomUUID(), secretSha256: hashCredentialSecret(randomUUID()), createdBy: COLLEAGUE, createdAt: this.iso(createdOffset),
      expiresAt: this.iso(expiresOffset), endsAt: null, revokedAt: null, lastUsedAt: lastUsedOffset === null ? null : this.iso(lastUsedOffset), ...extra,
    });
    const account = (name: string, purpose: string, roleName: ServiceAccountRole, createdOffset: number, expiresOffset: number, credentials: StoredCredential[], disabled: StoredAccount["disabled"] = null): StoredAccount => ({
      serviceAccountId: randomUUID(), userId: randomUUID(), name, purpose, workspaceId: identity.workspaceId, workspaceName: this.workspaceName(identity), roleName,
      createdBy: COLLEAGUE, createdAt: this.iso(createdOffset), expiresAt: this.iso(expiresOffset), disabled, credentials,
    });
    return [
      account("Nightly reporting sync", "Pulls published fund data into the reporting warehouse every night", "analyst", -200 * DAY_MS, 165 * DAY_MS,
        [credential(-85 * DAY_MS, 9 * DAY_MS, -2 * HOUR_MS)]),
      account("Compliance export reader", "Reads approved observations for the compliance archive", "viewer", -30 * DAY_MS, 335 * DAY_MS,
        [credential(-30 * DAY_MS, 60 * DAY_MS, -3 * DAY_MS)]),
      account("Retired data bridge", "Legacy integration, replaced by the nightly reporting sync", "reviewer", -300 * DAY_MS, 65 * DAY_MS,
        [credential(-300 * DAY_MS, 20 * DAY_MS, -40 * DAY_MS, { endsAt: this.iso(-35 * DAY_MS), revokedAt: this.iso(-35 * DAY_MS) })],
        { at: this.iso(-35 * DAY_MS), by: COLLEAGUE, reason: "Replaced by the nightly reporting sync" }),
    ];
  }

  private view(account: StoredAccount): ServiceAccount {
    const now = this.now();
    const credentials: ServiceAccountCredential[] = [...account.credentials]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.credentialId < b.credentialId ? 1 : -1))
      .slice(0, SERVICE_ACCOUNT_CREDENTIAL_HISTORY)
      .map((stored) => {
        const status = credentialStatus({ revoked: stored.revokedAt !== null, expiresAt: stored.expiresAt, endsAt: stored.endsAt }, now);
        return {
          credentialId: stored.credentialId, status, createdBy: stored.createdBy, createdAt: stored.createdAt, expiresAt: stored.expiresAt,
          endsAt: stored.endsAt, revokedAt: stored.revokedAt, lastUsedAt: stored.lastUsedAt, expiringSoon: status === "active" && expiresSoon(stored.expiresAt, now),
        };
      });
    return {
      serviceAccountId: account.serviceAccountId, userId: account.userId, name: account.name, purpose: account.purpose, workspaceId: account.workspaceId,
      workspaceName: account.workspaceName, roleName: account.roleName, createdBy: account.createdBy, createdAt: account.createdAt, expiresAt: account.expiresAt,
      disabledAt: account.disabled?.at ?? null, disabledBy: account.disabled?.by ?? null, disableReason: account.disabled?.reason ?? null, credentials,
      ...serviceAccountLifecycle({ disabled: account.disabled !== null, expiresAt: account.expiresAt, credentials }, now),
    };
  }

  private find(identity: RequestIdentity, serviceAccountId: string): StoredAccount {
    const account = this.accounts(identity).find((candidate) => candidate.serviceAccountId === serviceAccountId);
    if (!account) throw new ServiceAccountError("service_account_not_found", 404);
    return account;
  }

  async list(identity: RequestIdentity): Promise<ServiceAccountList> {
    const serviceAccounts = [...this.accounts(identity)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((account) => this.view(account));
    return { serviceAccounts, workspaces: [{ workspaceId: identity.workspaceId, name: this.workspaceName(identity) }] };
  }

  async get(identity: RequestIdentity, serviceAccountId: string): Promise<ServiceAccount> {
    return this.view(this.find(identity, serviceAccountId));
  }

  async create(identity: RequestIdentity, command: CreateServiceAccountCommand): Promise<ServiceAccountCreated> {
    if (command.workspaceId !== identity.workspaceId) throw new ServiceAccountError("workspace_not_found", 404);
    const accounts = this.accounts(identity);
    const active = accounts.filter((account) => account.disabled === null);
    if (active.some((account) => account.name.toLowerCase() === command.name.toLowerCase())) throw new ServiceAccountError("service_account_name_in_use", 409);
    if (active.length >= SERVICE_ACCOUNT_LIMIT) throw new ServiceAccountError("service_account_limit_reached", 409);
    const expiresAt = daysFromNow(command.expiresInDays, this.now());
    const minted = mintCredential();
    const credential = this.newCredential(identity, minted, daysFromNow(command.credentialExpiresInDays, this.now()), expiresAt);
    const account: StoredAccount = {
      serviceAccountId: randomUUID(), userId: randomUUID(), name: command.name, purpose: command.purpose, workspaceId: command.workspaceId,
      workspaceName: this.workspaceName(identity), roleName: command.roleName, createdBy: identity.subject, createdAt: this.iso(), expiresAt, disabled: null, credentials: [credential],
    };
    accounts.push(account);
    return { serviceAccount: this.view(account), credential: { credentialId: minted.credentialId, secret: minted.secret, expiresAt: credential.expiresAt } };
  }

  /** A credential never outlives its account. */
  private newCredential(identity: RequestIdentity, minted: { credentialId: string; secretSha256: string }, expiresAt: string, accountExpiresAt: string): StoredCredential {
    return {
      credentialId: minted.credentialId, secretSha256: minted.secretSha256, createdBy: identity.subject, createdAt: this.iso(),
      expiresAt: new Date(Math.min(Date.parse(expiresAt), Date.parse(accountExpiresAt))).toISOString(), endsAt: null, revokedAt: null, lastUsedAt: null,
    };
  }

  async issueCredential(identity: RequestIdentity, serviceAccountId: string, command: Extract<ServiceAccountCommand, { action: "issue" | "rotate" }>): Promise<ServiceAccountCredentialIssued> {
    const account = this.find(identity, serviceAccountId);
    const now = this.now().getTime();
    if (account.disabled !== null || Date.parse(account.expiresAt) <= now) throw new ServiceAccountError("service_account_not_active", 409);
    // A current credential whose own expiry has passed no longer counts.
    for (const stored of account.credentials) {
      if (stored.revokedAt === null && stored.endsAt === null && Date.parse(stored.expiresAt) <= now) stored.endsAt = stored.expiresAt;
    }
    const current = account.credentials.find((stored) => stored.revokedAt === null && stored.endsAt === null);
    if (command.action === "issue" && current) throw new ServiceAccountError("service_account_credential_exists", 409);
    if (command.action === "rotate" && !current) throw new ServiceAccountError("service_account_no_active_credential", 409);
    if (current) {
      // Anything already rotating out is ended now, then the current credential starts its overlap.
      for (const stored of account.credentials) {
        if (stored.revokedAt === null && stored.endsAt !== null && Date.parse(stored.endsAt) > now) stored.endsAt = this.iso();
      }
      const overlap = command.action === "rotate" ? command.overlapMinutes : 0;
      current.endsAt = new Date(Math.min(now + overlap * 60_000, Date.parse(current.expiresAt))).toISOString();
    }
    const minted = mintCredential();
    const credential = this.newCredential(identity, minted, daysFromNow(command.credentialExpiresInDays, this.now()), account.expiresAt);
    account.credentials.push(credential);
    return { serviceAccount: this.view(account), credential: { credentialId: minted.credentialId, secret: minted.secret, expiresAt: credential.expiresAt } };
  }

  async revoke(identity: RequestIdentity, serviceAccountId: string): Promise<{ serviceAccount: ServiceAccount; revokedCredentials: number }> {
    const account = this.find(identity, serviceAccountId);
    const now = this.now().getTime();
    const inUse = account.credentials.filter((stored) => stored.revokedAt === null && Date.parse(stored.expiresAt) > now && (stored.endsAt === null || Date.parse(stored.endsAt) > now));
    if (inUse.length === 0) throw new ServiceAccountError("service_account_no_active_credential", 409);
    for (const stored of inUse) { stored.revokedAt = this.iso(); stored.endsAt = stored.revokedAt; }
    return { serviceAccount: this.view(account), revokedCredentials: inUse.length };
  }

  async disable(identity: RequestIdentity, serviceAccountId: string, reason: string): Promise<ServiceAccount> {
    const account = this.find(identity, serviceAccountId);
    if (account.disabled !== null) throw new ServiceAccountError("service_account_not_active", 409);
    const at = this.iso();
    for (const stored of account.credentials) {
      if (stored.revokedAt === null) {
        stored.revokedAt = at;
        stored.endsAt = stored.endsAt !== null && stored.endsAt < at ? stored.endsAt : at;
      }
    }
    account.disabled = { at, by: identity.subject, reason };
    return this.view(account);
  }
}

// On `globalThis` so `next dev` re-evaluating this module (it does when another route is compiled) cannot reset the demo accounts mid-flow.
const shared = globalThis as typeof globalThis & { demoServiceAccountStore?: DemoServiceAccountStore };
/** The process-wide demo store. */
export function demoServiceAccountStore(): DemoServiceAccountStore {
  shared.demoServiceAccountStore ??= new DemoServiceAccountStore();
  return shared.demoServiceAccountStore;
}
