import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { GovernedSemanticQueryService } from "./semantic-query.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };

const identity: RequestIdentity = {
  subject: "oidc|user-123",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["analyst"],
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-b", "fund-a"],
    documentIds: ["00000000-0000-0000-0000-000000000102", "00000000-0000-0000-0000-000000000101"],
    sourceDocumentAccessAllowed: false,
  },
  authMethod: "oidc",
  sessionId: "session-1",
};

class SemanticDb implements PostgresSqlApi {
  calls: Call[] = [];
  candidates: PostgresRow[] = [{
    metric_code: "revenue",
    display_name: "Revenue",
    data_type: "number",
    aggregation_behavior: "additive sum",
    numeric_available: true,
  }];
  resultRows: PostgresRow[] = [{
    observation_id: "00000000-0000-0000-0000-000000000001",
    fund_id: "fund-a",
    company_id: "company-a",
    holding_id: "holding-a",
    instrument_id: "instrument-a",
    subject_type: "instrument",
    metric_code: "revenue",
    value_number: 100,
    currency: "USD",
    economic_period: "Q2 2025",
    report_date: "2025-06-30",
    source_reference_id: "00000000-0000-0000-0000-000000000002",
    version: 1,
  }];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("bool_or(o.value_number is not null)")) return this.candidates;
    if (sql.includes("with scoped as")) return this.resultRows;
    return [];
  }

  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("metric questions execute a narrow governed query with deterministic period and entitlement filters", async () => {
  const db = new SemanticDb();
  const result = await new GovernedSemanticQueryService(db).execute(identity, "What was fund-a revenue in Q2 2025?");

  assert.equal(result.status, "executed");
  assert.equal(result.shape.metricCode, "revenue");
  assert.equal(result.shape.metricDataType, "number");
  assert.equal(result.shape.operation, "values");
  assert.deepEqual(result.shape.fundIds, ["fund-a"]);
  assert.deepEqual(result.shape.economicPeriodTokens, ["2025q2", "q22025"]);
  assert.deepEqual(result.shape.reportYears, []);
  assert.deepEqual(result.factIds, ["00000000-0000-0000-0000-000000000001"]);

  assert.equal(db.calls.length, 2);
  const candidateCall = db.calls[0];
  assert.match(candidateCall.sql, /bool_or\(o\.value_number is not null\) as numeric_available/i);
  assert.match(candidateCall.sql, /o\.tenant_id=\$1/i);
  assert.match(candidateCall.sql, /r\.document_id::text in/i);
  assert.equal(candidateCall.parameters[0], identity.tenantId);
  assert.equal(candidateCall.parameters[1], JSON.stringify(["fund-a"]));
  assert.equal(candidateCall.parameters[2], JSON.stringify([...identity.entitlements.documentIds!].sort()));

  const factCall = db.calls[1];
  assert.match(factCall.sql, /with scoped as/i);
  assert.match(factCall.sql, /coalesce\(o\.holding_id,''\)/i);
  assert.match(factCall.sql, /coalesce\(o\.instrument_id,''\)/i);
  assert.match(factCall.sql, /coalesce\(o\.economic_period,''\)/i);
  assert.match(factCall.sql, /end as subject_type/i);
  assert.match(factCall.sql, /o\.metric_code=\$4/i);
  assert.doesNotMatch(factCall.sql, /limit 750/i);
  assert.match(factCall.sql, /from scoped[\s\S]*limit \$7/i);
  assert.equal(factCall.parameters[3], "revenue");
  assert.equal(factCall.parameters[4], JSON.stringify(["2025q2", "q22025"]));
});

test("explicit sums aggregate the complete scoped set and never mix subject grains", async () => {
  const db = new SemanticDb();
  db.resultRows = [{
    fund_id: "fund-a",
    subject_type: "company",
    metric_code: "revenue",
    economic_period: "Q2 2025",
    currency: "USD",
    result_value: "250.0000000000",
    row_count: 2,
    source_observation_ids: [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000003",
    ],
  }];

  const result = await new GovernedSemanticQueryService(db).execute(identity, "What was total revenue in Q2 2025?");

  assert.equal(result.status, "executed");
  assert.equal(result.shape.operation, "sum");
  assert.equal(result.rows[0]?.subject_type, "company");
  assert.equal(result.rows[0]?.result_value, "250.0000000000");
  assert.deepEqual(result.factIds, [
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000003",
  ]);
  const aggregateSql = db.calls[1]?.sql ?? "";
  assert.match(aggregateSql, /sum\(value_number\) as result_value/i);
  assert.match(aggregateSql, /group by fund_id,subject_type,metric_code,economic_period,currency/i);
  assert.match(aggregateSql, /group by[\s\S]*limit \$7/i);
  const scopedCte = aggregateSql.slice(0, aggregateSql.indexOf(")\n      select fund_id"));
  assert.doesNotMatch(scopedCte, /limit \$7/i, "source rows must not be truncated before aggregation");
});

test("unsupported aggregation fails closed before reading fact values", async () => {
  const db = new SemanticDb();
  db.candidates = [{
    metric_code: "irr",
    display_name: "IRR",
    data_type: "percentage",
    aggregation_behavior: "non_additive",
    numeric_available: true,
  }];

  const result = await new GovernedSemanticQueryService(db).execute(identity, "What is total IRR?");

  assert.equal(result.status, "unsupported");
  assert.equal(result.shape.metricCode, "irr");
  assert.equal(result.shape.reason, "aggregation_not_allowed_by_metric_definition");
  assert.deepEqual(result.rows, []);
  assert.equal(db.calls.length, 1);
});

test("numeric operations fail closed when the authorized metric has no numeric values", async () => {
  const db = new SemanticDb();
  db.candidates = [{
    metric_code: "status",
    display_name: "Status",
    data_type: "text",
    aggregation_behavior: "non_additive",
    numeric_available: false,
  }];

  const result = await new GovernedSemanticQueryService(db).execute(identity, "What is maximum status?");

  assert.equal(result.status, "unsupported");
  assert.equal(result.shape.metricCode, "status");
  assert.deepEqual(result.rows, []);
  assert.equal(db.calls.length, 1);
});

test("ambiguous metric aliases fail closed instead of selecting an arbitrary metric", async () => {
  const db = new SemanticDb();
  db.candidates = [
    { metric_code: "fund_nav", display_name: "NAV", data_type: "number", aggregation_behavior: "non_additive", numeric_available: true },
    { metric_code: "company_nav", display_name: "NAV", data_type: "number", aggregation_behavior: "non_additive", numeric_available: true },
  ];

  const result = await new GovernedSemanticQueryService(db).execute(identity, "What was NAV?");

  assert.equal(result.status, "unresolved");
  assert.equal(result.shape.reason, "ambiguous_metric");
  assert.deepEqual(result.rows, []);
  assert.equal(db.calls.length, 1);
});
