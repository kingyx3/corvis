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
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

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
