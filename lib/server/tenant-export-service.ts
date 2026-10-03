import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  TENANT_EXPORT_ARCHIVE_NAME,
  type TenantExportDownload,
  type TenantExportRequest,
} from "../../core/tenant-export.ts";
import { demoTenantExportStore } from "../../adapters/demo/tenant-export-store.ts";
import { runAuditedMutation } from "./audited-mutation.ts";
import { getServerConfig } from "./config.ts";
import { assertOrganizationAdmin } from "./data-governance.ts";
import { gcs } from "./gcs.ts";
import { postgres } from "./postgres.ts";
import {
  PostgresTenantExportBackend,
  tenantExportAuditEvent,
  type DecisionCommand,
  type TenantExportBackend,
  type TenantExportStream,
} from "./tenant-export.ts";

/**
 * The customer-facing full-export operations behind `/api/v1/access/data-exports/**`, over either backend (Postgres,
 * or the in-memory demo store in demo mode). Authorization that does not depend on where requests are stored lives
 * here, once: only Organization Admins act. Mutations run through `runAuditedMutation`, so the command and its audit
 * event commit together. Whether the approver is independent of the requester is decided by the backend (in SQL for
 * Postgres), never here, so there is one rule and it cannot be bypassed by choosing a different path.
 */
export type TenantExportDownloadStream = TenantExportStream & { checksumSha256: string; filename: string };

export interface TenantExportService {
  request(identity: RequestIdentity, command: { reason: string }, correlationId: string): Promise<TenantExportRequest>;
  list(identity: RequestIdentity): Promise<TenantExportRequest[]>;
  get(identity: RequestIdentity, requestId: string): Promise<TenantExportRequest>;
  decide(identity: RequestIdentity, requestId: string, command: DecisionCommand, correlationId: string): Promise<TenantExportRequest>;
  /** A fresh single-use, short-lived link for a complete export. */
  prepareDownload(identity: RequestIdentity, requestId: string, correlationId: string): Promise<TenantExportDownload>;
  /** Redeems a link and returns the archive; null when the link is not valid. */
  download(identity: RequestIdentity, requestId: string, grant: string, correlationId: string): Promise<TenantExportDownloadStream | null>;
}

const DECISION_AUDIT: Record<DecisionCommand["action"], string> = {
  approve: "data_export.approved",
  reject: "data_export.rejected",
  cancel: "data_export.cancelled",
};

export function createTenantExportService(backend: TenantExportBackend): TenantExportService {
  return {
    async request(identity, command, correlationId) {
      assertOrganizationAdmin(identity);
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.request(identity, command, db),
        audit: (item) => tenantExportAuditEvent(identity, correlationId, "data_export.requested", item, { reason: command.reason }),
      });
    },
    async list(identity) {
      assertOrganizationAdmin(identity);
      return backend.list(identity);
    },
    async get(identity, requestId) {
      assertOrganizationAdmin(identity);
      return backend.get(identity, requestId);
    },
    async decide(identity, requestId, command, correlationId) {
      assertOrganizationAdmin(identity);
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.decide(identity, requestId, command, db),
        audit: (item) => tenantExportAuditEvent(identity, correlationId, DECISION_AUDIT[command.action], item, command.note === undefined ? {} : { note: command.note }),
      });
    },
    async prepareDownload(identity, requestId, correlationId) {
      assertOrganizationAdmin(identity);
      const issued = await runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.issueDownload(identity, requestId, db),
        audit: ({ request, download }) => tenantExportAuditEvent(identity, correlationId, "data_export.link_issued", request, { linkExpiresAt: download.downloadExpiresAt }),
      });
      return issued.download;
    },
    async download(identity, requestId, grant, correlationId) {
      assertOrganizationAdmin(identity);
      const redeemed = await runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.redeemDownload(identity, requestId, grant, db),
        // A link that matches nothing changed nothing, so it needs no success audit.
        audit: (result) => result === null ? undefined : tenantExportAuditEvent(identity, correlationId, "data_export.download_started", { requestId, status: "complete" }, { checksumSha256: result.checksumSha256 }),
      });
      if (redeemed === null) return null;
      const stream = await backend.openArtifact(identity, requestId, grant, redeemed);
      if (stream === null) return null;
      return { ...stream, checksumSha256: redeemed.checksumSha256, filename: TENANT_EXPORT_ARCHIVE_NAME };
    },
  };
}

export const postgresTenantExportService: TenantExportService = createTenantExportService(
  new PostgresTenantExportBackend(() => postgres(getServerConfig().postgresDsn), gcs),
);
export const demoTenantExportService: TenantExportService = createTenantExportService(demoTenantExportStore());

let override: TenantExportService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideTenantExportService(service?: TenantExportService): void { override = service; }

export function tenantExportService(): TenantExportService {
  return override ?? (getServerConfig().demoMode ? demoTenantExportService : postgresTenantExportService);
}
