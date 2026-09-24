import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  FEATURE_FLAG_REGISTRY,
  FeatureFlagDeniedError,
  FeatureFlagGovernanceError,
  assertFeatureEnabled,
  enabledFeatureKeys,
  evaluateChannelFeatureFlags,
  evaluateFeatureFlag,
  governanceRows,
  retireFeatureFlag,
  setFeatureFlag,
  setFeatureFlagEmergencyStop,
  setFeatureFlagKillSwitch,
  type FeatureFlagSnapshot,
} from "./feature-flags.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { withTransaction, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "oidc|admin-1",
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    roles: ["admin"],
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true, redistributionAllowed: true, modelTrainingAllowed: true },
    authMethod: "oidc",
    sessionId: "session-1",
    ...overrides,
  };
}

function snapshot(overrides: Partial<FeatureFlagSnapshot> = {}): FeatureFlagSnapshot {
  return { tenantId: TENANT, emergencyStop: { engaged: false }, flags: {}, loadedAt: new Date().toISOString(), ...overrides };
}

class FakeDb implements PostgresSqlApi {
  readonly calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  readonly rows: PostgresRow[];
  constructor(rows: PostgresRow[] = []) { this.rows = rows; }
  async query(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); return this.rows; }
  async execute(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); }
  async health() { return true; }
}

test("every registered flag declares at least one channel", () => {
  for (const flag of FEATURE_FLAG_REGISTRY) assert.ok(flag.channels.length > 0, flag.key);
});

test("a flag from a different tenant's snapshot is always denied", () => {
  const decision = evaluateFeatureFlag(snapshot({ tenantId: "other-tenant" }), identity(), "ui.delivery_workspace", "customer_ui");
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, "tenant_mismatch");
});

test("an unregistered key is always denied, regardless of stored rollout state", () => {
  const withRow = snapshot({ flags: { "not.registered": { key: "not.registered", enabled: true, killSwitch: false, config: {} } } });
  assert.equal(evaluateFeatureFlag(withRow, identity(), "not.registered", "customer_ui").reason, "unregistered_flag");
});

test("a flag not declared for the requesting channel is denied even when enabled elsewhere", () => {
  const withRow = snapshot({ flags: { "ui.delivery_workspace": { key: "ui.delivery_workspace", enabled: true, killSwitch: false, config: {} } } });
  assert.equal(evaluateFeatureFlag(withRow, identity(), "ui.delivery_workspace", "worker").reason, "channel_not_declared");
});

test("a permission-gated flag is denied when the caller lacks the permission, even if enabled", () => {
  const withRow = snapshot({ flags: { "admin.flag_self_service": { key: "admin.flag_self_service", enabled: true, killSwitch: false, config: {} } } });
  const readOnly = identity({ roles: ["read_only"] });
  assert.equal(evaluateFeatureFlag(withRow, readOnly, "admin.flag_self_service", "admin_api").reason, "authorization_denied");
});

test("an entitlement-gated flag is denied when the caller's data rights do not carry the entitlement", () => {
  const withRow = snapshot({ flags: { "retrieval.model_training_capture": { key: "retrieval.model_training_capture", enabled: true, killSwitch: false, config: {} } } });
  const noTraining = identity({ entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true, modelTrainingAllowed: false } });
  assert.equal(evaluateFeatureFlag(withRow, noTraining, "retrieval.model_training_capture", "worker").reason, "entitlement_denied");
});

test("a rollout flag can never widen authority: authorization is checked before rollout state is consulted", () => {
  // Rollout state says "enabled", but the caller has no permission for it —
  // enabling the flag must never substitute for a missing grant.
  const enabledRow = snapshot({ flags: { "ui.review_bulk_actions": { key: "ui.review_bulk_actions", enabled: true, killSwitch: false, config: {} } } });
  const noReview = identity({ roles: ["read_only"] });
  const decision = evaluateFeatureFlag(enabledRow, noReview, "ui.review_bulk_actions", "customer_ui");
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, "authorization_denied");
});

test("a tenant-wide emergency stop denies every flag on every channel regardless of individual rollout state", () => {
  const stopped = snapshot({
    emergencyStop: { engaged: true, reason: "incident-123" },
    flags: { "ui.delivery_workspace": { key: "ui.delivery_workspace", enabled: true, killSwitch: false, config: {} } },
  });
  assert.equal(evaluateFeatureFlag(stopped, identity(), "ui.delivery_workspace", "customer_ui").reason, "emergency_stop");
});

