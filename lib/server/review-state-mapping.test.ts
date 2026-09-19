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
