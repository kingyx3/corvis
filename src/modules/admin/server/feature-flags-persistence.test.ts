import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  FeatureFlagGovernanceError,
  PORTFOLIO_ATTRIBUTION_FLAG,
  listFeatureFlagGovernance,
  loadFeatureFlagSnapshot,
  setFeatureFlag,
  setFeatureFlagEmergencyStop,
  setFeatureFlagKillSwitch,
} from "./feature-flags.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";

function identity(): RequestIdentity {
  return {
    subject: "oidc|admin-1",
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    roles: ["admin"],
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true, redistributionAllowed: true, modelTrainingAllowed: true },
    authMethod: "oidc",
    sessionId: "session-1",
  };
}

type Call = { sql: string; parameters: PostgresPrimitive[] };

/**
 * Routes by SQL substring so one fake answers loadFeatureFlagSnapshot's two
 * parallel queries and setFeatureFlag's pre-read/upsert pair independently,
 * and records every call for parameter assertions.
 */
class RoutingFakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  flagRows: PostgresRow[] = [];
  stopRows: PostgresRow[] = [];
  existingRows: PostgresRow[] = [];
  writeRows: PostgresRow[] = [{ flag_key: "written" }];
  async query(sql: string, parameters: PostgresPrimitive[] = []) {
    this.calls.push({ sql, parameters });
    if (sql.includes("feature_flag_emergency_stop")) return this.stopRows;
    if (sql.startsWith("select owner")) return this.existingRows;
    if (sql.includes("from corvis_control.feature_flag where")) return this.flagRows;
    return this.writeRows;
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); }
  async health() { return true; }
}

const flagRow = (flag_key: string, extra: PostgresRow = {}): PostgresRow => ({ flag_key, enabled: true, kill_switch: false, ...extra });

test("loadFeatureFlagSnapshot normalises every configuration shape to an object", async () => {
  const db = new RoutingFakeDb();
  db.flagRows = [
    flagRow("ui.delivery_workspace", { configuration: null }),
    flagRow("ui.review_bulk_actions", { configuration: '{"rolloutPercent":10}' }),
    flagRow("admin.flag_self_service", { configuration: "[1,2]" }),
    flagRow("workers.parallel_extraction", { configuration: '"just a string"' }),
    flagRow("exports.parquet_delivery", { configuration: "{not valid json" }),
    flagRow("retrieval.hybrid_search", { configuration: { mode: "hybrid" } }),
    flagRow("retrieval.model_training_capture", { configuration: [1, 2] }),
    { flag_key: null, enabled: true },
    { flag_key: "", enabled: true },
  ];
  const snapshot = await loadFeatureFlagSnapshot(identity(), db);

  assert.equal(snapshot.tenantId, TENANT);
  assert.deepEqual(Object.keys(snapshot.flags).sort(), [
    "admin.flag_self_service",
    "exports.parquet_delivery",
    "retrieval.hybrid_search",
    "retrieval.model_training_capture",
    "ui.delivery_workspace",
    "ui.review_bulk_actions",
    "workers.parallel_extraction",
  ]);
  assert.deepEqual(snapshot.flags["ui.delivery_workspace"]?.config, {});
  assert.deepEqual(snapshot.flags["ui.review_bulk_actions"]?.config, { rolloutPercent: 10 });
  assert.deepEqual(snapshot.flags["admin.flag_self_service"]?.config, {});
  assert.deepEqual(snapshot.flags["workers.parallel_extraction"]?.config, {});
  assert.deepEqual(snapshot.flags["exports.parquet_delivery"]?.config, {});
  assert.deepEqual(snapshot.flags["retrieval.hybrid_search"]?.config, { mode: "hybrid" });
  assert.deepEqual(snapshot.flags["retrieval.model_training_capture"]?.config, {});
  assert.deepEqual(snapshot.emergencyStop, { engaged: false });
  assert.ok(Number.isFinite(Date.parse(snapshot.loadedAt)));
});

test("loadFeatureFlagSnapshot maps columns, serialising Date values as ISO strings", async () => {
  const createdAt = new Date("2026-03-01T00:00:00.000Z");
  const db = new RoutingFakeDb();
  db.flagRows = [flagRow("ui.delivery_workspace", {
    enabled: "t",
    kill_switch: "true",
    kill_switch_reason: "bug",
    owner: "team",
    created_at: createdAt,
    retire_by: "2027-01-01T00:00:00.000Z",
    retired_at: null,
    updated_at: 12345,
    updated_by: "oidc|someone",
  })];
  const record = (await loadFeatureFlagSnapshot(identity(), db)).flags["ui.delivery_workspace"];

  assert.equal(record?.enabled, true);
  assert.equal(record?.killSwitch, true);
  assert.equal(record?.killSwitchReason, "bug");
  assert.equal(record?.owner, "team");
  assert.equal(record?.createdAt, "2026-03-01T00:00:00.000Z");
  assert.equal(record?.retireBy, "2027-01-01T00:00:00.000Z");
  assert.equal(record?.retiredAt, undefined);
  assert.equal(record?.updatedAt, "12345");
  assert.equal(record?.updatedBy, "oidc|someone");
});

