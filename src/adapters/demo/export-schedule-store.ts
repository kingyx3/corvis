import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  exportScopeSummary,
  nextScheduledRunAt,
  type CreateExportScheduleCommand,
  type ExportSchedule,
  type ExportScheduleAction,
  type ExportScheduleRun,
} from "../../core/export-schedule.ts";
import { decodeCursor, encodeCursor } from "../../lib/server/pagination.ts";
import {
  ExportScheduleRequestError,
  isTenantAdminIdentity,
  scheduleFingerprint,
  type DeletedExportSchedule,
  type ExportScheduleBackend,
  type ExportScheduleListQuery,
  type ExportSchedulePage,
  type ExportScheduleRunListQuery,
  type ExportScheduleRunPage,
} from "../../lib/server/export-schedule.ts";

/**
 * In-memory scheduled exports for demo mode and the browser suites; not production evidence. Each demo tenant gets its
 * own schedules, and each owning subject is seeded once with two representative schedules (an active monthly one with a
 * delivered run, and a paused on-publish one whose last run was refused) so the schedule list, status labels and run
 * history can be exercised without any setup. Creating, pausing, resuming and deleting work exactly as in Postgres.
 *
 * Demo mode has no worker: nothing here ever runs on its own, so a schedule created in the demo shows its next calendar
 * run (or waits for a publication) but accumulates no runs. The seeded runs are illustrative.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_SCHEDULES_PER_OWNER = 50;

type Owner = { authMethod: string; subject: string };
type Entry = { item: Omit<ExportSchedule, "ownedByMe" | "lastRun">; owner: Owner; deleted: boolean; runs: ExportScheduleRun[] };
type Tenant = { entries: Entry[]; seeded: Set<string>; keys: Map<string, { fingerprint: string; scheduleId: string }> };

export class DemoExportScheduleStore implements ExportScheduleBackend {
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
      tenant.entries.push(...this.seeds(identity));
    }
    return tenant;
  }

  private seeds(identity: RequestIdentity): Entry[] {
    const at = (hoursAgo: number) => new Date(this.now().getTime() - hoursAgo * HOUR_MS).toISOString();
    const owner = { authMethod: identity.authMethod, subject: identity.subject };
    const monthlyScope = { positionFinancials: { fundId: "fund-eqt-ix", holdingId: "holding-project-sparrow", companyId: "company-project-sparrow", periodicity: "quarterly" as const } };
    const publishScope = { snapshotId: "seed-snapshot-4" };
    const monthlyId = randomUUID();
    const publishId = randomUUID();
    const run = (scheduleId: string, label: string, scope: ExportSchedule["scope"], format: ExportSchedule["format"], triggerKey: string, hoursAgo: number, rest: Partial<ExportScheduleRun>): ExportScheduleRun => ({
      runId: randomUUID(), scheduleId, scheduleLabel: label, scopeLabel: exportScopeSummary(scope), format, triggerKey, createdAt: at(hoursAgo), outcome: "requested", ...rest,
    });
    const monthlyLabel = "Monthly · Project Sparrow financials";
    const publishLabel = "On publish · Hg Genesis 9 Q1 2026";
    const lastMonth = this.now().getTime() - 20 * DAY_MS;
    const lastMonthKey = new Date(lastMonth).toISOString().slice(0, 7);
    return [
      {
        item: {
          scheduleId: monthlyId, label: monthlyLabel, scope: monthlyScope, scopeLabel: exportScopeSummary(monthlyScope), format: "csv", trigger: "monthly",
          status: "active", stopReason: null, notifyOnCompletion: true, owner: identity.subject, createdAt: at(24 * 45), updatedAt: at(24 * 45),
          nextRunAt: nextScheduledRunAt("monthly", this.now()).toISOString(),
        },
        owner, deleted: false,
        runs: [run(monthlyId, monthlyLabel, monthlyScope, "csv", `monthly:${lastMonthKey}`, 24 * 20, { exportId: randomUUID(), exportState: "complete" })],
      },
      {
        item: {
          scheduleId: publishId, label: publishLabel, scope: publishScope, scopeLabel: exportScopeSummary(publishScope), format: "xlsx", trigger: "on_publish",
          status: "paused", stopReason: null, notifyOnCompletion: true, owner: identity.subject, createdAt: at(24 * 30), updatedAt: at(24 * 3), nextRunAt: null,
        },
        owner, deleted: false,
        runs: [
          run(publishId, publishLabel, publishScope, "xlsx", "publish:seed-snapshot-4:v1", 24 * 4, { outcome: "failed", failureReason: "redistribution_not_permitted" }),
          run(publishId, publishLabel, publishScope, "xlsx", "publish:seed-snapshot-3:v1", 24 * 25, { exportId: randomUUID(), exportState: "complete" }),
        ],
      },
    ];
  }

  private view(entry: Entry, identity: RequestIdentity): ExportSchedule {
    return {
      ...entry.item, scope: structuredClone(entry.item.scope),
      ownedByMe: entry.owner.authMethod === identity.authMethod && entry.owner.subject === identity.subject,
      lastRun: entry.runs[0] ? { ...entry.runs[0] } : null,
    };
  }

  private isOwner(identity: RequestIdentity, entry: Entry): boolean {
    return entry.owner.authMethod === identity.authMethod && entry.owner.subject === identity.subject;
  }

  /** The entry if the caller may see it (owner, or an Organization Admin); a missing, foreign or deleted one is the same 404. */
  private visible(identity: RequestIdentity, scheduleId: string): Entry {
    const entry = this.tenant(identity).entries.find((candidate) => candidate.item.scheduleId === scheduleId && !candidate.deleted);
    if (!entry || !(isTenantAdminIdentity(identity) || this.isOwner(identity, entry))) throw new ExportScheduleRequestError("export_schedule_not_found", 404);
    return entry;
  }

  private owned(identity: RequestIdentity, scheduleId: string): Entry {
    const entry = this.visible(identity, scheduleId);
    if (!this.isOwner(identity, entry)) throw new ExportScheduleRequestError("export_schedule_not_found", 404);
    return entry;
  }

  async create(identity: RequestIdentity, command: CreateExportScheduleCommand): Promise<{ item: ExportSchedule; created: boolean }> {
    const tenant = this.tenant(identity);
    const keyed = `${identity.authMethod}|${identity.subject}|${command.idempotencyKey}`;
    const fingerprint = scheduleFingerprint(command);
    const known = tenant.keys.get(keyed);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new ExportScheduleRequestError("idempotency_key_reused", 409);
      return { item: this.view(this.visible(identity, known.scheduleId), identity), created: false };
    }
    if (tenant.entries.filter((entry) => !entry.deleted && this.isOwner(identity, entry)).length >= MAX_SCHEDULES_PER_OWNER) {
      throw new ExportScheduleRequestError("export_schedule_limit_reached", 409);
    }
    const at = this.now();
    const entry: Entry = {
      item: {
        scheduleId: randomUUID(), label: command.label, scope: structuredClone(command.scope), scopeLabel: exportScopeSummary(command.scope), format: command.format,
        trigger: command.trigger, status: "active", stopReason: null, notifyOnCompletion: command.notifyOnCompletion, owner: identity.subject, createdAt: at.toISOString(), updatedAt: at.toISOString(),
        nextRunAt: command.trigger === "on_publish" ? null : nextScheduledRunAt(command.trigger, at).toISOString(),
      },
      owner: { authMethod: identity.authMethod, subject: identity.subject }, deleted: false, runs: [],
    };
    tenant.entries.push(entry);
    tenant.keys.set(keyed, { fingerprint, scheduleId: entry.item.scheduleId });
    return { item: this.view(entry, identity), created: true };
  }

  async list(identity: RequestIdentity, query: ExportScheduleListQuery): Promise<ExportSchedulePage> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const matching = this.tenant(identity).entries
      .filter((entry) => !entry.deleted && (query.scope === "all" || this.isOwner(identity, entry)))
      .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || b.item.scheduleId.localeCompare(a.item.scheduleId));
    const start = after ? matching.findIndex((entry) => entry.item.scheduleId === after) + 1 : 0;
    const page = matching.slice(start, start + query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((entry) => this.view(entry, identity)),
      nextCursor: last && start + query.limit < matching.length ? encodeCursor(last.item.scheduleId) : null,
    };
  }

  async get(identity: RequestIdentity, scheduleId: string): Promise<ExportSchedule> {
    return this.view(this.visible(identity, scheduleId), identity);
  }

  async setStatus(identity: RequestIdentity, scheduleId: string, action: ExportScheduleAction): Promise<ExportSchedule> {
    const entry = this.owned(identity, scheduleId);
    const at = this.now();
    if (action === "pause" && entry.item.status === "active") {
      entry.item.status = "paused";
      entry.item.nextRunAt = null;
    } else if (action === "resume" && entry.item.status === "paused") {
      entry.item.status = "active";
      entry.item.nextRunAt = entry.item.trigger === "on_publish" ? null : nextScheduledRunAt(entry.item.trigger, at).toISOString();
    } else {
      throw new ExportScheduleRequestError("export_schedule_transition_not_allowed", 409);
    }
    entry.item.updatedAt = at.toISOString();
    return this.view(entry, identity);
  }

  async setNotification(identity: RequestIdentity, scheduleId: string, notifyOnCompletion: boolean): Promise<ExportSchedule> {
    const entry = this.owned(identity, scheduleId);
    if (entry.item.notifyOnCompletion !== notifyOnCompletion) {
      entry.item.notifyOnCompletion = notifyOnCompletion;
      entry.item.updatedAt = this.now().toISOString();
    }
    return this.view(entry, identity);
  }

  async remove(identity: RequestIdentity, scheduleId: string): Promise<DeletedExportSchedule> {
    const entry = this.owned(identity, scheduleId);
    entry.deleted = true;
    entry.item.nextRunAt = null;
    const { item } = entry;
    return { scheduleId: item.scheduleId, label: item.label, trigger: item.trigger, format: item.format };
  }

  async listRuns(identity: RequestIdentity, query: ExportScheduleRunListQuery): Promise<ExportScheduleRunPage> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    // Unlike the schedule list, history keeps the runs of schedules that were since deleted.
    const matching = this.tenant(identity).entries
      .filter((entry) => (query.scope === "all" || this.isOwner(identity, entry)) && (!query.scheduleId || entry.item.scheduleId === query.scheduleId))
      .flatMap((entry) => entry.runs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
    const start = after ? matching.findIndex((run) => run.runId === after) + 1 : 0;
    const page = matching.slice(start, start + query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((run) => ({ ...run })),
      nextCursor: last && start + query.limit < matching.length ? encodeCursor(last.runId) : null,
    };
  }
}

let singleton: DemoExportScheduleStore | undefined;
export function demoExportScheduleStore(): DemoExportScheduleStore {
  if (!singleton) singleton = new DemoExportScheduleStore();
  return singleton;
}
