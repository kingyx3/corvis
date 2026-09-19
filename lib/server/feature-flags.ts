import type { Entitlements, Permission, RequestIdentity } from "../../core/enterprise.ts";
import { hasPermission } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

/**
 * Authoritative server-side feature-flag evaluation.
 *
 * Flags are rollout and operational controls only. Evaluation intersects the
 * stored rollout state with the caller's already-resolved RBAC, entitlements
 * and data rights, so an enabled flag can never widen authority: the guard is
 * applied before the rollout state is consulted and an unsatisfied guard is a
 * denial regardless of how the flag is configured. Every channel (customer UI,
 * admin API, workers, exports, AI/retrieval) resolves through this module so a
 * kill switch lands identically everywhere.
 */

export type FeatureFlagChannel = "customer_ui" | "admin_api" | "worker" | "export" | "ai_retrieval";

export const FEATURE_FLAG_CHANNELS: readonly FeatureFlagChannel[] = [
  "customer_ui", "admin_api", "worker", "export", "ai_retrieval",
];

type EntitlementGate = keyof Pick<Entitlements,
  "sourceDocumentAccessAllowed" | "internalAnalyticsAllowed" | "modelTrainingAllowed" | "redistributionAllowed">;

export type FeatureFlagDefinition = {
  key: string;
  description: string;
  channels: readonly FeatureFlagChannel[];
  permission?: Permission;
  entitlement?: EntitlementGate;
};

/**
 * Registered flags. An unregistered key is always denied so a flag row written
 * straight into the control plane cannot create an ungoverned code path.
 */
export const FEATURE_FLAG_REGISTRY: readonly FeatureFlagDefinition[] = [
  { key: "ui.delivery_workspace", description: "Data delivery workspace surfaces in the customer UI.", channels: ["customer_ui"] },
  { key: "ui.review_bulk_actions", description: "Bulk approve/reject controls in data review.", channels: ["customer_ui", "admin_api"], permission: "observations:review" },
  { key: "admin.flag_self_service", description: "Tenant admins manage their own flags.", channels: ["admin_api"], permission: "admin:manage" },
  { key: "workers.parallel_extraction", description: "Parallel extraction fan-out in processing workers.", channels: ["worker", "admin_api"] },
  { key: "exports.parquet_delivery", description: "Parquet export delivery channel.", channels: ["export", "customer_ui", "admin_api"], permission: "exports:create", entitlement: "redistributionAllowed" },
  { key: "retrieval.hybrid_search", description: "Hybrid lexical/vector retrieval for Ask Corvis.", channels: ["ai_retrieval", "customer_ui", "admin_api"], permission: "research:query", entitlement: "sourceDocumentAccessAllowed" },
  { key: "retrieval.model_training_capture", description: "Capture retrieval traces for model training.", channels: ["ai_retrieval", "worker"], permission: "research:query", entitlement: "modelTrainingAllowed" },
];

const REGISTRY_BY_KEY = new Map(FEATURE_FLAG_REGISTRY.map((definition) => [definition.key, definition]));

export function featureFlagDefinition(key: string): FeatureFlagDefinition | undefined {
  return REGISTRY_BY_KEY.get(key);
}

export type FeatureFlagRecord = {
  key: string;
  enabled: boolean;
  killSwitch: boolean;
  killSwitchReason?: string;
  config: Record<string, unknown>;
  owner?: string;
  createdAt?: string;
  retireBy?: string;
  retiredAt?: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type EmergencyStop = { engaged: boolean; reason?: string; engagedBy?: string; engagedAt?: string };

export type FeatureFlagSnapshot = {
  tenantId: string;
  emergencyStop: EmergencyStop;
  flags: Record<string, FeatureFlagRecord>;
  loadedAt: string;
};

export type FeatureFlagDecisionReason =
  | "enabled"
  | "tenant_mismatch"
  | "unregistered_flag"
  | "channel_not_declared"
  | "authorization_denied"
  | "entitlement_denied"
  | "emergency_stop"
  | "kill_switch"
  | "retired"
  | "not_configured"
  | "disabled";

export type FeatureFlagDecision = {
  key: string;
  channel: FeatureFlagChannel;
  enabled: boolean;
  reason: FeatureFlagDecisionReason;
  config: Record<string, unknown>;
};

export class FeatureFlagGovernanceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "FeatureFlagGovernanceError";
    this.code = code;
  }
}