test("a per-flag kill switch denies that flag even while it is otherwise enabled", () => {
  const killed = snapshot({ flags: { "ui.delivery_workspace": { key: "ui.delivery_workspace", enabled: true, killSwitch: true, killSwitchReason: "bug", config: {} } } });
  assert.equal(evaluateFeatureFlag(killed, identity(), "ui.delivery_workspace", "customer_ui").reason, "kill_switch");
});

test("a retired flag is denied even if the stored row still says enabled", () => {
  const retired = snapshot({ flags: { "ui.delivery_workspace": { key: "ui.delivery_workspace", enabled: true, killSwitch: false, config: {}, retiredAt: "2026-01-01T00:00:00.000Z" } } });
  assert.equal(evaluateFeatureFlag(retired, identity(), "ui.delivery_workspace", "customer_ui").reason, "retired");
});

test("an unconfigured registered flag is denied rather than defaulting open", () => {
  assert.equal(evaluateFeatureFlag(snapshot(), identity(), "ui.delivery_workspace", "customer_ui").reason, "not_configured");
});

test("a passing flag with no gate and no blocker is enabled and carries its config", () => {
  const config = { rolloutPercent: 100 };
  const on = snapshot({ flags: { "ui.delivery_workspace": { key: "ui.delivery_workspace", enabled: true, killSwitch: false, config } } });
  const decision = evaluateFeatureFlag(on, identity(), "ui.delivery_workspace", "customer_ui");
  assert.equal(decision.enabled, true);
  assert.deepEqual(decision.config, config);
});

// Dispatches on the SQL text so a single fake can answer both of
// loadFeatureFlagSnapshot's parallel queries (feature_flag rows and the
// tenant's emergency-stop row) with independently-configured results,
// unlike the single-fixed-rows FakeDb above.
class SnapshotFakeDb implements PostgresSqlApi {
  readonly flagRows: PostgresRow[];
  readonly stopRows: PostgresRow[];
  constructor(flagRows: PostgresRow[] = [], stopRows: PostgresRow[] = []) {
    this.flagRows = flagRows;
    this.stopRows = stopRows;
  }
  async query(sql: string) {
    return sql.includes("feature_flag_emergency_stop") ? this.stopRows : this.flagRows;
  }
  async execute() {}
  async health() { return true; }
}

test("assertFeatureEnabled resolves when the real, wired call site's flag evaluates enabled", async () => {
  const db = new SnapshotFakeDb([
    { flag_key: "exports.parquet_delivery", enabled: true, kill_switch: false, configuration: {} },
  ]);
  const caller = identity({ entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true, redistributionAllowed: true } });
  await assert.doesNotReject(assertFeatureEnabled(caller, "exports.parquet_delivery", "export", db));
});

test("assertFeatureEnabled throws FeatureFlagDeniedError carrying the real evaluation reason when denied", async () => {
  // Registered, entitlement-satisfied, but never configured for this tenant
  // (the exact "an emergency kill switch never reaches real code" gap this
  // wiring closes: the flag defaults closed, not open, when unconfigured).
  const db = new SnapshotFakeDb([]);
  const caller = identity({ entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true, redistributionAllowed: true } });
  await assert.rejects(
    assertFeatureEnabled(caller, "exports.parquet_delivery", "export", db),
    (error: unknown) =>
      error instanceof FeatureFlagDeniedError &&
      error.key === "exports.parquet_delivery" &&
      error.channel === "export" &&
      error.decisionReason === "not_configured",
  );
});

test("assertFeatureEnabled's kill switch denies even a caller who is otherwise fully entitled", async () => {
  const db = new SnapshotFakeDb([
    { flag_key: "exports.parquet_delivery", enabled: true, kill_switch: true, kill_switch_reason: "incident-42", configuration: {} },
  ]);
  const caller = identity({ entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true, redistributionAllowed: true } });
  await assert.rejects(
    assertFeatureEnabled(caller, "exports.parquet_delivery", "export", db),
    (error: unknown) => error instanceof FeatureFlagDeniedError && error.decisionReason === "kill_switch",
  );
});

