import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { connectionTransition, type ConnectionAction } from "../domain/source-connection-health.ts";
import { classifyRunFailure, collectDocuments, type CollectionCounts, type LedgerEntry } from "../server/source-connector-sync.ts";
import {
  ConnectorGovernanceError,
  acquisitionKey,
  statusAfterError,
  type ConnectionStatus,
  type ConnectorDriver,
  type ConnectorErrorClass,
  type IngestSink,
  type SourceConnection,
} from "../server/source-connectors.ts";
import { emptySyncSummary, leaseExpiry, nextRunAt, type SourceSyncSummary } from "../server/source-sync-schedule.ts";
import { DEMO_OAUTH_PROVIDER_KEY, DEMO_TOKEN_PROVIDER_KEY, type DemoTestOutcome } from "./source-providers.ts";
import { demoConnectorDriver } from "./source-driver.ts";
import { plainAcquisitionReason, type SourceActivityAcquisition, type SourceActivityConnection, type SourceActivityRun } from "../server/source-lifecycle.ts";

/**
 * In-memory source connections for demo mode and the browser suites; not
 * production evidence. Each tenant+workspace gets its own seeded set on first
 * use, so a test that pauses or revokes a connection under its own demo tenant
 * header never disturbs another test. Lifecycle changes go through the same
 * `connectionTransition` rules the Postgres path uses, and no credential is
 * ever held: a reauthorization only proves a non-empty secret arrived.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * `testOutcome` is the non-secret result the next connectivity test reports; a seeded connection derives it from its last error.
 * `collected` is set only on a connection made through the wizard with a demo provider: it is the one kind the demo scheduler
 * collects from (the seeded ones keep their fixed history), and it remembers the acquisition keys already ingested.
 */
type Entry = { connection: SourceConnection; runs: SourceActivityRun[]; testOutcome?: DemoTestOutcome; collected?: Set<string> };

/** The providers the demo scheduler has a (demonstration) driver for. */
const DEMO_COLLECTED_PROVIDERS: ReadonlySet<string> = new Set([DEMO_OAUTH_PROVIDER_KEY, DEMO_TOKEN_PROVIDER_KEY]);
const DEMO_MAX_ATTEMPTS = 5;

export type DemoCreateInput = {
  providerKey: string;
  connectionLabel: string;
  credentialType: SourceConnection["credentialType"];
  scope: SourceConnection["sourceScope"];
  connectorVersion: string;
  testOutcome: DemoTestOutcome;
};

type Seed = {
  slot: number;
  providerKey: string;
  connectionLabel: string;
  credentialType: SourceConnection["credentialType"];
  scope: SourceConnection["sourceScope"];
  status: ConnectionStatus;
  consecutiveFailures?: number;
  lastErrorClass?: ConnectorErrorClass;
  lastSuccessHoursAgo?: number;
  lastAttemptHoursAgo?: number;
  /** An active seeded connection's next scheduled sync, in hours from now. */
  nextSyncInHours?: number;
  revokedDaysAgo?: number;
  runs: Array<{ hoursAgo: number; state: SourceActivityRun["state"]; accepted?: number; duplicate?: number; errorClass?: ConnectorErrorClass }>;
};

