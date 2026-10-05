import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  SERVICE_ACCOUNT_ENTITLEMENT_LIMIT,
  SERVICE_ACCOUNT_LIMIT,
  SERVICE_ACCOUNT_CREDENTIAL_HISTORY,
  credentialStatus,
  expiresSoon,
  serviceAccountLifecycle,
  minimumExtensionDays,
  type CreateServiceAccountCommand,
  type ServiceAccount,
  type ServiceAccountCommand,
  type ServiceAccountCreated,
  type ServiceAccountCredential,
  type ServiceAccountCredentialIssued,
  type ServiceAccountEntitlement,
  type ServiceAccountGrantableResource,
  type ServiceAccountList,
  type ServiceAccountResourceType,
  type ServiceAccountRole,
} from "../domain/service-account.ts";
import { ServiceAccountError, daysFromNow, type ServiceAccountBackend, type ServiceAccountResourceRef } from "../server/service-account.ts";
import { hashCredentialSecret, mintCredential } from "../server/service-account-credential.ts";
import { documents as demoDocuments, fundSnapshots } from "../../../platform/demo/catalog.ts";

/**
 * In-memory service accounts for demo mode and the browser suites; not production evidence. Each demo tenant gets its
 * own seeded accounts on first use (one whose credential expires soon and so is flagged, one in regular use, one owned by a
 * deactivated administrator and so needing a new owner, and one
 * that was deactivated), so a test that creates, rotates or revokes under its own demo tenant header never disturbs
 * another. The rules are the Postgres rules (migration 088): the same roles, lifetimes, one current credential, a
 * rotation overlap that ends any earlier overlap, immediate revocation, a name that is unique among active accounts,
 * and a quota. Secrets are minted and hashed exactly as in production and only the hash is held.
 */

/**
 * The demo organization's contractual data rights, for entitlement self-service: the funds and documents it is licensed to see.
 * The catalog also holds a fund and a document the organization is NOT licensed for, so a grant beyond the organization's
 * rights is refused here exactly as the database refuses it.
 */
const LICENSED_FUND_IDS: readonly string[] = ["fund-advent-viii", "fund-nordic-v", "fund-eqt-ix"];
const LICENSED_DOCUMENT_IDS: readonly string[] = ["doc-adv-viii-q2", "doc-nordic-v-q2"];

function resourceLabel(resourceType: ServiceAccountResourceType, resourceId: string): string {
  if (resourceType === "fund") return fundSnapshots.find((snapshot) => snapshot.fundId === resourceId)?.fund ?? resourceId;
  return demoDocuments.find((document) => document.id === resourceId)?.name ?? resourceId;
}