test("evaluateChannelFeatureFlags and enabledFeatureKeys aggregate a whole channel deterministically", () => {
  const on = snapshot({ flags: { "ui.delivery_workspace": { key: "ui.delivery_workspace", enabled: true, killSwitch: false, config: {} } } });
  const decisions = evaluateChannelFeatureFlags(on, identity(), "customer_ui");
  assert.ok(decisions.length > 1);
  assert.deepEqual(enabledFeatureKeys(decisions), ["ui.delivery_workspace"]);
});

test("governanceRows flags a stale flag past its retire-by date and a retired flag independently", () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const rows = governanceRows(snapshot({
    flags: {
      "ui.delivery_workspace": { key: "ui.delivery_workspace", enabled: true, killSwitch: false, config: {}, retireBy: "2026-01-01T00:00:00.000Z" },
      "ui.review_bulk_actions": { key: "ui.review_bulk_actions", enabled: false, killSwitch: false, config: {}, retiredAt: "2026-02-01T00:00:00.000Z" },
      "admin.flag_self_service": { key: "admin.flag_self_service", enabled: true, killSwitch: false, config: {}, retireBy: "2027-01-01T00:00:00.000Z" },
    },
  }), now);

  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.equal(byKey.get("ui.delivery_workspace")?.stale, true);
  assert.equal(byKey.get("ui.review_bulk_actions")?.retired, true);
  assert.equal(byKey.get("ui.review_bulk_actions")?.stale, false, "a retired flag is not separately reported as stale");
  assert.equal(byKey.get("admin.flag_self_service")?.stale, false);
});

test("governanceRows surfaces an unrecognized stored flag as a stale ungoverned row", () => {
  const rows = governanceRows(snapshot({ flags: { "legacy.unregistered": { key: "legacy.unregistered", enabled: true, killSwitch: false, config: {} } } }));
  const row = rows.find((entry) => entry.key === "legacy.unregistered");
  assert.equal(row?.registered, false);
  assert.equal(row?.stale, true);
});

test("setFeatureFlag rejects an unregistered key without ever reaching the database", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => setFeatureFlag(identity(), { key: "not.a.real.flag", enabled: true, owner: "team", retireBy: "2027-01-01T00:00:00.000Z" }, db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "unregistered_flag",
  );
  assert.equal(db.calls.length, 0);
});

