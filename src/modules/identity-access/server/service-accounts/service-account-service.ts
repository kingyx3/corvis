import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type {
  CreateServiceAccountCommand,
  IssuedServiceAccountCredential,
  ServiceAccount,
  ServiceAccountCommand,
  ServiceAccountCreated,
  ServiceAccountList,
} from "../../domain/service-account.ts";
import { demoServiceAccountStore } from "../../adapters/service-account-store.ts";
import { runAuditedMutation } from "../../../governance/server/evidence/audited-mutation.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { postgres } from "../../../../platform/database/postgres.ts";
import {
  PostgresServiceAccountBackend,
  assertCanManageServiceAccounts,
  serviceAccountAuditEvent,
  type ServiceAccountBackend,
} from "./service-account.ts";

/**
 * The customer-facing service-account operations behind `/api/v1/access/service-accounts/**`, over either backend
 * (Postgres, or the in-memory demo store in demo mode). Authorization that does not depend on where accounts are
 * stored lives here, once: only a person who is an Organization Admin acts. Mutations run through `runAuditedMutation`,
 * so the command and its audit event commit together; the audit event never carries a secret.
 */
export type ServiceAccountActionResult = { serviceAccount: ServiceAccount; credential?: IssuedServiceAccountCredential };

export interface ServiceAccountService {
  list(identity: RequestIdentity): Promise<ServiceAccountList>;
  get(identity: RequestIdentity, serviceAccountId: string): Promise<ServiceAccount>;
  /** Creates the account and its first credential; the secret in the result is shown once. */
  create(identity: RequestIdentity, command: CreateServiceAccountCommand, correlationId: string): Promise<ServiceAccountCreated>;
  act(identity: RequestIdentity, serviceAccountId: string, command: ServiceAccountCommand, correlationId: string): Promise<ServiceAccountActionResult>;
}

export function createServiceAccountService(backend: ServiceAccountBackend): ServiceAccountService {
  return {
    async list(identity) {
      assertCanManageServiceAccounts(identity);
      return backend.list(identity);
    },
    async get(identity, serviceAccountId) {
      assertCanManageServiceAccounts(identity);
      return backend.get(identity, serviceAccountId);
    },
    async create(identity, command, correlationId) {
      assertCanManageServiceAccounts(identity);
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.create(identity, command, db),
        audit: ({ serviceAccount, credential }) => serviceAccountAuditEvent(identity, correlationId, "service_account.created", serviceAccount, {
          name: serviceAccount.name, roleName: serviceAccount.roleName, workspaceId: serviceAccount.workspaceId,
          expiresAt: serviceAccount.expiresAt, credentialId: credential.credentialId, credentialExpiresAt: credential.expiresAt,
        }),
      });
    },
    async act(identity, serviceAccountId, command, correlationId) {
      assertCanManageServiceAccounts(identity);
      switch (command.action) {
        case "issue":
        case "rotate":
          return runAuditedMutation({
            demoMode: backend.demo,
            mutate: (db) => backend.issueCredential(identity, serviceAccountId, command, db),
            audit: ({ serviceAccount, credential }) => serviceAccountAuditEvent(identity, correlationId,
              command.action === "issue" ? "service_account.credential_issued" : "service_account.credential_rotated", serviceAccount, {
                credentialId: credential.credentialId, credentialExpiresAt: credential.expiresAt,
                ...(command.action === "rotate" ? { overlapMinutes: command.overlapMinutes } : {}),
              }),
          });
        case "revoke":
          return runAuditedMutation({
            demoMode: backend.demo,
            mutate: (db) => backend.revoke(identity, serviceAccountId, db),
            audit: ({ serviceAccount, revokedCredentials }) => serviceAccountAuditEvent(identity, correlationId, "service_account.credential_revoked", serviceAccount, {
              reason: command.reason, revokedCredentials,
            }),
          }).then(({ serviceAccount }) => ({ serviceAccount }));
        case "extend":
          return runAuditedMutation({
            demoMode: backend.demo,
            mutate: (db) => backend.extend(identity, serviceAccountId, command, db),
            // The account's lifecycle review date is advanced with its expiry (migration 092), so one audit event records both.
            audit: ({ serviceAccount, previousExpiresAt }) => serviceAccountAuditEvent(identity, correlationId, "service_account.extended", serviceAccount, {
              previousExpiresAt, expiresAt: serviceAccount.expiresAt, nextReviewAt: serviceAccount.expiresAt,
            }),
          }).then(({ serviceAccount }) => ({ serviceAccount }));
        case "transfer":
          return runAuditedMutation({
            demoMode: backend.demo,
            mutate: (db) => backend.transferOwner(identity, serviceAccountId, command.ownerSubject, db),
            audit: ({ serviceAccount, previousOwner }) => serviceAccountAuditEvent(identity, correlationId, "service_account.owner_transferred", serviceAccount, {
              previousOwner, ownerSubject: serviceAccount.ownerSubject,
            }),
          }).then(({ serviceAccount }) => ({ serviceAccount }));
        case "grant_entitlement":
          return runAuditedMutation({
            demoMode: backend.demo,
            mutate: (db) => backend.grantEntitlement(identity, serviceAccountId, command, db),
            // The grant is read-only and in the account's own workspace; the audit event names the resource by identifier, never the figures behind it.
            audit: ({ serviceAccount }) => serviceAccountAuditEvent(identity, correlationId, "service_account.entitlement_granted", serviceAccount, {
              resourceType: command.resourceType, resourceId: command.resourceId, permission: "read", reason: command.reason,
            }),
          });
        case "revoke_entitlement":
          return runAuditedMutation({
            demoMode: backend.demo,
            mutate: (db) => backend.revokeEntitlement(identity, serviceAccountId, command, db),
            audit: ({ serviceAccount, endedEntitlements }) => serviceAccountAuditEvent(identity, correlationId, "service_account.entitlement_revoked", serviceAccount, {
              resourceType: command.resourceType, resourceId: command.resourceId, endedEntitlements, reason: command.reason,
            }),
          }).then(({ serviceAccount }) => ({ serviceAccount }));
        case "disable":
          return runAuditedMutation({
            demoMode: backend.demo,
            mutate: (db) => backend.disable(identity, serviceAccountId, command.reason, db),
            audit: (serviceAccount) => serviceAccountAuditEvent(identity, correlationId, "service_account.disabled", serviceAccount, { reason: command.reason }),
          }).then((serviceAccount) => ({ serviceAccount }));
      }
    },
  };
}

export const postgresServiceAccountService: ServiceAccountService = createServiceAccountService(new PostgresServiceAccountBackend(() => postgres(getServerConfig().databaseDsn)));
export const demoServiceAccountService: ServiceAccountService = createServiceAccountService(demoServiceAccountStore());

let override: ServiceAccountService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideServiceAccountService(service?: ServiceAccountService): void { override = service; }

export function serviceAccountService(): ServiceAccountService {
  return override ?? (getServerConfig().demoMode ? demoServiceAccountService : postgresServiceAccountService);
}
