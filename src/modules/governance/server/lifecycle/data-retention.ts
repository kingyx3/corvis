import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import {
  dataClassLabel,
  legalHoldScopeLabel,
  retentionPeriodLabel,
  type LegalHoldView,
  type RetentionPolicyView,
  type RetentionView,
} from "../../domain/data-retention.ts";
import { demoRetentionStore } from "../../adapters/data-retention-store.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { assertOrganizationAdmin } from "./data-governance.ts";
import { DELETION_REQUEST_COLUMNS, toDeletionRequestView } from "./deletion-request-view.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";

/**
 * The retention periods, legal holds and deletion requests that apply to the caller's organization (F10, #266, criterion 1;
 * F10e, #325), read-only. Corvis operations own the data (`corvis_control.retention_policy`, `legal_hold` and
 * `deletion_request`); this only reads it, scoped to the caller's tenant, for Organization
 * Admins, and never selects what only operations may see (see `deletion-request-view.ts`). Making and deciding a deletion
 * request is `customer-deletion.ts`.
 */
export interface RetentionService {
  view(identity: RequestIdentity): Promise<RetentionView>;
}

/** Requests shown. Requests are rare (a customer one is made by hand, an operator one by exception), so this is more than enough. */
export const DELETION_REQUEST_LIMIT = 100;

function text(row: PostgresRow, key: string): string { return String(row[key]); }
function flag(row: PostgresRow, key: string): boolean { return row[key] === true || row[key] === "true"; }

export class PostgresRetentionBackend {
  private readonly defaultDb: () => PostgresSqlApi;

  constructor(defaultDb: () => PostgresSqlApi) { this.defaultDb = defaultDb; }

  async view(identity: RequestIdentity, db: PostgresSqlApi = this.defaultDb()): Promise<RetentionView> {
    const [policyRows, holdRows, deletionRows] = await Promise.all([
      // One row per data class: the version in effect now, or (when none is yet) the next one to take effect.
      // A hold on the class counts whichever version carries it, because that is the rule deletion execution applies.
      db.query(`select distinct on (p.data_class) p.data_class, p.retention_days, p.delete_on_termination, p.policy_version,
          p.effective_from, (p.effective_from <= now()) as in_effect,
          exists (select 1 from corvis_control.retention_policy h
            where h.tenant_id = p.tenant_id and h.data_class = p.data_class and h.legal_hold) as legal_hold
        from corvis_control.retention_policy p
        where p.tenant_id = $1::uuid
        order by p.data_class, (p.effective_from <= now()) desc, p.effective_from desc, p.policy_version desc`, [identity.tenantId]),
      db.query(`select legal_hold_id::text as legal_hold_id, data_class, scope, matter_reference, placed_at
        from corvis_control.legal_hold
        where tenant_id = $1::uuid and released_at is null
        order by placed_at desc, legal_hold_id`, [identity.tenantId]),
      db.query(`select ${DELETION_REQUEST_COLUMNS}
        from corvis_control.deletion_request r
        where r.tenant_id = $1::uuid
        order by r.requested_at desc, r.deletion_request_id desc
        limit ${DELETION_REQUEST_LIMIT}`, [identity.tenantId]),
    ]);
    const policies: RetentionPolicyView[] = policyRows.map((row) => {
      const days = row.retention_days == null ? null : Number(row.retention_days);
      return {
        dataClass: text(row, "data_class"),
        label: dataClassLabel(text(row, "data_class")),
        retentionDays: days,
        retentionLabel: retentionPeriodLabel(days),
        deleteOnTermination: flag(row, "delete_on_termination"),
        legalHold: flag(row, "legal_hold"),
        policyVersion: text(row, "policy_version"),
        effectiveFrom: text(row, "effective_from"),
        inEffect: flag(row, "in_effect"),
      };
    });
    const legalHolds: LegalHoldView[] = holdRows.map((row) => {
      const dataClass = row.data_class == null ? null : text(row, "data_class");
      return {
        holdId: text(row, "legal_hold_id"),
        dataClass,
        label: dataClass === null ? "All data" : dataClassLabel(dataClass),
        scopeLabel: legalHoldScopeLabel(dataClass, row.scope),
        matterReference: text(row, "matter_reference"),
        placedAt: text(row, "placed_at"),
      };
    });
    return { policies, legalHolds, deletionRequests: deletionRows.map((row) => toDeletionRequestView(row, identity)) };
  }
}

export function createRetentionService(backend: { view(identity: RequestIdentity): Promise<RetentionView> }): RetentionService {
  return {
    async view(identity) {
      assertOrganizationAdmin(identity);
      return backend.view(identity);
    },
  };
}

export const postgresRetentionService: RetentionService = createRetentionService(new PostgresRetentionBackend(() => postgres(getServerConfig().databaseDsn)));
export const demoRetentionService: RetentionService = createRetentionService(demoRetentionStore());

let override: RetentionService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideRetentionService(service?: RetentionService): void { override = service; }

export function retentionService(): RetentionService {
  return override ?? (getServerConfig().demoMode ? demoRetentionService : postgresRetentionService);
}
