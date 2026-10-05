import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  dataIssueTransition,
  previousDataIssueStatus,
  type DataIssueCase,
  type DataIssueEvent,
  type DataIssueScope,
  type DataIssueStatus,
  type DataIssueTransitionCommand,
  type ReportDataIssueCommand,
} from "../domain/data-issue.ts";
import { decodeCursor, encodeCursor } from "../../../platform/http/api/pagination.ts";
import {
  DataIssueRequestError,
  canViewDataIssue,
  entitledToFund,
  isReporter,
  isTenantAdminIdentity,
  reportFingerprint,
  type DataIssueBackend,
  type DataIssueList,
  type DataIssueListQuery,
} from "../server/data-issues/data-issue.ts";

/**
 * In-memory data-issue cases for demo mode and the browser suites; not production evidence. Each demo tenant gets
 * its own cases, and each reporting subject is seeded once with three representative cases (one corrected with an
 * update the reporter has not looked at yet, one investigating, one just received) so the case list, status badges
 * and the unseen-update indicator can be exercised without any setup. Reporting only ever adds a case here: demo
 * snapshots and observations are never touched, exactly as in Postgres.
 */

const HOUR_MS = 60 * 60 * 1000;

type Reporter = { authMethod: string; subject: string };
type Entry = {
  item: Omit<DataIssueCase, "reportedByMe" | "hasUnseenUpdate" | "history" | "correctionIncidentId">;
  reporter: Reporter;
  seenStatus: DataIssueStatus;
  correctionIncidentId?: string;
  history: DataIssueEvent[];
};
type Tenant = { entries: Entry[]; seeded: Set<string>; keys: Map<string, { fingerprint: string; caseId: string }> };

type Seed = {
  figure: DataIssueCase["figure"];
  scope: DataIssueScope;
  comment: string;
  status: DataIssueStatus;
  hoursAgo: number;
  note?: string;
  seenStatus: DataIssueStatus;
};

const SEEDS: Seed[] = [
  {
    figure: "review", status: "corrected", hoursAgo: 52, seenStatus: "investigating",
    scope: { fundId: "fund-advent-viii", fundLabel: "Advent International GPE VIII", companyId: "company-abc-corp", companyLabel: "ABC Corp", metricCode: "Revenue", metricLabel: "Revenue", reportPeriod: "Q2 2026", snapshotId: "seed-snapshot-1", snapshotVersion: 1 },
    comment: "Revenue looks about 10% too high against the company's own report.",
  },
  {
    figure: "position_financials", status: "investigating", hoursAgo: 20, seenStatus: "investigating",
    scope: { fundId: "fund-eqt-ix", fundLabel: "EQT IX", companyId: "company-project-sparrow", companyLabel: "Project Sparrow", metricCode: "Ownership", metricLabel: "Ownership", reportPeriod: "Q1 2026" },
    comment: "Ownership percentage does not match the capital account statement.",
  },
  {
    figure: "overview", status: "received", hoursAgo: 2, seenStatus: "received",
    scope: { fundId: "fund-hg-genesis-9", fundLabel: "Hg Genesis 9", reportPeriod: "Q1 2026", snapshotId: "seed-snapshot-4", snapshotVersion: 1 },
    comment: "The fund value on the Overview differs from our own records.",
  },
];

