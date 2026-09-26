import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { PostgresProductionPlatform } from "./platform.ts";

class RejectedObservationDb implements PostgresSqlApi {
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    void parameters;
    if (sql.includes("from corvis_serving.observations")) {
      return [{
        observation_id: "00000000-0000-0000-0000-000000000001",
        company_id: "company-a",
        metric_code: "revenue",
        value_number: 100,
        currency: "USD",
        economic_period: "Q2 2026",
        review_state: "rejected",
        source_reference_id: "00000000-0000-0000-0000-000000000002",
        version: 3,
      }];
    }
    return [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

const identity: RequestIdentity = {
  subject: "oidc|reviewer",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["reviewer"],
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-a"],
    documentIds: ["00000000-0000-0000-0000-000000000101"],
    sourceDocumentAccessAllowed: false,
  },
  authMethod: "oidc",
  sessionId: "session-1",
};

test("persisted rejected observations remain Rejected after a serving reload", async () => {
  const observations = await new PostgresProductionPlatform(new RejectedObservationDb()).listObservations(identity);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.state, "Rejected");
  assert.equal(observations[0]?.version, 3);
});

class DualControlObservationDb implements PostgresSqlApi {
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    void parameters;
    if (sql.includes("from corvis_serving.observations")) {
      return [{
        observation_id: "00000000-0000-0000-0000-000000000003",
        company_id: "company-b",
        metric_code: "ebitda",
        value_number: 42,
        currency: "USD",
        economic_period: "Q2 2026",
        review_state: "review_required",
        source_reference_id: "00000000-0000-0000-0000-000000000004",
        version: 2,
        risk_tier: "critical",
        approved_reviewer_count: 1,
      }];
    }
    return [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("a critical observation's first-approval count travels to the client so dual-control state (#182 D6) is visible, not just enforced server-side", async () => {
  const observations = await new PostgresProductionPlatform(new DualControlObservationDb()).listObservations(identity);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.state, "Needs review");
  assert.equal(observations[0]?.riskTier, "critical");
  assert.equal(observations[0]?.approvedReviewerCount, 1);
});