function deny(key: string, channel: FeatureFlagChannel, reason: FeatureFlagDecisionReason): FeatureFlagDecision {
  return { key, channel, enabled: false, reason, config: {} };
}

/**
 * Pure evaluation. Authorization is checked before rollout state so no flag
 * configuration can produce `enabled: true` for a caller that RBAC,
 * entitlements or data rights already deny.
 */
export function evaluateFeatureFlag(
  snapshot: FeatureFlagSnapshot,
  identity: RequestIdentity,
  key: string,
  channel: FeatureFlagChannel,
): FeatureFlagDecision {
  if (snapshot.tenantId !== identity.tenantId) return deny(key, channel, "tenant_mismatch");

  const definition = REGISTRY_BY_KEY.get(key);
  if (!definition) return deny(key, channel, "unregistered_flag");
  if (!definition.channels.includes(channel)) return deny(key, channel, "channel_not_declared");
  if (definition.permission && !hasPermission(identity, definition.permission)) return deny(key, channel, "authorization_denied");
  if (definition.entitlement && identity.entitlements[definition.entitlement] !== true) return deny(key, channel, "entitlement_denied");

  if (snapshot.emergencyStop.engaged) return deny(key, channel, "emergency_stop");

  const record = snapshot.flags[key];
  if (!record) return deny(key, channel, "not_configured");
  if (record.retiredAt) return deny(key, channel, "retired");
  if (record.killSwitch) return deny(key, channel, "kill_switch");
  if (!record.enabled) return deny(key, channel, "disabled");

  return { key, channel, enabled: true, reason: "enabled", config: record.config };
}

export function evaluateChannelFeatureFlags(
  snapshot: FeatureFlagSnapshot,
  identity: RequestIdentity,
  channel: FeatureFlagChannel,
): FeatureFlagDecision[] {
  return FEATURE_FLAG_REGISTRY
    .filter((definition) => definition.channels.includes(channel))
    .map((definition) => evaluateFeatureFlag(snapshot, identity, definition.key, channel));
}

export function enabledFeatureKeys(decisions: readonly FeatureFlagDecision[]): string[] {
  return decisions.filter((decision) => decision.enabled).map((decision) => decision.key).sort();
}

export type FeatureFlagGovernanceRow = FeatureFlagRecord & {
  registered: boolean;
  description?: string;
  stale: boolean;
  retired: boolean;
  channels: readonly FeatureFlagChannel[];
};

export function governanceRows(snapshot: FeatureFlagSnapshot, now: Date = new Date()): FeatureFlagGovernanceRow[] {
  const keys = new Set([...Object.keys(snapshot.flags), ...REGISTRY_BY_KEY.keys()]);
  return [...keys].sort().map((key) => {
    const definition = REGISTRY_BY_KEY.get(key);
    const record = snapshot.flags[key] ?? { key, enabled: false, killSwitch: false, config: {} };
    const retired = Boolean(record.retiredAt);
    const overdue = !retired && record.retireBy != null && Date.parse(record.retireBy) <= now.getTime();
    return {
      ...record,
      key,
      registered: definition != null,
      description: definition?.description,
      channels: definition?.channels ?? [],
      retired,
      stale: overdue || (!retired && definition == null && snapshot.flags[key] != null),
    };
  });
}

