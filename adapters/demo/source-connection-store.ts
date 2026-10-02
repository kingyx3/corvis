import type { RequestIdentity } from "../../core/enterprise.ts";
import { connectionTransition, type ConnectionAction } from "../../core/source-connection-health.ts";
import {
  ConnectorGovernanceError,
  type ConnectionStatus,
  type ConnectorErrorClass,
  type SourceConnection,
} from "../../lib/server/source-connectors.ts";
import type { SourceActivityAcquisition, SourceActivityConnection, SourceActivityRun } from "../../lib/server/source-lifecycle.ts";

/**
 * In-memory source connections for demo mode and the browser suites; not
 * production evidence. Each tenant+workspace gets its own seeded set on first
 * use, so a test that pauses or revokes a connection under its own demo tenant
 * header never disturbs another test. Lifecycle changes go through the same
 * `connectionTransition` rules the Postgres path uses, and no credential is
 * ever held: a reauthorization only proves a non-empty secret arrived.
 */

const HOUR_MS = 60 * 60 * 1000;

type Entry = { connection: SourceConnection; runs: SourceActivityRun[] };

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
  revokedDaysAgo?: number;
  runs: Array<{ hoursAgo: number; state: SourceActivityRun["state"]; accepted?: number; duplicate?: number; errorClass?: ConnectorErrorClass }>;
};

const SEEDS: Seed[] = [
  {
    slot: 1, providerKey: "demo-lp-portal", connectionLabel: "Meridian LP portal", credentialType: "scoped_api_token",
    scope: [{ label: "Quarterly reports", path: "/Fund III/Quarterly" }, { label: "Capital account statements", path: "/Fund III/Capital accounts" }],
    status: "active", lastSuccessHoursAgo: 3, lastAttemptHoursAgo: 3,
    runs: [{ hoursAgo: 3, state: "succeeded", accepted: 2, duplicate: 1 }, { hoursAgo: 27, state: "succeeded", accepted: 0, duplicate: 3 }],
  },
  {
    slot: 2, providerKey: "demo-administrator", connectionLabel: "Harbor fund administrator", credentialType: "service_account",
    scope: [{ label: "Investor reporting" }],
    status: "active", lastSuccessHoursAgo: 6 * 24, lastAttemptHoursAgo: 6 * 24,
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
    status: "active", consecutiveFailures: 2, lastErrorClass: "network", lastSuccessHoursAgo: 5, lastAttemptHoursAgo: 0.3,
    runs: [{ hoursAgo: 0.3, state: "retryable", errorClass: "network" }, { hoursAgo: 5, state: "succeeded", accepted: 1 }],
  },
  {
    slot: 7, providerKey: "demo-legacy-drop", connectionLabel: "Legacy SFTP drop", credentialType: "service_account",
    scope: [{ label: "Legacy reports" }],
    status: "revoked", lastSuccessHoursAgo: 45 * 24, lastAttemptHoursAgo: 45 * 24, revokedDaysAgo: 40,
    runs: [{ hoursAgo: 45 * 24, state: "succeeded", accepted: 6 }],
  },
];

function connectionId(slot: number): string {
  return `00000000-0000-4000-8000-${String(slot).padStart(12, "d")}`;
}

/** Mirrors `connectionAttention` in lib/server/source-lifecycle.ts, which is the production source of these sentences. */
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
    entry.connection = { ...rest, status: outcome.status, consecutiveFailures: 0 };
    return { ...entry.connection };
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

let store: DemoSourceConnectionStore | undefined;
export function demoSourceConnectionStore(): DemoSourceConnectionStore {
  if (!store) store = new DemoSourceConnectionStore();
  return store;
}
