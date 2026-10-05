import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  deletionLegalHoldBlocks,
  deletionRequestActions,
  deletionRequestStatus,
  deletionScopeDataClasses,
  deletionScopeLabel,
  type DeletionRequestOrigin,
  type DeletionRequestView,
} from "../../core/data-retention.ts";
import type { PostgresRow } from "./postgres.ts";

/**
 * A `corvis_control.deletion_request` row as an Organization Admin may see it (F10e, #325). The row also holds what only
 * Corvis operations may see (the operator who made it, the one who approved and ran it, an internal reason, the last
 * error, the evidence of each attempt), so the customer read never selects those: for a request an Organization Admin
 * made, the SQL below returns who asked, why and who decided; for one Corvis operations made, those columns are NULL
 * in the query itself, and the mapping ignores them again, so a change to the query alone cannot leak them.
 */
export const DELETION_REQUEST_COLUMNS = `r.deletion_request_id::text as request_id, r.origin, r.state, r.scope, r.requested_at,
  case when r.origin = 'customer' then r.requested_by end as requested_by,
  case when r.origin = 'customer' then r.requested_by_auth_method end as requested_by_auth_method,
  case when r.origin = 'customer' then r.reason end as reason,
  case when r.origin = 'customer' then r.approval_expires_at end as approval_expires_at,
  case when r.origin = 'customer' then r.customer_decided_by_subject end as decided_by,
  case when r.origin = 'customer' then r.customer_decision_note end as decision_note,
  case when r.origin = 'customer' then r.customer_decided_at else r.approved_at end as decided_at,
  r.completed_at,
  (r.state = 'pending_customer_approval' and r.approval_expires_at <= now()) as approval_lapsed,
  corvis_control.deletion_scope_legal_hold(r.tenant_id, r.scope -> 'dataClasses') as legal_hold`;

function str(row: PostgresRow, key: string): string { return String(row[key]); }
function optionalStr(row: PostgresRow, key: string): string | null { return row[key] == null ? null : String(row[key]); }
function flag(row: PostgresRow, key: string): boolean { return row[key] === true || row[key] === "true"; }

export function toDeletionRequestView(row: PostgresRow, identity: RequestIdentity): DeletionRequestView {
  const origin: DeletionRequestOrigin = str(row, "origin") === "customer" ? "customer" : "corvis";
  const customer = origin === "customer";
  const status = deletionRequestStatus(str(row, "state"), flag(row, "approval_lapsed"));
  const requestedByMe = customer && str(row, "requested_by_auth_method") === identity.authMethod && str(row, "requested_by") === identity.subject;
  return {
    requestId: str(row, "request_id"),
    origin,
    status,
    dataClasses: deletionScopeDataClasses(row.scope),
    scopeLabel: deletionScopeLabel(row.scope),
    requestedAt: str(row, "requested_at"),
    decidedAt: optionalStr(row, "decided_at"),
    executedAt: optionalStr(row, "completed_at"),
    legalHoldBlocks: deletionLegalHoldBlocks(status, flag(row, "legal_hold")),
    reason: customer ? optionalStr(row, "reason") : null,
    requestedBy: customer ? optionalStr(row, "requested_by") : null,
    approvalExpiresAt: customer ? optionalStr(row, "approval_expires_at") : null,
    decidedBy: customer ? optionalStr(row, "decided_by") : null,
    decisionNote: customer ? optionalStr(row, "decision_note") : null,
    requestedByMe,
    actions: deletionRequestActions(status, origin, requestedByMe),
  };
}