const SEEDS: Seed[] = [
  {
    slot: 1, providerKey: "demo-lp-portal", connectionLabel: "Meridian LP portal", credentialType: "scoped_api_token",
    scope: [{ label: "Quarterly reports", path: "/Fund III/Quarterly" }, { label: "Capital account statements", path: "/Fund III/Capital accounts" }],
    status: "active", lastSuccessHoursAgo: 3, lastAttemptHoursAgo: 3, nextSyncInHours: 3,
    runs: [{ hoursAgo: 3, state: "succeeded", accepted: 2, duplicate: 1 }, { hoursAgo: 27, state: "succeeded", accepted: 0, duplicate: 3 }],
  },
  {
    slot: 2, providerKey: "demo-administrator", connectionLabel: "Harbor fund administrator", credentialType: "service_account",
    scope: [{ label: "Investor reporting" }],
    status: "active", lastSuccessHoursAgo: 6 * 24, lastAttemptHoursAgo: 6 * 24, nextSyncInHours: 2,
    runs: [{ hoursAgo: 6 * 24, state: "succeeded", accepted: 4 }],
  },
  {
    slot: 3, providerKey: "demo-data-room", connectionLabel: "Northgate data room", credentialType: "scoped_api_token",
    scope: [{ label: "Fund IV reports" }, { label: "Side letters" }, { label: "Annual meeting materials" }],
    status: "paused", lastSuccessHoursAgo: 9 * 24, lastAttemptHoursAgo: 9 * 24,
    runs: [{ hoursAgo: 9 * 24, state: "succeeded", accepted: 1 }],
  },
  {
    slot: 4, providerKey: "demo-investor-portal", connectionLabel: "Atlas investor portal", credentialType: "scoped_api_token",
    scope: [{ label: "Quarterly reports" }],
    status: "reauthorization_required", consecutiveFailures: 1, lastErrorClass: "auth", lastSuccessHoursAgo: 30, lastAttemptHoursAgo: 2,
    runs: [{ hoursAgo: 2, state: "refused", errorClass: "auth" }, { hoursAgo: 30, state: "succeeded", accepted: 1 }],
  },
  {
    slot: 5, providerKey: "demo-vdr", connectionLabel: "Summit virtual data room", credentialType: "oauth_authorization_code",
    scope: [{ label: "Portfolio company financials", path: "/Portfolio/Financials" }],
    status: "suspended", consecutiveFailures: 1, lastErrorClass: "permission", lastSuccessHoursAgo: 5 * 24, lastAttemptHoursAgo: 20,
    runs: [{ hoursAgo: 20, state: "refused", errorClass: "permission" }, { hoursAgo: 5 * 24, state: "succeeded", accepted: 2 }],
  },
  {
    slot: 6, providerKey: "demo-gp-site", connectionLabel: "Cobalt GP site", credentialType: "browser_session",
    scope: [{ label: "LP letters" }],
    status: "active", consecutiveFailures: 2, lastErrorClass: "network", lastSuccessHoursAgo: 5, lastAttemptHoursAgo: 0.3, nextSyncInHours: 0.25,
    runs: [{ hoursAgo: 0.3, state: "retryable", errorClass: "network" }, { hoursAgo: 5, state: "succeeded", accepted: 1 }],
  },
  {
    slot: 7, providerKey: "demo-legacy-drop", connectionLabel: "Legacy SFTP drop", credentialType: "service_account",
    scope: [{ label: "Legacy reports" }],
    status: "revoked", lastSuccessHoursAgo: 45 * 24, lastAttemptHoursAgo: 45 * 24, revokedDaysAgo: 40,
    runs: [{ hoursAgo: 45 * 24, state: "succeeded", accepted: 6 }],
  },
];

function nextScheduled(next: Date | null): { nextScheduledAt?: string } {
  return next ? { nextScheduledAt: next.toISOString() } : {};
}

/** The stable key under which the ledger remembers an ingested document version (same derivation as production). */
function acquisitionKeyOf(item: LedgerEntry): string {
  return acquisitionKey(item.ref.remoteDocumentId, item.ref.remoteVersion, item.contentSha256);
}

function connectionId(slot: number): string {
  return `00000000-0000-4000-8000-${String(slot).padStart(12, "d")}`;
}

/** Mirrors `connectionAttention` in src/modules/sources/server/source-lifecycle.ts, which is the production source of these sentences. */
function attentionReason(status: ConnectionStatus, failures: number): string | undefined {
  if (status === "reauthorization_required") return "Connection authorization must be renewed before acquisition can continue.";
  if (status === "suspended") return "Connection is suspended and needs administrator attention.";
  if (failures >= 3) return `Connection has failed ${failures} consecutive times.`;
  return undefined;
}

