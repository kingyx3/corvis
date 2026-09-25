import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  FEATURE_FLAG_REGISTRY,
  PORTFOLIO_ATTRIBUTION_FLAG,
  evaluateFeatureFlag,
  setFeatureFlag,
  type FeatureFlagSnapshot,
} from "./feature-flags.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";

function identity(): RequestIdentity {
  return {
    subject: "oidc|admin-1",
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    roles: ["admin"],
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true, redistributionAllowed: true },
    authMethod: "oidc",
    sessionId: "session-1",
  };
}

function snapshot(enabled?: boolean): FeatureFlagSnapshot {
  return {
    tenantId: TENANT,
    emergencyStop: { engaged: false },
    flags: enabled === undefined ? {} : {
      [PORTFOLIO_ATTRIBUTION_FLAG]: { key: PORTFOLIO_ATTRIBUTION_FLAG, enabled, killSwitch: false, config: {} },
    },
    loadedAt: new Date().toISOString(),
  };
}

class CapabilityDb implements PostgresSqlApi {
  readonly calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("select owner, retire_by, retired_at")) return [];
    if (sql.includes("insert into corvis_control.feature_flag")) return [{ flag_key: PORTFOLIO_ATTRIBUTION_FLAG }];
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }
}

test("portfolio attribution is a durable capability exposed on UI and customer API channels", () => {
  const definition = FEATURE_FLAG_REGISTRY.find((flag) => flag.key === PORTFOLIO_ATTRIBUTION_FLAG);
  assert.equal(definition?.kind,"capability");
  assert.ok(definition?.channels.includes("customer_ui"));
  assert.ok(definition?.channels.includes("customer_api"));
  assert.equal(definition?.permission,"observations:read");
});

test("optional portfolio capability fails closed until explicitly enabled", () => {
  assert.equal(evaluateFeatureFlag(snapshot(),identity(),PORTFOLIO_ATTRIBUTION_FLAG,"customer_ui").reason,"not_configured");
  assert.equal(evaluateFeatureFlag(snapshot(false),identity(),PORTFOLIO_ATTRIBUTION_FLAG,"customer_api").reason,"disabled");
  assert.equal(evaluateFeatureFlag(snapshot(true),identity(),PORTFOLIO_ATTRIBUTION_FLAG,"customer_api").enabled,true);
});

test("persistent module capabilities can be configured without an artificial retirement date", async () => {
  const db = new CapabilityDb();
  await assert.doesNotReject(setFeatureFlag(identity(),{
    key: PORTFOLIO_ATTRIBUTION_FLAG,
    enabled: true,
    owner: "product-platform",
  },db));
  const insert = db.calls.find((call) => call.sql.includes("insert into corvis_control.feature_flag"));
  assert.ok(insert);
  assert.equal(insert?.parameters[5],null);
});