export class DemoDataIssueStore implements DataIssueBackend {
  readonly demo = true;
  private readonly tenants = new Map<string, Tenant>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) { this.now = now; }

  private tenant(identity: RequestIdentity): Tenant {
    let tenant = this.tenants.get(identity.tenantId);
    if (!tenant) {
      tenant = { entries: [], seeded: new Set(), keys: new Map() };
      this.tenants.set(identity.tenantId, tenant);
    }
    const seedKey = `${identity.authMethod}|${identity.subject}`;
    if (!tenant.seeded.has(seedKey)) {
      tenant.seeded.add(seedKey);
      for (const seed of SEEDS) tenant.entries.push(this.seeded(identity, seed));
    }
    return tenant;
  }

  private seeded(identity: RequestIdentity, seed: Seed): Entry {
    const at = (hoursAgo: number) => new Date(this.now().getTime() - hoursAgo * HOUR_MS).toISOString();
    const path: DataIssueStatus[] = seed.status === "received" ? ["received"] : seed.status === "investigating" ? ["received", "investigating"] : ["received", "investigating", "corrected"];
    const history = path.map((toStatus, step): DataIssueEvent => ({
      fromStatus: step === 0 ? null : path[step - 1]!, toStatus, at: at(seed.hoursAgo - step * 6), note: null,
    }));
    const replacement = seed.status === "corrected" ? { snapshotId: seed.scope.snapshotId!, snapshotVersion: seed.scope.snapshotVersion! + 1 } : null;
    return {
      item: {
        caseId: randomUUID(),
        figure: seed.figure, scope: { ...seed.scope }, comment: seed.comment, status: seed.status, routedTo: "data_operations",
        reportedBy: identity.subject, createdAt: at(seed.hoursAgo), statusChangedAt: history[history.length - 1]!.at,
        resolutionNote: null, replacement,
      },
      reporter: { authMethod: identity.authMethod, subject: identity.subject },
      seenStatus: seed.seenStatus,
      ...(seed.status === "corrected" ? { correctionIncidentId: "00000000-0000-4000-8000-0000000000c1" } : {}),
      history,
    };
  }

  private view(entry: Entry, identity: RequestIdentity, withHistory = false): DataIssueCase {
    const reportedByMe = isReporter(identity, entry.reporter);
    const item: DataIssueCase = {
      ...entry.item, scope: { ...entry.item.scope }, reportedByMe, hasUnseenUpdate: reportedByMe && entry.seenStatus !== entry.item.status,
    };
    if (isTenantAdminIdentity(identity) && entry.correctionIncidentId) item.correctionIncidentId = entry.correctionIncidentId;
    if (withHistory) item.history = entry.history.map((event) => ({ ...event }));
    return item;
  }

  private visible(identity: RequestIdentity, caseId: string): Entry {
    const entry = this.tenant(identity).entries.find((candidate) => candidate.item.caseId === caseId);
    if (!entry || !canViewDataIssue(identity, { reporter: entry.reporter, fundId: entry.item.scope.fundId })) throw new DataIssueRequestError("data_issue_not_found", 404);
    return entry;
  }

  async report(identity: RequestIdentity, command: ReportDataIssueCommand): Promise<{ item: DataIssueCase; created: boolean }> {
    const tenant = this.tenant(identity);
    const keyed = `${identity.authMethod}|${identity.subject}|${command.idempotencyKey}`;
    const fingerprint = reportFingerprint(command);
    const known = tenant.keys.get(keyed);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new DataIssueRequestError("idempotency_key_reused", 409);
      return { item: this.view(this.visible(identity, known.caseId), identity), created: false };
    }
    const at = this.now().toISOString();
    const entry: Entry = {
      item: {
        caseId: randomUUID(), figure: command.figure, scope: { ...command.scope }, comment: command.comment, status: "received", routedTo: "data_operations",
        reportedBy: identity.subject, createdAt: at, statusChangedAt: at, resolutionNote: null, replacement: null,
      },
      reporter: { authMethod: identity.authMethod, subject: identity.subject },
      seenStatus: "received",
      history: [{ fromStatus: null, toStatus: "received", at, note: null }],
    };
    tenant.entries.push(entry);
    tenant.keys.set(keyed, { fingerprint, caseId: entry.item.caseId });
    return { item: this.view(entry, identity), created: true };
  }

  async list(identity: RequestIdentity, query: DataIssueListQuery): Promise<DataIssueList> {
    const all = this.tenant(identity).entries;
    const mine = (entry: Entry) => isReporter(identity, entry.reporter) && entitledToFund(identity, entry.item.scope.fundId);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const matching = all
      .filter((entry) => (query.scope === "all" || mine(entry)) && (!query.status || entry.item.status === query.status))
      .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || b.item.caseId.localeCompare(a.item.caseId));
    const start = after ? matching.findIndex((entry) => entry.item.caseId === after) + 1 : 0;
    const page = matching.slice(start, start + query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((entry) => this.view(entry, identity)),
      nextCursor: last && start + query.limit < matching.length ? encodeCursor(last.item.caseId) : null,
      unseenUpdateCount: all.filter((entry) => mine(entry) && entry.seenStatus !== entry.item.status).length,
    };
  }

  async get(identity: RequestIdentity, caseId: string): Promise<DataIssueCase> {
    return this.view(this.visible(identity, caseId), identity, true);
  }

  async acknowledge(identity: RequestIdentity, caseId: string): Promise<DataIssueCase> {
    const entry = this.visible(identity, caseId);
    // Only the reporter's own marker moves; an Organization Admin looking at someone else's case acknowledges nothing.
    if (!isReporter(identity, entry.reporter)) throw new DataIssueRequestError("data_issue_not_found", 404);
    entry.seenStatus = entry.item.status;
    return this.view(entry, identity);
  }

  async transition(identity: RequestIdentity, caseId: string, command: DataIssueTransitionCommand): Promise<DataIssueCase> {
    const entry = this.visible(identity, caseId);
    if (command.expectedStatus && command.expectedStatus !== entry.item.status) throw new DataIssueRequestError("data_issue_status_changed", 409);
    const to = dataIssueTransition(entry.item.status, command.action);
    if (!to) throw new DataIssueRequestError("data_issue_transition_not_allowed", 409);
    const incident = command.correctionIncidentId ?? entry.correctionIncidentId;
    if (to === "corrected" && !incident) throw new DataIssueRequestError("data_issue_correction_required", 409);
    const at = this.now().toISOString();
    entry.history.push({ fromStatus: previousDataIssueStatus(command.action), toStatus: to, at, note: command.note ?? null });
    entry.item.status = to;
    entry.item.statusChangedAt = at;
    if (incident) entry.correctionIncidentId = incident;
    if (to === "corrected" || to === "no_change") entry.item.resolutionNote = command.note ?? null;
    // There is no governed correction behind a demo case, so the replacement is the next version of the reported snapshot.
    if (to === "corrected") entry.item.replacement = { snapshotId: entry.item.scope.snapshotId ?? randomUUID(), snapshotVersion: (entry.item.scope.snapshotVersion ?? 1) + 1 };
    return this.view(entry, identity);
  }
}

let singleton: DemoDataIssueStore | undefined;
export function demoDataIssueStore(): DemoDataIssueStore {
  if (!singleton) singleton = new DemoDataIssueStore();
  return singleton;
}