export class DemoSourceConnectionStore {
  private readonly workspaces = new Map<string, Map<string, Entry>>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) { this.now = now; }

  private iso(hoursAgo: number): string { return new Date(this.now().getTime() - hoursAgo * HOUR_MS).toISOString(); }

  private seed(identity: RequestIdentity): Map<string, Entry> {
    const entries = new Map<string, Entry>();
    for (const seed of SEEDS) {
      const sourceConnectionId = connectionId(seed.slot);
      const connection: SourceConnection = {
        sourceConnectionId,
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        providerKey: seed.providerKey,
        connectionLabel: seed.connectionLabel,
        credentialType: seed.credentialType,
        sourceScope: seed.scope,
        scopeConfirmedBy: "demo|seed",
        scopeConfirmedAt: this.iso(60 * 24),
        secretReference: "redacted",
        connectorVersion: "demo-1",
        status: seed.status,
        consecutiveFailures: seed.consecutiveFailures ?? 0,
        ...(seed.lastErrorClass ? { lastErrorClass: seed.lastErrorClass } : {}),
        ...(seed.lastSuccessHoursAgo !== undefined ? { lastSuccessAt: this.iso(seed.lastSuccessHoursAgo) } : {}),
        ...(seed.lastAttemptHoursAgo !== undefined ? { lastAttemptAt: this.iso(seed.lastAttemptHoursAgo) } : {}),
        ...(seed.nextSyncInHours !== undefined ? { nextScheduledAt: this.iso(-seed.nextSyncInHours) } : {}),
        ...(seed.revokedDaysAgo !== undefined ? { revokedAt: this.iso(seed.revokedDaysAgo * 24) } : {}),
      };
      const runs = seed.runs.map((run, index): SourceActivityRun => {
        const acquisitions: SourceActivityAcquisition[] = [
          ...Array.from({ length: run.accepted ?? 0 }, (_, i) => ({ acquisitionId: `${sourceConnectionId}-r${index}-a${i}`, disposition: "accepted" as const, remotePath: `/reports/${seed.slot}-${index}-${i + 1}.pdf`, remoteVersion: "v1", acquiredAt: this.iso(run.hoursAgo), reason: "Accepted into the normal document processing lifecycle." })),
          ...Array.from({ length: run.duplicate ?? 0 }, (_, i) => ({ acquisitionId: `${sourceConnectionId}-r${index}-d${i}`, disposition: "duplicate" as const, remotePath: `/reports/${seed.slot}-${index}-dup-${i + 1}.pdf`, remoteVersion: "v1", acquiredAt: this.iso(run.hoursAgo), reason: "Already acquired unchanged; no duplicate document was created." })),
        ];
        return {
          runId: `00000000-0000-4000-8${String(index).padStart(3, "0")}-${String(seed.slot).padStart(12, "e")}`,
          trigger: "scheduled", state: run.state, attempt: 1, maxAttempts: 5,
          discoveredCount: acquisitions.length, acceptedCount: run.accepted ?? 0, duplicateCount: run.duplicate ?? 0, rejectedCount: 0,
          startedAt: this.iso(run.hoursAgo), finishedAt: this.iso(run.hoursAgo), zeroDiscoveryLongRunning: false,
          ...(run.errorClass ? { errorClass: run.errorClass } : {}), acquisitions,
        };
      });
      entries.set(sourceConnectionId, { connection, runs });
    }
    return entries;
  }

  private entries(identity: RequestIdentity): Map<string, Entry> {
    const key = `${identity.tenantId}:${identity.workspaceId}`;
    let entries = this.workspaces.get(key);
    if (!entries) { entries = this.seed(identity); this.workspaces.set(key, entries); }
    return entries;
  }

  private entry(identity: RequestIdentity, sourceConnectionId: string): Entry {
    const entry = this.entries(identity).get(sourceConnectionId);
    if (!entry) throw new ConnectorGovernanceError("connection_not_found");
    return entry;
  }

  list(identity: RequestIdentity): SourceConnection[] {
    return [...this.entries(identity).values()].map((entry) => ({ ...entry.connection }));
  }

  get(identity: RequestIdentity, sourceConnectionId: string): SourceConnection {
    return { ...this.entry(identity, sourceConnectionId).connection };
  }

  /** Applies the same transition rules as production; a refused command changes nothing. */
  transition(identity: RequestIdentity, sourceConnectionId: string, action: Exclude<ConnectionAction, "reauthorize">): SourceConnection {
    const entry = this.entry(identity, sourceConnectionId);
    const outcome = connectionTransition(action, entry.connection.status);
    if ("refused" in outcome) throw new ConnectorGovernanceError(outcome.refused);
    const revokedAt = action === "revoke" && entry.connection.status !== "revoked" ? this.now().toISOString() : entry.connection.revokedAt;
    entry.connection = { ...entry.connection, status: outcome.status, ...(revokedAt ? { revokedAt } : {}) };
    return { ...entry.connection };
  }

  /** The secret is validated for presence and then dropped; it is never kept or echoed. */
  reauthorize(identity: RequestIdentity, sourceConnectionId: string): SourceConnection {
    const entry = this.entry(identity, sourceConnectionId);
    const outcome = connectionTransition("reauthorize", entry.connection.status);
    if ("refused" in outcome) throw new ConnectorGovernanceError(outcome.refused);
    const { lastErrorClass, ...rest } = entry.connection;
    void lastErrorClass;
    // A replaced credential is assumed good until the next test says otherwise.
    entry.connection = { ...rest, status: outcome.status, consecutiveFailures: 0 };
    entry.testOutcome = { ok: true };
    return { ...entry.connection };
  }

  /**
   * Registers a connection from a connect-wizard request. It starts as
   * `pending_authorization` exactly like production: only a passing test
   * activates it. The caller derives `testOutcome` from the submitted
   * credential and the credential itself is never passed in or kept. The new
   * connection is listed first, like production's newest-first listing.
   */
  create(identity: RequestIdentity, input: DemoCreateInput): SourceConnection {
    const existing = this.entries(identity);
    const sourceConnectionId = randomUUID();
    const connection: SourceConnection = {
      sourceConnectionId,
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      providerKey: input.providerKey,
      connectionLabel: input.connectionLabel,
      credentialType: input.credentialType,
      sourceScope: input.scope.map((item) => ({ ...item })),
      scopeConfirmedBy: identity.subject,
      scopeConfirmedAt: this.now().toISOString(),
      secretReference: "redacted",
      connectorVersion: input.connectorVersion,
      status: "pending_authorization",
      consecutiveFailures: 0,
    };
    // A connection to a demo provider is collected from by the demo scheduler (see runDueSyncs); no schedule yet, so it is due as soon as it is active.
    const collected = DEMO_COLLECTED_PROVIDERS.has(input.providerKey) ? new Set<string>() : undefined;
    this.workspaces.set(`${identity.tenantId}:${identity.workspaceId}`, new Map([[sourceConnectionId, { connection, runs: [], testOutcome: input.testOutcome, ...(collected ? { collected } : {}) }], ...existing]));
    return { ...connection };
  }

  /**
   * The demo scheduler: the same collection loop, failure rules and schedule as production (collectDocuments,
   * classifyRunFailure and nextRunAt, shared with src/modules/sources/server/source-connector-sync.ts) over the in-memory connections,
   * with the demonstration driver and the supplied ingest sink. Only an active connection made through the wizard with a
   * demo provider is collected from; one that is not active (a failed test, paused, awaiting reauthorization) never is.
   * A connection is claimed by pushing its next run time out by the lease before anything is read, so overlapping
   * passes never collect the same connection twice. Pass an identity to collect only that workspace's connections.
   */
  async runDueSyncs(options: { ingest: IngestSink; now?: number; identity?: RequestIdentity; drivers?: Map<string, ConnectorDriver> }): Promise<SourceSyncSummary> {
    const summary = emptySyncSummary();
    const workspaces = options.identity ? [this.entries(options.identity)] : [...this.workspaces.values()];
    for (const entries of workspaces) {
      for (const entry of entries.values()) {
        const at = options.now ?? this.now().getTime();
        const { connection } = entry;
        if (!entry.collected || connection.status !== "active") continue;
        if (connection.nextScheduledAt !== undefined && Date.parse(connection.nextScheduledAt) > at) continue;
        summary.due += 1;
        entry.connection = { ...connection, nextScheduledAt: leaseExpiry(at).toISOString() };
        await this.collect(entry, entry.collected, options.drivers?.get(connection.providerKey) ?? demoConnectorDriver(connection.providerKey), options.ingest, at, summary);
      }
    }
    return summary;
  }

  private async collect(entry: Entry, collected: Set<string>, driver: ConnectorDriver, ingest: IngestSink, at: number, summary: SourceSyncSummary): Promise<void> {
    const connection = entry.connection;
    const attempt = connection.consecutiveFailures + 1;
    const startedAt = new Date(at).toISOString();
    const acquisitions: SourceActivityAcquisition[] = [];
    const counts: CollectionCounts = { discovered: 0, accepted: 0, duplicate: 0, rejected: 0 };
    const run: SourceActivityRun = {
      runId: randomUUID(), trigger: "scheduled", state: "running", attempt, maxAttempts: DEMO_MAX_ATTEMPTS,
      discoveredCount: 0, acceptedCount: 0, duplicateCount: 0, rejectedCount: 0, startedAt, zeroDiscoveryLongRunning: false, acquisitions,
    };
    entry.runs = [run, ...entry.runs];
    const ledger = {
      alreadyAcquired: async (key: string) => collected.has(key),
      record: async (item: LedgerEntry) => {
        if (item.disposition === "accepted") collected.add(acquisitionKeyOf(item));
        acquisitions.push({
          acquisitionId: randomUUID(), disposition: item.disposition, remotePath: item.ref.remotePath, remoteVersion: item.ref.remoteVersion,
          acquiredAt: startedAt, ...(item.documentId ? { documentId: item.documentId } : {}), reason: plainAcquisitionReason(item.disposition, item.rejectionReason),
        });
      },
    };
    const finish = (state: SourceActivityRun["state"], errorClass?: ConnectorErrorClass) => {
      Object.assign(run, {
        state, discoveredCount: counts.discovered, acceptedCount: counts.accepted, duplicateCount: counts.duplicate, rejectedCount: counts.rejected,
        finishedAt: startedAt, ...(errorClass ? { errorClass } : {}),
      });
    };
    try {
      await collectDocuments({ connection, driver, credential: {}, ledger, ingest }, counts);
      finish("succeeded");
      const { lastErrorClass, ...rest } = entry.connection;
      void lastErrorClass;
      entry.connection = { ...rest, consecutiveFailures: 0, lastSuccessAt: startedAt, lastAttemptAt: startedAt, ...nextScheduled(nextRunAt({ outcome: "succeeded", status: "active", consecutiveFailures: 0, now: at })) };
      summary.succeeded += 1;
    } catch (error) {
      const failure = classifyRunFailure(error, attempt, DEMO_MAX_ATTEMPTS, connection.consecutiveFailures);
      finish(failure.state, failure.errorClass);
      const failures = connection.consecutiveFailures + 1;
      const { nextScheduledAt, ...rest } = entry.connection;
      void nextScheduledAt;
      entry.connection = {
        ...rest, consecutiveFailures: failures, lastErrorClass: failure.errorClass, lastAttemptAt: startedAt, status: failure.nextStatus,
        ...nextScheduled(nextRunAt({ outcome: "failed", status: failure.nextStatus, consecutiveFailures: failures, now: at })),
      };
      if (failure.state === "refused") summary.refused += 1; else summary.failed += 1;
    }
  }

  /**
   * A connectivity test with production's effects: a passing test activates a pending connection, a failure moves it
   * the way `statusAfterError` says (so a failed first test leaves it pending, never active), and a revoked one is refused.
   */
  test(identity: RequestIdentity, sourceConnectionId: string): { ok: boolean; errorClass?: ConnectorErrorClass } {
    const entry = this.entry(identity, sourceConnectionId);
    const current = entry.connection;
    if (current.status === "revoked") throw new ConnectorGovernanceError("connection_revoked");
    const outcome: DemoTestOutcome = entry.testOutcome ?? (current.lastErrorClass ? { ok: false, errorClass: current.lastErrorClass } : { ok: true });
    if (outcome.ok) {
      if (current.status === "pending_authorization") entry.connection = { ...current, status: "active" };
      return { ok: true };
    }
    entry.connection = { ...current, status: statusAfterError(current.status, outcome.errorClass, current.consecutiveFailures), lastErrorClass: outcome.errorClass };
    return { ok: false, errorClass: outcome.errorClass };
  }

  activity(identity: RequestIdentity): SourceActivityConnection[] {
    return [...this.entries(identity).values()].map(({ connection, runs }) => {
      const reason = attentionReason(connection.status, connection.consecutiveFailures);
      return {
        sourceConnectionId: connection.sourceConnectionId, providerKey: connection.providerKey, connectionLabel: connection.connectionLabel,
        status: connection.status, consecutiveFailures: connection.consecutiveFailures,
        ...(connection.lastSuccessAt ? { lastSuccessAt: connection.lastSuccessAt } : {}),
        ...(connection.lastAttemptAt ? { lastAttemptAt: connection.lastAttemptAt } : {}),
        needsAttention: Boolean(reason), ...(reason ? { attentionReason: reason } : {}),
        runs,
      };
    });
  }
}

// Kept on `globalThis` so `next dev` re-evaluating server modules (it does so when another route is compiled)
// cannot reset the demo data mid-flow, for example between creating a connection and listing it.
const shared = globalThis as typeof globalThis & { demoSourceConnectionStore?: DemoSourceConnectionStore };
export function demoSourceConnectionStore(): DemoSourceConnectionStore {
  if (!shared.demoSourceConnectionStore) shared.demoSourceConnectionStore = new DemoSourceConnectionStore();
  return shared.demoSourceConnectionStore;
}