test("setFeatureFlag requires ownership and a retirement date for a new flag", async () => {
  const db = new FakeDb([]);
  await assert.rejects(
    () => setFeatureFlag(identity(), { key: "ui.delivery_workspace", enabled: true }, db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "flag_owner_required",
  );
});

test("setFeatureFlag rejects a write to an already-retired flag", async () => {
  const db = new FakeDb([{ owner: "team", retire_by: "2027-01-01T00:00:00.000Z", retired_at: "2026-01-01T00:00:00.000Z" }]);
  await assert.rejects(
    () => setFeatureFlag(identity(), { key: "ui.delivery_workspace", enabled: true, owner: "team", retireBy: "2027-01-01T00:00:00.000Z" }, db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "flag_retired",
  );
});

test("a kill switch requires a reason when engaging and fails closed for an unregistered flag", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => setFeatureFlagKillSwitch(identity(), "not.a.real.flag", true, "bug", db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "unregistered_flag",
  );
  const registeredDb = new FakeDb([]);
  await assert.rejects(
    () => setFeatureFlagKillSwitch(identity(), "ui.delivery_workspace", true, undefined, registeredDb),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "kill_switch_reason_required",
  );
});

test("engaging a kill switch on a never-configured flag fails rather than silently succeeding", async () => {
  const db = new FakeDb([]);
  await assert.rejects(
    () => setFeatureFlagKillSwitch(identity(), "ui.delivery_workspace", true, "bug", db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "flag_not_configured",
  );
});

test("retiring a never-configured flag fails rather than silently succeeding", async () => {
  const db = new FakeDb([]);
  await assert.rejects(
    () => retireFeatureFlag(identity(), "ui.delivery_workspace", db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "flag_not_configured",
  );
});

test("engaging the tenant emergency stop requires a reason", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => setFeatureFlagEmergencyStop(identity(), true, undefined, db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "emergency_stop_reason_required",
  );
  await setFeatureFlagEmergencyStop(identity(), true, "incident-123", db);
  assert.equal(db.calls.length, 1);
});

test("non-string governance fields are rejected as 422 governance errors, not TypeErrors", async () => {
  const key = "ui.delivery_workspace";
  await assert.rejects(
    () => setFeatureFlag(identity(), { key, enabled: true, owner: 42 as unknown as string, retireBy: "2027-01-01T00:00:00.000Z" }, new FakeDb([])),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "invalid_owner",
  );
  await assert.rejects(
    () => setFeatureFlag(identity(), { key, enabled: true, owner: "team", retireBy: { at: "tomorrow" } as unknown as string }, new FakeDb([])),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "invalid_retire_by",
  );
  await assert.rejects(
    () => setFeatureFlagKillSwitch(identity(), key, true, ["bug"] as unknown as string, new FakeDb([])),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "invalid_reason",
  );
  await assert.rejects(
    () => setFeatureFlagEmergencyStop(identity(), true, 7 as unknown as string, new FakeDb()),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "invalid_reason",
  );
});

test("setFeatureFlag reports a flag retired concurrently instead of claiming the write applied", async () => {
  // The pre-read sees a live flag; the guarded upsert then affects no row because it was retired in between.
  const db = new FakeDb([]);
  db.query = async (sql: string, parameters: PostgresPrimitive[] = []) => {
    db.calls.push({ sql, parameters });
    return sql.startsWith("select owner") ? [{ owner: "team", retire_by: "2027-01-01T00:00:00.000Z", retired_at: null }] : [];
  };
  await assert.rejects(
    () => setFeatureFlag(identity(), { key: "ui.delivery_workspace", enabled: true }, db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "flag_retired",
  );
  assert.match(db.calls.at(-1)?.sql ?? "", /returning flag_key/);
});

/**
 * A stateful fake with real (in-memory) transaction semantics: `transaction()`
 * snapshots the flag table, the emergency stop row and the audit log before
 * running the callback, and restores that snapshot if the callback throws —
 * mirroring what NativePostgresSqlApi.transaction does with begin/rollback.
 * Used to prove the admin feature-flag routes' mutation + audit writes are
 * wrapped in one transaction (see app/api/v1/admin/feature-flags/**).
 */
class TransactionalFakeDb implements PostgresSqlApi {
  flags = new Map<string, PostgresRow>();
  emergencyStop: PostgresRow | undefined;
  auditRows: PostgresRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.startsWith("select owner, retire_by, retired_at")) {
      const row = this.flags.get(String(parameters[1]));
      return row ? [row] : [];
    }
    if (sql.startsWith("insert into corvis_control.feature_flag")) {
      const [, key, enabled, config, owner, retireBy] = parameters;
      const existing = this.flags.get(String(key));
      if (existing?.retired_at) return [];
      const row: PostgresRow = { flag_key: key, enabled, configuration: config, owner, retire_by: retireBy, retired_at: null };
      this.flags.set(String(key), row);
      return [{ flag_key: key }];
    }
    if (sql.startsWith("update corvis_control.feature_flag set\n      kill_switch")) {
      const [, key, engaged] = parameters;
      const row = this.flags.get(String(key));
      if (!row) return [];
      this.flags.set(String(key), { ...row, kill_switch: engaged });
      return [{ flag_key: key }];
    }
    if (sql.startsWith("update corvis_control.feature_flag set\n      enabled=false")) {
      const [, key] = parameters;
      const row = this.flags.get(String(key));
      if (!row || row.retired_at) return [];
      this.flags.set(String(key), { ...row, enabled: false, retired_at: new Date().toISOString() });
      return [{ flag_key: key }];
    }
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("insert into corvis_control.audit_event")) {
      this.auditRows.push({ action: parameters[5] });
      return;
    }
    if (sql.includes("insert into corvis_control.feature_flag_emergency_stop")) {
      this.emergencyStop = { engaged: parameters[1], reason: parameters[2] };
    }
  }

  async health(): Promise<boolean> { return true; }

  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    const flagsSnapshot = new Map(this.flags);
    const stopSnapshot = this.emergencyStop;
    const auditSnapshot = [...this.auditRows];
    try {
      return await fn(this);
    } catch (error) {
      this.flags = flagsSnapshot;
      this.emergencyStop = stopSnapshot;
      this.auditRows = auditSnapshot;
      throw error;
    }
  }
}

