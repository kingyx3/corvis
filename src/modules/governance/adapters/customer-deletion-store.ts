import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  DELETION_APPROVAL_WINDOW_HOURS,
  deletionLegalHoldBlocks,
  deletionRequestActions,
  deletionRequestStatus,
  deletionScopeLabel,
  type DeletionDecisionCommand,
  type DeletionRequestCommand,
  type DeletionRequestView,
} from "../domain/data-retention.ts";
import { DataGovernanceError } from "../server/lifecycle/data-governance.ts";
import type { CustomerDeletionBackend } from "../server/lifecycle/customer-deletion.ts";
import { demoLegalHoldCovers, demoRetentionCovers } from "./data-retention-fixtures.ts";

/**
 * In-memory deletion requests for demo mode and the browser suites; not production evidence. Each demo tenant gets its own
 * seeded list on first use (a deletion Corvis operations carried out, one blocked by the demo legal hold, and a request from a
 * colleague waiting for this admin's approval), so a test that approves or withdraws under its own demo tenant header never
 * disturbs another. The rules are the Postgres rules (migration 098): only a different Organization Admin may approve or
 * reject, only the requester may withdraw, a legal hold refuses a request and an approval, one request is pending at a
 * time, and an approval window lapses. The one difference is what happens after approval: the demo has no operations
 * console, so an approved request stays approved.
 */

const HOUR_MS = 60 * 60 * 1000;
const COLLEAGUE = "morgan.lee@meridian.example";

type Identity = { authMethod: string; subject: string };
type Entry = {
  requestId: string;
  origin: "customer" | "corvis";
  /** The stored state, as in `corvis_control.deletion_request`. */
  state: string;
  dataClasses: string[];
  requestedAt: string;
  requestedBy: Identity | null;
  reason: string | null;
  approvalExpiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  executedAt: string | null;
};

