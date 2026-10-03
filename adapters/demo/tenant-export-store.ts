import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  TENANT_EXPORT_APPROVAL_WINDOW_HOURS,
  tenantExportActions,
  tenantExportStatus,
  type TenantExportArtifact,
  type TenantExportDownload,
  type TenantExportEvent,
  type TenantExportPage,
  type TenantExportRequest,
  type TenantExportState,
} from "../../core/tenant-export.ts";
import { toCsv } from "../../lib/csv.ts";
import { DataGovernanceError } from "../../lib/server/data-governance.ts";
import { assembleTenantExportBundle } from "../../lib/server/tenant-export-bundle.ts";
import {
  TENANT_EXPORT_LINK_MINUTES,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isUuid,
  type DecisionCommand,
  type RedeemedTenantExport,
  type TenantExportListQuery,
  type TenantExportBackend,
  type TenantExportStream,
} from "../../lib/server/tenant-export.ts";
import { documents, observations } from "./catalog.ts";

/**
 * In-memory full tenant exports for demo mode and the browser suites; not production evidence. Each demo tenant gets
 * its own seeded history on first use (a request from a colleague waiting for this admin's approval, an earlier
 * export that was built and can be downloaded, and a rejected one), so a test that approves or rejects under its own
 * demo tenant header never disturbs another. The rules are the Postgres rules: only a different Organization Admin may
 * approve or reject, only the requester may withdraw, one request is open at a time, and an approval window lapses.
 * The one difference is the build: demo mode builds the archive at the moment of approval, from the demo catalog,
 * with the same assembler (and so the same manifest and checksums) as the production worker.
 */

const HOUR_MS = 60 * 60 * 1000;
const SYSTEM = "system:tenant-export";
const COLLEAGUE = "morgan.lee@meridian.example";
const EARLIER_REQUESTER = "alex.chen@meridian.example";
/** The demo organization's contractual rights: Hg Genesis 9 is not redistributable, so it is left out and reported. */
const REDISTRIBUTABLE_FUNDS = new Set(["fund-advent-viii", "fund-eqt-ix"]);
const DEMO_FUNDS = ["fund-advent-viii", "fund-eqt-ix", "fund-hg-genesis-9"];
const OBSERVATION_COLUMNS = ["observation_id", "fund_id", "company_id", "holding_id", "metric_code", "value", "period", "review_state", "source"];
const AUDIT_COLUMNS = ["occurred_at", "actor", "action", "target_type", "target_id", "outcome"];
const INVENTORY_COLUMNS = ["document_id", "display_name", "document_type", "status", "uploaded"];