test("loadFeatureFlagSnapshot reads the tenant emergency stop row when present", async () => {
  const engagedAt = new Date("2026-04-01T10:00:00.000Z");
  const db = new RoutingFakeDb();
  db.stopRows = [{ engaged: true, reason: "incident-9", engaged_by: "oidc|admin-1", engaged_at: engagedAt }];
  const snapshot = await loadFeatureFlagSnapshot(identity(), db);
  assert.deepEqual(snapshot.emergencyStop, {
    engaged: true,
    reason: "incident-9",
    engagedBy: "oidc|admin-1",
    engagedAt: "2026-04-01T10:00:00.000Z",
  });
  assert.deepEqual(snapshot.flags, {});
});

test("listFeatureFlagGovernance reports stale and retired flag keys", async () => {
  const db = new RoutingFakeDb();
  db.stopRows = [{ engaged: false }];
  db.flagRows = [
    flagRow("ui.delivery_workspace", { retire_by: "2020-01-01T00:00:00.000Z", retired_at: null }),
    flagRow("ui.review_bulk_actions", { enabled: false, retire_by: "2020-01-01T00:00:00.000Z", retired_at: "2020-06-01T00:00:00.000Z" }),
    flagRow("admin.flag_self_service", { retire_by: "2999-01-01T00:00:00.000Z", retired_at: null }),
  ];
  const result = await listFeatureFlagGovernance(identity(), db);

  assert.deepEqual(result.emergencyStop, { engaged: false, reason: undefined, engagedBy: undefined, engagedAt: undefined });
  assert.deepEqual(result.stale, ["ui.delivery_workspace"]);
  assert.deepEqual(result.retired, ["ui.review_bulk_actions"]);
  assert.ok(result.flags.some((flag) => flag.key === "admin.flag_self_service" && !flag.stale && !flag.retired));
});

test("setFeatureFlag rejects an unparseable retire-by date", async () => {
  const db = new RoutingFakeDb();
  await assert.rejects(
    () => setFeatureFlag(identity(), { key: "ui.delivery_workspace", enabled: true, owner: "team", retireBy: "not-a-date" }, db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "invalid_retire_by",
  );
  assert.equal(db.calls.length, 1, "only the pre-read ran; nothing was written");
});

test("setFeatureFlag requires a retire-by date for a rollout flag even when an owner is supplied", async () => {
  const db = new RoutingFakeDb();
  await assert.rejects(
    () => setFeatureFlag(identity(), { key: "ui.delivery_workspace", enabled: true, owner: "team" }, db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "flag_retire_by_required",
  );
  assert.equal(db.calls.length, 1, "only the pre-read ran; nothing was written");
});

test("setFeatureFlag lets a capability flag be written without a retire-by date", async () => {
  const db = new RoutingFakeDb();
  await setFeatureFlag(identity(), { key: PORTFOLIO_ATTRIBUTION_FLAG, enabled: true, owner: "team" }, db);
  const write = db.calls.at(-1);
  assert.match(write?.sql ?? "", /insert into corvis_control\.feature_flag/);
  assert.equal(write?.parameters[1], PORTFOLIO_ATTRIBUTION_FLAG);
  assert.equal(write?.parameters[5], null);
  assert.equal(write?.parameters[3], "{}");
});

test("setFeatureFlag normalises retire-by to ISO and treats a null config as an explicit clear", async () => {
  const db = new RoutingFakeDb();
  db.existingRows = [{ owner: "team", retire_by: "2027-01-01T00:00:00.000Z", retired_at: null, configuration: { keep: true } }];
  await setFeatureFlag(identity(), { key: "ui.delivery_workspace", enabled: true, retireBy: "2028-02-03", config: null }, db);
  const write = db.calls.at(-1);
  assert.equal(write?.parameters[3], "{}");
  assert.equal(write?.parameters[4], "team");
  assert.equal(write?.parameters[5], "2028-02-03T00:00:00.000Z");
});

test("setFeatureFlagKillSwitch disengages with a null reason and fails when no flag row exists", async () => {
  const db = new RoutingFakeDb();
  await setFeatureFlagKillSwitch(identity(), "ui.delivery_workspace", false, "ignored once disengaged", db);
  assert.deepEqual(db.calls.at(-1)?.parameters, [TENANT, "ui.delivery_workspace", false, null, "oidc|admin-1"]);

  db.writeRows = [];
  await assert.rejects(
    () => setFeatureFlagKillSwitch(identity(), "ui.delivery_workspace", false, undefined, db),
    (error: unknown) => error instanceof FeatureFlagGovernanceError && error.code === "flag_not_configured",
  );
});

test("setFeatureFlagEmergencyStop releases with a null reason", async () => {
  const db = new RoutingFakeDb();
  await setFeatureFlagEmergencyStop(identity(), false, "stale reason", db);
  assert.deepEqual(db.calls.at(-1)?.parameters, [TENANT, false, null, "oidc|admin-1"]);

  await setFeatureFlagEmergencyStop(identity(), true, "  incident-5  ", db);
  assert.deepEqual(db.calls.at(-1)?.parameters, [TENANT, true, "incident-5", "oidc|admin-1"]);
});