function text(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function bool(row: PostgresRow, key: string): boolean {
  const value = row[key];
  return value === true || value === "true" || value === 1 || value === "t";
}

function config(row: PostgresRow, key: string): Record<string, unknown> {
  const value = row[key];
  if (value == null) return {};
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

/**
 * Loads the tenant's authoritative flag state. Snapshots are never cached
 * across loads, so a kill switch or emergency stop applies to the very next
 * evaluation on every channel.
 */
export async function loadFeatureFlagSnapshot(
  identity: RequestIdentity,
  db: PostgresSqlApi = controlDb(),
): Promise<FeatureFlagSnapshot> {
  const [flagRows, stopRows] = await Promise.all([
    db.query(`select flag_key, enabled, kill_switch, kill_switch_reason, configuration, owner,
        created_at, retire_by, retired_at, updated_at, updated_by
      from corvis_control.feature_flag where tenant_id=$1 order by flag_key`, [identity.tenantId]),
    db.query(`select engaged, reason, engaged_by, engaged_at
      from corvis_control.feature_flag_emergency_stop where tenant_id=$1 limit 1`, [identity.tenantId]),
  ]);

  const flags: Record<string, FeatureFlagRecord> = {};
  for (const row of flagRows) {
    const key = text(row, "flag_key");
    if (!key) continue;
    flags[key] = {
      key,
      enabled: bool(row, "enabled"),
      killSwitch: bool(row, "kill_switch"),
      killSwitchReason: text(row, "kill_switch_reason"),
      config: config(row, "configuration"),
      owner: text(row, "owner"),
      createdAt: text(row, "created_at"),
      retireBy: text(row, "retire_by"),
      retiredAt: text(row, "retired_at"),
      updatedAt: text(row, "updated_at"),
      updatedBy: text(row, "updated_by"),
    };
  }

  const stop = stopRows[0];
  return {
    tenantId: identity.tenantId,
    emergencyStop: stop
      ? { engaged: bool(stop, "engaged"), reason: text(stop, "reason"), engagedBy: text(stop, "engaged_by"), engagedAt: text(stop, "engaged_at") }
      : { engaged: false },
    flags,
    loadedAt: new Date().toISOString(),
  };
}

export async function isFeatureEnabled(
  identity: RequestIdentity,
  key: string,
  channel: FeatureFlagChannel,
  db: PostgresSqlApi = controlDb(),
): Promise<boolean> {
  return evaluateFeatureFlag(await loadFeatureFlagSnapshot(identity, db), identity, key, channel).enabled;
}

export async function resolveChannelFeatureFlags(
  identity: RequestIdentity,
  channel: FeatureFlagChannel,
  db: PostgresSqlApi = controlDb(),
): Promise<FeatureFlagDecision[]> {
  return evaluateChannelFeatureFlags(await loadFeatureFlagSnapshot(identity, db), identity, channel);
}

export async function listFeatureFlagGovernance(
  identity: RequestIdentity,
  db: PostgresSqlApi = controlDb(),
): Promise<{ emergencyStop: EmergencyStop; flags: FeatureFlagGovernanceRow[]; stale: string[]; retired: string[] }> {
  const snapshot = await loadFeatureFlagSnapshot(identity, db);
  const flags = governanceRows(snapshot);
  return {
    emergencyStop: snapshot.emergencyStop,
    flags,
    stale: flags.filter((flag) => flag.stale).map((flag) => flag.key),
    retired: flags.filter((flag) => flag.retired).map((flag) => flag.key),
  };
}

export type FeatureFlagWrite = {
  key: string;
  enabled: boolean;
  config?: unknown;
  owner?: string;
  retireBy?: string;
};

function isoOrThrow(value: string, code: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new FeatureFlagGovernanceError(code);
  return new Date(parsed).toISOString();
}

/**
 * Upserts rollout state. Ownership and a retire-by date are mandatory
 * governance metadata: a flag with no owner or no retirement date cannot be
 * created, which is what keeps the stale-flag report meaningful.
 */
export async function setFeatureFlag(
  identity: RequestIdentity,
  write: FeatureFlagWrite,
  db: PostgresSqlApi = controlDb(),
): Promise<void> {
  if (!REGISTRY_BY_KEY.has(write.key)) throw new FeatureFlagGovernanceError("unregistered_flag");
  const existing = await db.query(`select owner, retire_by, retired_at from corvis_control.feature_flag
    where tenant_id=$1 and flag_key=$2 limit 1`, [identity.tenantId, write.key]);
  const current = existing[0];
  if (current && text(current, "retired_at")) throw new FeatureFlagGovernanceError("flag_retired");

  const owner = write.owner?.trim() || (current ? text(current, "owner") : undefined);
  const retireByRaw = write.retireBy?.trim() || (current ? text(current, "retire_by") : undefined);
  if (!owner) throw new FeatureFlagGovernanceError("flag_owner_required");
  if (!retireByRaw) throw new FeatureFlagGovernanceError("flag_retire_by_required");
  const retireBy = isoOrThrow(retireByRaw, "invalid_retire_by");

  await db.execute(`insert into corvis_control.feature_flag
      (tenant_id, flag_key, enabled, configuration, owner, retire_by, updated_at, updated_by)
    values ($1,$2,$3,$4::jsonb,$5,$6::timestamptz,now(),$7)
    on conflict (tenant_id, flag_key) do update set
      enabled=excluded.enabled,
      configuration=excluded.configuration,
      owner=excluded.owner,
      retire_by=excluded.retire_by,
      updated_at=excluded.updated_at,
      updated_by=excluded.updated_by
    where corvis_control.feature_flag.retired_at is null`,
  [identity.tenantId, write.key, write.enabled, JSON.stringify(write.config ?? {}), owner, retireBy, identity.subject]);
}

export async function setFeatureFlagKillSwitch(
  identity: RequestIdentity,
  key: string,
  engaged: boolean,
  reason: string | undefined,
  db: PostgresSqlApi = controlDb(),
): Promise<void> {
  if (!REGISTRY_BY_KEY.has(key)) throw new FeatureFlagGovernanceError("unregistered_flag");
  const trimmed = reason?.trim() ?? "";
  if (engaged && !trimmed) throw new FeatureFlagGovernanceError("kill_switch_reason_required");
  const updated = await db.query(`update corvis_control.feature_flag set
      kill_switch=$3,
      kill_switch_reason=$4,
      kill_switch_at=case when $3 then now() else null end,
      kill_switch_by=case when $3 then $5 else null end,
      updated_at=now(),
      updated_by=$5
    where tenant_id=$1 and flag_key=$2
    returning flag_key`, [identity.tenantId, key, engaged, engaged ? trimmed : null, identity.subject]);
  if (updated.length === 0) throw new FeatureFlagGovernanceError("flag_not_configured");
}

export async function retireFeatureFlag(
  identity: RequestIdentity,
  key: string,
  db: PostgresSqlApi = controlDb(),
): Promise<void> {
  const updated = await db.query(`update corvis_control.feature_flag set
      enabled=false, retired_at=now(), retired_by=$3, updated_at=now(), updated_by=$3
    where tenant_id=$1 and flag_key=$2 and retired_at is null
    returning flag_key`, [identity.tenantId, key, identity.subject]);
  if (updated.length === 0) throw new FeatureFlagGovernanceError("flag_not_configured");
}

export async function setFeatureFlagEmergencyStop(
  identity: RequestIdentity,
  engaged: boolean,
  reason: string | undefined,
  db: PostgresSqlApi = controlDb(),
): Promise<void> {
  const trimmed = reason?.trim() ?? "";
  if (engaged && !trimmed) throw new FeatureFlagGovernanceError("emergency_stop_reason_required");
  await db.execute(`insert into corvis_control.feature_flag_emergency_stop
      (tenant_id, engaged, reason, engaged_by, engaged_at, released_by, released_at, updated_at)
    values ($1,$2,$3,case when $2 then $4 else null end,case when $2 then now() else null end,
      case when $2 then null else $4 end,case when $2 then null else now() end,now())
    on conflict (tenant_id) do update set
      engaged=excluded.engaged,
      reason=excluded.reason,
      engaged_by=excluded.engaged_by,
      engaged_at=excluded.engaged_at,
      released_by=excluded.released_by,
      released_at=excluded.released_at,
      updated_at=excluded.updated_at`,
  [identity.tenantId, engaged, engaged ? trimmed : null, identity.subject]);
}