function auditEvent(action: string, targetId: string) {
  return {
    id: "event-1", occurredAt: new Date().toISOString(), tenantId: TENANT, workspaceId: WORKSPACE,
    actorSubject: "oidc|admin-1", sessionId: "session-1", action, targetType: "feature_flag", targetId, outcome: "success" as const, correlationId: "corr-1",
  };
}

test("setFeatureFlag and its audit event commit together, and roll back together when the audit insert fails", async () => {
  const db = new TransactionalFakeDb();
  await withTransaction(db, async (tx) => {
    await setFeatureFlag(identity(), { key: "ui.delivery_workspace", enabled: true, owner: "team", retireBy: "2030-01-01T00:00:00.000Z" }, tx);
    await new PostgresOperationsRepository(tx).audit(auditEvent("feature_flag.update", "ui.delivery_workspace"));
  });
  assert.ok(db.flags.has("ui.delivery_workspace"));
  assert.equal(db.auditRows.length, 1);

  const failing = new TransactionalFakeDb();
  failing.execute = async (sql: string, parameters: PostgresPrimitive[] = []) => {
    if (sql.includes("insert into corvis_control.audit_event")) throw new Error("audit insert failed");
    return TransactionalFakeDb.prototype.execute.call(failing, sql, parameters);
  };
  await assert.rejects(
    withTransaction(failing, async (tx) => {
      await setFeatureFlag(identity(), { key: "ui.delivery_workspace", enabled: true, owner: "team", retireBy: "2030-01-01T00:00:00.000Z" }, tx);
      await new PostgresOperationsRepository(tx).audit(auditEvent("feature_flag.update", "ui.delivery_workspace"));
    }),
    /audit insert failed/,
  );
  // The flag write must not be visible: it was rolled back with the failed audit insert.
  assert.equal(failing.flags.has("ui.delivery_workspace"), false);
});

test("engaging a kill switch rolls back when its audit event fails to write", async () => {
  const db = new TransactionalFakeDb();
  db.flags.set("ui.delivery_workspace", { flag_key: "ui.delivery_workspace", enabled: true, kill_switch: false, retired_at: null });
  const originalExecute = db.execute.bind(db);
  db.execute = async (sql: string, parameters: PostgresPrimitive[] = []) => {
    if (sql.includes("insert into corvis_control.audit_event")) throw new Error("audit insert failed");
    return originalExecute(sql, parameters);
  };
  await assert.rejects(
    withTransaction(db, async (tx) => {
      await setFeatureFlagKillSwitch(identity(), "ui.delivery_workspace", true, "incident", tx);
      await new PostgresOperationsRepository(tx).audit(auditEvent("feature_flag.kill_switch", "ui.delivery_workspace"));
    }),
    /audit insert failed/,
  );
  assert.equal(db.flags.get("ui.delivery_workspace")?.kill_switch, false);
});

test("retiring a flag rolls back when its audit event fails to write", async () => {
  const db = new TransactionalFakeDb();
  db.flags.set("ui.delivery_workspace", { flag_key: "ui.delivery_workspace", enabled: true, retired_at: null });
  const originalExecute = db.execute.bind(db);
  db.execute = async (sql: string, parameters: PostgresPrimitive[] = []) => {
    if (sql.includes("insert into corvis_control.audit_event")) throw new Error("audit insert failed");
    return originalExecute(sql, parameters);
  };
  await assert.rejects(
    withTransaction(db, async (tx) => {
      await retireFeatureFlag(identity(), "ui.delivery_workspace", tx);
      await new PostgresOperationsRepository(tx).audit(auditEvent("feature_flag.retire", "ui.delivery_workspace"));
    }),
    /audit insert failed/,
  );
  assert.equal(db.flags.get("ui.delivery_workspace")?.retired_at, null);
});

test("engaging the tenant emergency stop rolls back when its audit event fails to write", async () => {
  const db = new TransactionalFakeDb();
  await assert.rejects(
    withTransaction(db, async (tx) => {
      await setFeatureFlagEmergencyStop(identity(), true, "incident", tx);
      throw new Error("audit insert failed");
    }),
    /audit insert failed/,
  );
  assert.equal(db.emergencyStop, undefined);
});
