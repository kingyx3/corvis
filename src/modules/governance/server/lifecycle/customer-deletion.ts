import { randomUUID } from "node:crypto";
import type { AuditEvent, RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import {
  DELETION_APPROVAL_WINDOW_HOURS,
  type DeletionDecisionCommand,
  type DeletionRequestCommand,
  type DeletionRequestView,
} from "../../domain/data-retention.ts";
import { demoCustomerDeletionStore } from "../../adapters/customer-deletion-store.ts";
import { runAuditedMutation } from "../evidence/audited-mutation.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { assertOrganizationAdmin, DataGovernanceError } from "./data-governance.ts";
import { DELETION_REQUEST_COLUMNS, toDeletionRequestView } from "./deletion-request-view.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";

/**
 * An Organization Admin's own deletion request (F10e, #325), over either backend (Postgres, or the in-memory demo store in
 * demo mode). It rides on the operator deletion lifecycle (`data-lifecycle.ts`) without
 * changing it: the request is a `deletion_request` row that waits in `pending_customer_approval`, a state operations
 * cannot execute from, until a *different* Organization Admin approves it. Whether the approver is
 * independent of the requester, and whether a legal hold stops the request, is decided by the backend (in SQL for
 * Postgres), never here, so there is one rule and no other path around it. Mutations run through `runAuditedMutation`, so
 * the command and its audit event commit together. Carrying the deletion out stays with Corvis operations.
 */
export interface CustomerDeletionBackend {
  readonly demo: boolean;
  request(identity: RequestIdentity, command: DeletionRequestCommand, db?: PostgresSqlApi): Promise<DeletionRequestView>;
  decide(identity: RequestIdentity, requestId: string, command: DeletionDecisionCommand, db?: PostgresSqlApi): Promise<DeletionRequestView>;
}

export interface CustomerDeletionService {
  request(identity: RequestIdentity, command: DeletionRequestCommand, correlationId: string): Promise<DeletionRequestView>;
  decide(identity: RequestIdentity, requestId: string, command: DeletionDecisionCommand, correlationId: string): Promise<DeletionRequestView>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function customerDeletionAuditEvent(
  identity: RequestIdentity,
  correlationId: string,
  action: string,
  item: Pick<DeletionRequestView, "requestId" | "status" | "dataClasses">,
  detail: Record<string, string | number | boolean | null> = {},
): AuditEvent {
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType: "deletion_request", targetId: item.requestId,
    outcome: "success", correlationId, metadata: { status: item.status, dataClasses: item.dataClasses.join(","), ...detail },
  };
}

/** A command only ever runs inside the audited transaction that `runAuditedMutation` opens, so it always has its own handle. */
function transactionHandle(db: PostgresSqlApi | undefined): PostgresSqlApi {
  if (!db) throw new Error("a customer deletion command must run inside its audited transaction");
  return db;
}

export class PostgresCustomerDeletionBackend implements CustomerDeletionBackend {
  readonly demo = false;

  async request(identity: RequestIdentity, command: DeletionRequestCommand, handle?: PostgresSqlApi): Promise<DeletionRequestView> {
    const db = transactionHandle(handle);
    if (!UUID.test(identity.workspaceId)) throw new DataGovernanceError("invalid_request", 400);
    let rows: PostgresRow[];
    try {
      rows = await db.query(`select ${DELETION_REQUEST_COLUMNS} from corvis_control.request_customer_deletion($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8) r`, [
        identity.tenantId, randomUUID(), identity.workspaceId, identity.authMethod, identity.subject, JSON.stringify(command.dataClasses), command.reason, DELETION_APPROVAL_WINDOW_HOURS,
      ]);
    } catch (error) {
      // Two concurrent first requests both pass the function's check and the loser hits the one-pending-request index.
      // That is the same refusal as finding the other request pending, not a server failure.
      if ((error as { code?: unknown } | null)?.code === "23505") throw new DataGovernanceError("deletion_request_already_pending", 409);
      throw error;
    }
    return toDeletionRequestView(rows[0]!, identity);
  }

  async decide(identity: RequestIdentity, requestId: string, command: DeletionDecisionCommand, handle?: PostgresSqlApi): Promise<DeletionRequestView> {
    const db = transactionHandle(handle);
    if (!UUID.test(requestId)) throw new DataGovernanceError("deletion_request_not_found", 404);
    const row = (await db.query(`select ${DELETION_REQUEST_COLUMNS} from corvis_control.decide_customer_deletion($1::uuid,$2::uuid,$3,$4,$5,$6,$7) r`, [
      identity.tenantId, requestId, command.action, identity.authMethod, identity.subject, command.note ?? null,
      command.expectedStatus === undefined ? null : "pending_customer_approval",
    ]))[0];
    // No row: the id names nothing in this tenant, or names a request Corvis operations made (never decided here).
    if (!row) throw new DataGovernanceError("deletion_request_not_found", 404);
    return toDeletionRequestView(row, identity);
  }
}

const DECISION_AUDIT: Record<DeletionDecisionCommand["action"], string> = {
  approve: "deletion_request.customer_approved",
  reject: "deletion_request.customer_rejected",
  cancel: "deletion_request.customer_cancelled",
};

export function createCustomerDeletionService(backend: CustomerDeletionBackend): CustomerDeletionService {
  return {
    async request(identity, command, correlationId) {
      assertOrganizationAdmin(identity);
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.request(identity, command, db),
        audit: (item) => customerDeletionAuditEvent(identity, correlationId, "deletion_request.customer_requested", item, { reason: command.reason }),
      });
    },
    async decide(identity, requestId, command, correlationId) {
      assertOrganizationAdmin(identity);
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.decide(identity, requestId, command, db),
        audit: (item) => customerDeletionAuditEvent(identity, correlationId, DECISION_AUDIT[command.action], item, command.note === undefined ? {} : { note: command.note }),
      });
    },
  };
}

export const postgresCustomerDeletionService: CustomerDeletionService = createCustomerDeletionService(new PostgresCustomerDeletionBackend());
export const demoCustomerDeletionService: CustomerDeletionService = createCustomerDeletionService(demoCustomerDeletionStore());

let override: CustomerDeletionService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideCustomerDeletionService(service?: CustomerDeletionService): void { override = service; }

export function customerDeletionService(): CustomerDeletionService {
  return override ?? (getServerConfig().demoMode ? demoCustomerDeletionService : postgresCustomerDeletionService);
}