export class DemoCustomerDeletionStore implements CustomerDeletionBackend {
  readonly demo = true;
  private readonly tenants = new Map<string, Entry[]>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) { this.now = now; }

  private at(offsetHours = 0): string { return new Date(this.now().getTime() + offsetHours * HOUR_MS).toISOString(); }

  private entries(identity: RequestIdentity): Entry[] {
    let entries = this.tenants.get(identity.tenantId);
    if (!entries) {
      entries = this.seed();
      this.tenants.set(identity.tenantId, entries);
    }
    return entries;
  }

  private base(origin: Entry["origin"], state: string, dataClasses: string[], hoursAgo: number): Entry {
    return {
      requestId: randomUUID(), origin, state, dataClasses, requestedAt: this.at(-hoursAgo), requestedBy: null, reason: null, approvalExpiresAt: null,
      decidedBy: null, decidedAt: null, decisionNote: null, executedAt: null,
    };
  }

  private seed(): Entry[] {
    // Oldest first: a deletion Corvis operations carried out, one that is blocked by the legal hold, then a colleague's request.
    const completed = { ...this.base("corvis", "completed", ["audit"], 24 * 75), decidedAt: this.at(-24 * 74), executedAt: this.at(-24 * 74 + 1) };
    const blocked = this.base("corvis", "blocked", ["source_documents"], 24 * 14);
    const pending: Entry = {
      ...this.base("customer", "pending_customer_approval", ["published_data"], 2),
      requestedBy: { authMethod: "demo", subject: COLLEAGUE },
      reason: "Contract ends this quarter: remove the published data we no longer need.",
      approvalExpiresAt: this.at(DELETION_APPROVAL_WINDOW_HOURS - 2),
    };
    return [completed, blocked, pending];
  }

  private view(entry: Entry, identity: RequestIdentity): DeletionRequestView {
    const customer = entry.origin === "customer";
    const lapsed = entry.state === "pending_customer_approval" && entry.approvalExpiresAt !== null && Date.parse(entry.approvalExpiresAt) <= this.now().getTime();
    const status = deletionRequestStatus(entry.state, lapsed);
    const requestedByMe = customer && entry.requestedBy!.authMethod === identity.authMethod && entry.requestedBy!.subject === identity.subject;
    const scope = { dataClasses: entry.dataClasses };
    return {
      requestId: entry.requestId,
      origin: entry.origin,
      status,
      dataClasses: entry.dataClasses,
      scopeLabel: deletionScopeLabel(scope),
      requestedAt: entry.requestedAt,
      decidedAt: entry.decidedAt,
      executedAt: entry.executedAt,
      legalHoldBlocks: deletionLegalHoldBlocks(status, demoLegalHoldCovers(entry.dataClasses)),
      reason: customer ? entry.reason : null,
      requestedBy: customer ? entry.requestedBy!.subject : null,
      approvalExpiresAt: customer ? entry.approvalExpiresAt : null,
      decidedBy: customer ? entry.decidedBy : null,
      decisionNote: customer ? entry.decisionNote : null,
      requestedByMe,
      actions: deletionRequestActions(status, entry.origin, requestedByMe),
    };
  }

  /** Newest first, as the Postgres read returns them. */
  async list(identity: RequestIdentity): Promise<DeletionRequestView[]> {
    return [...this.entries(identity)].reverse().map((entry) => this.view(entry, identity));
  }

  async request(identity: RequestIdentity, command: DeletionRequestCommand): Promise<DeletionRequestView> {
    const entries = this.entries(identity);
    if (!demoRetentionCovers(command.dataClasses)) throw new DataGovernanceError("invalid_data_classes", 400);
    if (demoLegalHoldCovers(command.dataClasses)) throw new DataGovernanceError("deletion_blocked_by_legal_hold", 409);
    const now = this.now().getTime();
    for (const entry of entries) {
      if (entry.state === "pending_customer_approval" && Date.parse(entry.approvalExpiresAt!) <= now) entry.state = "expired";
    }
    if (entries.some((entry) => entry.state === "pending_customer_approval")) throw new DataGovernanceError("deletion_request_already_pending", 409);
    const entry: Entry = {
      ...this.base("customer", "pending_customer_approval", [...new Set(command.dataClasses)].sort(), 0),
      requestedBy: { authMethod: identity.authMethod, subject: identity.subject },
      reason: command.reason,
      approvalExpiresAt: this.at(DELETION_APPROVAL_WINDOW_HOURS),
    };
    entries.push(entry);
    return this.view(entry, identity);
  }

  async decide(identity: RequestIdentity, requestId: string, command: DeletionDecisionCommand): Promise<DeletionRequestView> {
    // A request Corvis operations made is never decided here: it is not found, exactly as in Postgres.
    const entry = this.entries(identity).find((candidate) => candidate.requestId === requestId && candidate.origin === "customer");
    if (!entry) throw new DataGovernanceError("deletion_request_not_found", 404);
    if (command.expectedStatus !== undefined && entry.state !== "pending_customer_approval") throw new DataGovernanceError("deletion_status_changed", 409);
    if (entry.state !== "pending_customer_approval") throw new DataGovernanceError("deletion_transition_not_allowed", 409);
    const mine = entry.requestedBy!.authMethod === identity.authMethod && entry.requestedBy!.subject === identity.subject;
    if (command.action === "cancel") {
      if (!mine) throw new DataGovernanceError("deletion_cancel_requester_only", 403);
      entry.state = "cancelled";
      return this.view(entry, identity);
    }
    if (mine) throw new DataGovernanceError("deletion_independent_approver_required", 403);
    if (Date.parse(entry.approvalExpiresAt!) <= this.now().getTime()) throw new DataGovernanceError("deletion_approval_expired", 409);
    if (command.action === "approve" && demoLegalHoldCovers(entry.dataClasses)) throw new DataGovernanceError("deletion_blocked_by_legal_hold", 409);
    entry.state = command.action === "approve" ? "approved" : "rejected";
    entry.decidedBy = identity.subject;
    entry.decidedAt = this.at();
    entry.decisionNote = command.note ?? null;
    return this.view(entry, identity);
  }
}

let singleton: DemoCustomerDeletionStore | undefined;
export function demoCustomerDeletionStore(): DemoCustomerDeletionStore {
  if (!singleton) singleton = new DemoCustomerDeletionStore();
  return singleton;
}