type Identity = { authMethod: string; subject: string };
type StoredArtifact = TenantExportArtifact & { bytes: Buffer };
type Entry = {
  requestId: string;
  state: TenantExportState;
  reason: string;
  requestedBy: Identity;
  requestedAt: string;
  approvalExpiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelledAt: string | null;
  statusChangedAt: string;
  artifact: StoredArtifact | null;
  history: TenantExportEvent[];
};
type Grant = { requestId: string; subject: string; expiresAt: number; consumed: boolean };
type Tenant = { entries: Entry[]; grants: Map<string, Grant> };

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class DemoTenantExportStore implements TenantExportBackend {
  readonly demo = true;
  private readonly tenants = new Map<string, Tenant>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) { this.now = now; }

  private at(offsetHours = 0): string { return new Date(this.now().getTime() + offsetHours * HOUR_MS).toISOString(); }

  private tenant(identity: RequestIdentity): Tenant {
    let tenant = this.tenants.get(identity.tenantId);
    if (!tenant) {
      tenant = { entries: [], grants: new Map() };
      this.tenants.set(identity.tenantId, tenant);
      this.seed(tenant, identity.tenantId);
    }
    return tenant;
  }

  private entry(requestedBy: string, hoursAgo: number, reason: string): Entry {
    const requestedAt = this.at(-hoursAgo);
    return {
      requestId: randomUUID(), state: "pending_approval", reason, requestedBy: { authMethod: "demo", subject: requestedBy }, requestedAt,
      approvalExpiresAt: this.at(TENANT_EXPORT_APPROVAL_WINDOW_HOURS - hoursAgo), decidedBy: null, decidedAt: null, decisionNote: null,
      cancelledAt: null, statusChangedAt: requestedAt, artifact: null,
      history: [{ eventType: "requested", fromState: null, toState: "pending_approval", actor: requestedBy, note: null, at: requestedAt }],
    };
  }

  private move(entry: Entry, eventType: string, to: TenantExportState, actor: string, note: string | null = null, offsetHours = 0): void {
    const at = this.at(offsetHours);
    entry.history.push({ eventType, fromState: entry.state, toState: to, actor, note, at });
    entry.state = to;
    entry.statusChangedAt = at;
  }

  private seed(tenant: Tenant, tenantId: string): void {
    // Oldest first: a rejected request, an export that was built (and can still be downloaded), then one waiting for approval.
    const rejected = this.entry(EARLIER_REQUESTER, 24 * 20, "Preparing for an internal audit.");
    this.move(rejected, "rejected", "rejected", COLLEAGUE, "Please scope this to the audit team's own request first.", -24 * 20 + 3);
    rejected.decidedBy = COLLEAGUE; rejected.decidedAt = rejected.statusChangedAt; rejected.decisionNote = "Please scope this to the audit team's own request first.";

    const built = this.entry(EARLIER_REQUESTER, 6, "Quarterly records review with our compliance team.");
    this.approveAndBuild(tenantId, built, COLLEAGUE, null, -5);

    const pending = this.entry(COLLEAGUE, 2, "Contract renewal due diligence: we need a full copy of our records.");
    tenant.entries.push(rejected, built, pending);
  }

  private approveAndBuild(tenantId: string, entry: Entry, approver: string, note: string | null, offsetHours = 0): void {
    this.move(entry, "approved", "approved", approver, note, offsetHours);
    entry.decidedBy = approver; entry.decidedAt = entry.statusChangedAt; entry.decisionNote = note;
    this.move(entry, "build_started", "building", SYSTEM, null, offsetHours);
    this.move(entry, "build_completed", "complete", SYSTEM, null, offsetHours);
    entry.artifact = this.buildArtifact(tenantId, entry, approver, offsetHours);
  }

  /** Builds the archive exactly as the production worker does, from the demo catalog and this tenant's own history. */
  private buildArtifact(tenantId: string, entry: Entry, approver: string, completedOffsetHours: number): StoredArtifact {
    const included = observations.filter((observation) => observation.fundId !== undefined && REDISTRIBUTABLE_FUNDS.has(observation.fundId));
    const includedDocuments = documents.filter((document) => document.fund === "Advent International GPE VIII" || document.fund === "EQT IX");
    const known = this.tenants.get(tenantId)?.entries ?? [];
    const auditEvents = (known.includes(entry) ? known : [...known, entry]).flatMap((candidate) => candidate.history.map((event) => ({ event, requestId: candidate.requestId })));
    const generatedAt = this.at(completedOffsetHours);
    const csv = (columns: string[], rows: unknown[][]) => Buffer.from(`${toCsv([columns, ...rows])}\n`, "utf8");
    const bundle = assembleTenantExportBundle({
      requestId: entry.requestId,
      tenantId,
      generatedAt,
      requestedBy: entry.requestedBy.subject,
      approvedBy: approver,
      files: [
        {
          path: "published-data/observations.csv", description: "Approved observations in published snapshots", rowCount: included.length,
          bytes: csv(OBSERVATION_COLUMNS, included.map((o) => [o.id, o.fundId, o.companyId, o.holdingId, o.metric, o.value, o.period, o.state, o.source])),
        },
        {
          path: "access-audit/access-audit.csv", description: "Access and data-export audit trail", rowCount: auditEvents.length,
          bytes: csv(AUDIT_COLUMNS, auditEvents.map(({ event, requestId }) => [event.at, event.actor, `data_export.${event.eventType}`, "tenant_export_request", requestId, "success"])),
        },
        {
          path: "source-documents/inventory.csv", description: "Source documents with the data you may redistribute (files are not included)", rowCount: includedDocuments.length,
          bytes: csv(INVENTORY_COLUMNS, includedDocuments.map((d) => [d.id, d.name, d.type, d.status, d.uploaded])),
        },
      ],
      dataRights: {
        basis: "Funds and documents are included only while every effective contractual data right for them allows client visibility and redistribution.",
        funds: { included: REDISTRIBUTABLE_FUNDS.size, excluded: DEMO_FUNDS.length - REDISTRIBUTABLE_FUNDS.size },
        documents: { included: includedDocuments.length, excluded: documents.length - includedDocuments.length },
      },
      notIncluded: [{ item: "Source document files", reason: "Not included in this release of the export; the inventory lists each document with its identifiers so files can be matched when delivered separately." }],
    });
    return {
      checksumSha256: bundle.checksumSha256,
      sizeBytes: bundle.bytes.length,
      expiresAt: this.at(completedOffsetHours + 24),
      manifest: bundle.manifest,
      bytes: bundle.bytes,
    };
  }

  private view(entry: Entry, identity: RequestIdentity, withHistory = false): TenantExportRequest {
    const now = this.now().getTime();
    const downloadAvailable = entry.state === "complete" && entry.artifact !== null && Date.parse(entry.artifact.expiresAt) > now;
    const status = tenantExportStatus(entry.state, entry.state === "pending_approval" && Date.parse(entry.approvalExpiresAt) <= now, downloadAvailable);
    const requestedByMe = entry.requestedBy.authMethod === identity.authMethod && entry.requestedBy.subject === identity.subject;
    const item: TenantExportRequest = {
      requestId: entry.requestId, status, reason: entry.reason, requestedBy: entry.requestedBy.subject, requestedByMe,
      requestedAt: entry.requestedAt, approvalExpiresAt: entry.approvalExpiresAt, decidedBy: entry.decidedBy, decidedAt: entry.decidedAt,
      decisionNote: entry.decisionNote, cancelledAt: entry.cancelledAt, statusChangedAt: entry.statusChangedAt,
      artifact: entry.artifact === null ? null : { checksumSha256: entry.artifact.checksumSha256, sizeBytes: entry.artifact.sizeBytes, expiresAt: entry.artifact.expiresAt, manifest: entry.artifact.manifest },
      actions: tenantExportActions(status, requestedByMe, downloadAvailable),
    };
    if (withHistory) item.history = entry.history.map((event) => ({ ...event }));
    return item;
  }

  private find(identity: RequestIdentity, requestId: string): Entry {
    const entry = isUuid(requestId) ? this.tenant(identity).entries.find((candidate) => candidate.requestId === requestId) : undefined;
    if (!entry) throw new DataGovernanceError("data_export_not_found", 404);
    return entry;
  }

  /** A pending request whose approval window has passed lapses the way the SQL function lapses it, on the next write. */
  private lapse(tenant: Tenant): void {
    const now = this.now().getTime();
    for (const entry of tenant.entries) {
      if (entry.state === "pending_approval" && Date.parse(entry.approvalExpiresAt) <= now) this.move(entry, "expired", "expired", SYSTEM, "no second organization admin approved in time");
    }
  }

  async request(identity: RequestIdentity, command: { reason: string }): Promise<TenantExportRequest> {
    const tenant = this.tenant(identity);
    this.lapse(tenant);
    if (tenant.entries.some((entry) => entry.state === "pending_approval" || entry.state === "approved" || entry.state === "building")) {
      throw new DataGovernanceError("data_export_already_active", 409);
    }
    const entry = this.entry(identity.subject, 0, command.reason);
    entry.requestedBy = { authMethod: identity.authMethod, subject: identity.subject };
    tenant.entries.push(entry);
    return this.view(entry, identity);
  }

  /** Newest first, keyset-paged exactly like the Postgres list: (requested_at desc, request_id desc), the cursor holding the last item's position. */
  async list(identity: RequestIdentity, query: TenantExportListQuery): Promise<TenantExportPage> {
    const after = query.cursor ? decodeKeysetCursor(query.cursor) : null;
    const key = (entry: Entry) => ({ at: Date.parse(entry.requestedAt), id: entry.requestId });
    const ordered = [...this.tenant(identity).entries].sort((a, b) => key(b).at - key(a).at || (key(a).id < key(b).id ? 1 : -1));
    const remaining = after === null ? ordered : ordered.filter((entry) => {
      const position = key(entry);
      const bound = Date.parse(`${after.at.slice(0, 23)}Z`);
      return position.at < bound || (position.at === bound && position.id < after.id);
    });
    const page = remaining.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((entry) => this.view(entry, identity)),
      // The demo keeps millisecond timestamps; the cursor format carries microseconds, so pad the digits Postgres would have.
      nextCursor: remaining.length > query.limit && last ? encodeKeysetCursor(last.requestedAt.replace("Z", "000Z"), last.requestId) : null,
    };
  }

  async get(identity: RequestIdentity, requestId: string): Promise<TenantExportRequest> {
    return this.view(this.find(identity, requestId), identity, true);
  }

  async decide(identity: RequestIdentity, requestId: string, command: DecisionCommand): Promise<TenantExportRequest> {
    const entry = this.find(identity, requestId);
    if (command.expectedStatus !== undefined && command.expectedStatus !== entry.state) throw new DataGovernanceError("data_export_status_changed", 409);
    const mine = entry.requestedBy.authMethod === identity.authMethod && entry.requestedBy.subject === identity.subject;
    if (command.action === "cancel") {
      if (entry.state !== "pending_approval" && entry.state !== "approved") throw new DataGovernanceError("data_export_transition_not_allowed", 409);
      if (!mine) throw new DataGovernanceError("data_export_cancel_requester_only", 403);
      this.move(entry, "cancelled", "cancelled", identity.subject, command.note ?? null);
      entry.cancelledAt = entry.statusChangedAt;
      return this.view(entry, identity);
    }
    if (entry.state !== "pending_approval") throw new DataGovernanceError("data_export_transition_not_allowed", 409);
    if (mine) throw new DataGovernanceError("data_export_independent_approver_required", 403);
    if (Date.parse(entry.approvalExpiresAt) <= this.now().getTime()) throw new DataGovernanceError("data_export_approval_expired", 409);
    if (command.action === "reject") {
      this.move(entry, "rejected", "rejected", identity.subject, command.note);
      entry.decidedBy = identity.subject; entry.decidedAt = entry.statusChangedAt; entry.decisionNote = command.note;
      return this.view(entry, identity);
    }
    this.approveAndBuild(identity.tenantId, entry, identity.subject, command.note ?? null);
    return this.view(entry, identity);
  }

  async issueDownload(identity: RequestIdentity, requestId: string): Promise<{ request: TenantExportRequest; download: TenantExportDownload }> {
    const entry = this.find(identity, requestId);
    const request = this.view(entry, identity);
    if (!request.actions.canDownload) throw new DataGovernanceError("data_export_not_available", 409);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(Date.parse(entry.artifact!.expiresAt), this.now().getTime() + TENANT_EXPORT_LINK_MINUTES * 60_000);
    this.tenant(identity).grants.set(sha256(token), { requestId, subject: identity.subject, expiresAt, consumed: false });
    return { request, download: { downloadUrl: `/api/v1/access/data-exports/${requestId}/download?grant=${encodeURIComponent(token)}`, downloadExpiresAt: new Date(expiresAt).toISOString() } };
  }

  async redeemDownload(identity: RequestIdentity, requestId: string, token: string): Promise<RedeemedTenantExport | null> {
    if (!isUuid(requestId) || !token || token.length > 256) return null;
    const grant = this.tenant(identity).grants.get(sha256(token));
    const entry = this.tenant(identity).entries.find((candidate) => candidate.requestId === requestId);
    if (!grant || grant.consumed || grant.requestId !== requestId || grant.subject !== identity.subject || grant.expiresAt <= this.now().getTime()) return null;
    if (!entry || entry.state !== "complete" || !entry.artifact || Date.parse(entry.artifact.expiresAt) <= this.now().getTime()) return null;
    grant.consumed = true;
    return { objectUri: `demo://${requestId}`, checksumSha256: entry.artifact.checksumSha256, sizeBytes: entry.artifact.sizeBytes };
  }

  async openArtifact(identity: RequestIdentity, requestId: string): Promise<TenantExportStream | null> {
    const artifact = this.tenant(identity).entries.find((entry) => entry.requestId === requestId)?.artifact;
    if (!artifact) return null;
    return { body: new Uint8Array(artifact.bytes), contentType: "application/zip", contentLength: String(artifact.bytes.length) };
  }
}

let singleton: DemoTenantExportStore | undefined;
export function demoTenantExportStore(): DemoTenantExportStore {
  if (!singleton) singleton = new DemoTenantExportStore();
  return singleton;
}