function licensed(resourceType: ServiceAccountResourceType, resourceId: string): boolean {
  return (resourceType === "fund" ? LICENSED_FUND_IDS : LICENSED_DOCUMENT_IDS).includes(resourceId);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COLLEAGUE = "morgan.lee@meridian.example";
const SECOND_ADMIN = "priya.nair@meridian.example";
/** An Organization Admin who was deactivated: the accounts they own need a new owner. */
const FORMER_ADMIN = "alex.rivera@meridian.example";

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
  owner: { subject: string; assignedAt: string };
  disabled: { at: string; by: string; reason: string } | null;
  credentials: StoredCredential[];
  entitlements: Array<{ resourceType: ServiceAccountResourceType; resourceId: string; grantedAt: string }>;
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
    const grant = (resourceType: ServiceAccountResourceType, resourceId: string, offset: number) => ({ resourceType, resourceId, grantedAt: this.iso(offset) });
    const account = (name: string, purpose: string, roleName: ServiceAccountRole, createdOffset: number, expiresOffset: number, credentials: StoredCredential[], disabled: StoredAccount["disabled"] = null, creator = COLLEAGUE, entitlements: StoredAccount["entitlements"] = []): StoredAccount => ({
      serviceAccountId: randomUUID(), userId: randomUUID(), name, purpose, workspaceId: identity.workspaceId, workspaceName: this.workspaceName(identity), roleName,
      createdBy: creator, createdAt: this.iso(createdOffset), expiresAt: this.iso(expiresOffset), owner: { subject: creator, assignedAt: this.iso(createdOffset) }, disabled, credentials, entitlements,
    });
    return [
      account("Nightly reporting sync", "Pulls published fund data into the reporting warehouse every night", "analyst", -200 * DAY_MS, 165 * DAY_MS,
        [credential(-85 * DAY_MS, 9 * DAY_MS, -2 * HOUR_MS)], null, COLLEAGUE, [grant("fund", "fund-advent-viii", -150 * DAY_MS), grant("fund", "fund-eqt-ix", -150 * DAY_MS)]),
      // Its fund is outside the organization's data rights (they lapsed): the grant is on record but gives it nothing.
      account("Compliance export reader", "Reads approved observations for the compliance archive", "viewer", -30 * DAY_MS, 335 * DAY_MS,
        [credential(-30 * DAY_MS, 60 * DAY_MS, -3 * DAY_MS)], null, COLLEAGUE, [grant("fund", "fund-hg-genesis-9", -30 * DAY_MS)]),
      // Created, and so owned, by an administrator who has since been deactivated: it keeps working and needs a new owner.
      account("Partner data feed", "Receives a partner's published reference data", "viewer", -90 * DAY_MS, 275 * DAY_MS,
        [credential(-60 * DAY_MS, 40 * DAY_MS, -1 * DAY_MS)], null, FORMER_ADMIN),
      account("Retired data bridge", "Legacy integration, replaced by the nightly reporting sync", "reviewer", -300 * DAY_MS, 65 * DAY_MS,
        [credential(-300 * DAY_MS, 20 * DAY_MS, -40 * DAY_MS, { endsAt: this.iso(-35 * DAY_MS), revokedAt: this.iso(-35 * DAY_MS) })],
        { at: this.iso(-35 * DAY_MS), by: COLLEAGUE, reason: "Replaced by the nightly reporting sync" }),
    ];
  }

  /** The Organization Admins of a demo tenant who are active: whoever is signed in and two colleagues. The former admin is not. */
  private activeAdmins(identity: RequestIdentity): string[] {
    return [...new Set([identity.subject, COLLEAGUE, SECOND_ADMIN])].sort();
  }

  private view(account: StoredAccount, identity: RequestIdentity): ServiceAccount {
    const now = this.now();
    const ownerActive = this.activeAdmins(identity).includes(account.owner.subject);
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
    const entitlements: ServiceAccountEntitlement[] = [...account.entitlements]
      .sort((a, b) => (a.resourceType === b.resourceType ? (a.resourceId < b.resourceId ? -1 : 1) : a.resourceType < b.resourceType ? -1 : 1))
      .map((stored) => ({
        resourceType: stored.resourceType, resourceId: stored.resourceId, label: resourceLabel(stored.resourceType, stored.resourceId), permission: "read",
        grantedAt: stored.grantedAt, withinDataRights: licensed(stored.resourceType, stored.resourceId),
      }));
    return {
      serviceAccountId: account.serviceAccountId, userId: account.userId, name: account.name, purpose: account.purpose, workspaceId: account.workspaceId,
      workspaceName: account.workspaceName, roleName: account.roleName, createdBy: account.createdBy, createdAt: account.createdAt, expiresAt: account.expiresAt,
      disabledAt: account.disabled?.at ?? null, disabledBy: account.disabled?.by ?? null, disableReason: account.disabled?.reason ?? null,
      ownerSubject: account.owner.subject, ownerAssignedAt: account.owner.assignedAt, ownerActive, credentials, entitlements,
      ...serviceAccountLifecycle({ disabled: account.disabled !== null, expiresAt: account.expiresAt, ownerActive, credentials, entitlementCount: entitlements.length }, now),
    };
  }

  private find(identity: RequestIdentity, serviceAccountId: string): StoredAccount {
    const account = this.accounts(identity).find((candidate) => candidate.serviceAccountId === serviceAccountId);
    if (!account) throw new ServiceAccountError("service_account_not_found", 404);
    return account;
  }

  async list(identity: RequestIdentity): Promise<ServiceAccountList> {
    const serviceAccounts = [...this.accounts(identity)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((account) => this.view(account, identity));
    const grantable: ServiceAccountGrantableResource[] = [
      ...LICENSED_FUND_IDS.map((resourceId) => ({ resourceType: "fund" as const, resourceId, label: resourceLabel("fund", resourceId) })),
      ...LICENSED_DOCUMENT_IDS.map((resourceId) => ({ resourceType: "document" as const, resourceId, label: resourceLabel("document", resourceId) })),
    ];
    return { serviceAccounts, workspaces: [{ workspaceId: identity.workspaceId, name: this.workspaceName(identity) }], owners: this.activeAdmins(identity).map((subject) => ({ subject })), grantable };
  }

  async get(identity: RequestIdentity, serviceAccountId: string): Promise<ServiceAccount> {
    return this.view(this.find(identity, serviceAccountId), identity);
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
      workspaceName: this.workspaceName(identity), roleName: command.roleName, createdBy: identity.subject, createdAt: this.iso(), expiresAt,
      owner: { subject: identity.subject, assignedAt: this.iso() }, disabled: null, credentials: [credential], entitlements: [],
    };
    accounts.push(account);
    return { serviceAccount: this.view(account, identity), credential: { credentialId: minted.credentialId, secret: minted.secret, expiresAt: credential.expiresAt } };
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
    return { serviceAccount: this.view(account, identity), credential: { credentialId: minted.credentialId, secret: minted.secret, expiresAt: credential.expiresAt } };
  }

  async revoke(identity: RequestIdentity, serviceAccountId: string): Promise<{ serviceAccount: ServiceAccount; revokedCredentials: number }> {
    const account = this.find(identity, serviceAccountId);
    const now = this.now().getTime();
    const inUse = account.credentials.filter((stored) => stored.revokedAt === null && Date.parse(stored.expiresAt) > now && (stored.endsAt === null || Date.parse(stored.endsAt) > now));
    if (inUse.length === 0) throw new ServiceAccountError("service_account_no_active_credential", 409);
    for (const stored of inUse) { stored.revokedAt = this.iso(); stored.endsAt = stored.revokedAt; }
    return { serviceAccount: this.view(account, identity), revokedCredentials: inUse.length };
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
    // Deactivating an account ends everything it can read, as the SQL function does.
    account.entitlements = [];
    account.disabled = { at, by: identity.subject, reason };
    return this.view(account, identity);
  }

  async extend(identity: RequestIdentity, serviceAccountId: string, command: Extract<ServiceAccountCommand, { action: "extend" }>): Promise<{ serviceAccount: ServiceAccount; previousExpiresAt: string }> {
    const account = this.find(identity, serviceAccountId);
    if (account.disabled !== null) throw new ServiceAccountError("service_account_not_active", 409);
    if (!this.activeAdmins(identity).includes(account.owner.subject)) throw new ServiceAccountError("service_account_needs_owner", 409);
    // The new expiry must be later than the current one (and so than now), as the SQL function requires.
    if (command.expiresInDays < minimumExtensionDays(account.expiresAt, this.now())) throw new ServiceAccountError("invalid_expiry", 400);
    const previousExpiresAt = account.expiresAt;
    account.expiresAt = daysFromNow(command.expiresInDays, this.now());
    return { serviceAccount: this.view(account, identity), previousExpiresAt };
  }

  async transferOwner(identity: RequestIdentity, serviceAccountId: string, ownerSubject: string): Promise<{ serviceAccount: ServiceAccount; previousOwner: string }> {
    const account = this.find(identity, serviceAccountId);
    if (account.disabled !== null) throw new ServiceAccountError("service_account_not_active", 409);
    if (!this.activeAdmins(identity).includes(ownerSubject)) throw new ServiceAccountError("service_account_owner_invalid", 422);
    if (ownerSubject === account.owner.subject) throw new ServiceAccountError("service_account_owner_unchanged", 409);
    const previousOwner = account.owner.subject;
    account.owner = { subject: ownerSubject, assignedAt: this.iso() };
    return { serviceAccount: this.view(account, identity), previousOwner };
  }
  async grantEntitlement(identity: RequestIdentity, serviceAccountId: string, resource: ServiceAccountResourceRef): Promise<{ serviceAccount: ServiceAccount }> {
    const account = this.find(identity, serviceAccountId);
    if (account.disabled !== null || Date.parse(account.expiresAt) <= this.now().getTime()) throw new ServiceAccountError("service_account_not_active", 409);
    // Nothing the organization is not licensed for, whether it is unknown or belongs to someone else: one refusal for all of it.
    if (!licensed(resource.resourceType, resource.resourceId)) throw new ServiceAccountError("entitlement_outside_data_rights", 422);
    if (account.entitlements.some((stored) => stored.resourceType === resource.resourceType && stored.resourceId === resource.resourceId)) throw new ServiceAccountError("service_account_entitlement_exists", 409);
    if (account.entitlements.length >= SERVICE_ACCOUNT_ENTITLEMENT_LIMIT) throw new ServiceAccountError("service_account_entitlement_limit_reached", 409);
    account.entitlements.push({ resourceType: resource.resourceType, resourceId: resource.resourceId, grantedAt: this.iso() });
    return { serviceAccount: this.view(account, identity) };
  }

  async revokeEntitlement(identity: RequestIdentity, serviceAccountId: string, resource: ServiceAccountResourceRef): Promise<{ serviceAccount: ServiceAccount; endedEntitlements: number }> {
    const account = this.find(identity, serviceAccountId);
    const before = account.entitlements.length;
    account.entitlements = account.entitlements.filter((stored) => !(stored.resourceType === resource.resourceType && stored.resourceId === resource.resourceId));
    if (account.entitlements.length === before) throw new ServiceAccountError("service_account_entitlement_not_found", 404);
    return { serviceAccount: this.view(account, identity), endedEntitlements: before - account.entitlements.length };
  }
}

// Deliberately module state, not `globalThis`: the store throws `ServiceAccountError`, and `next dev` re-evaluating the
// modules (when another route is compiled) would leave a surviving store throwing the previous copy of that class, which
// the routes' `instanceof` checks no longer recognise (a 500 instead of a 409).
let store: DemoServiceAccountStore | undefined;
/** The process-wide demo store. */
export function demoServiceAccountStore(): DemoServiceAccountStore {
  store ??= new DemoServiceAccountStore();
  return store;
}
