import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { PostgresHoldingInstrumentServingRepository } from "./holding-instrument-serving.ts";
import { keysetPage, paginate, type KeysetPage, type Page } from "./pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { PostgresPublicServingResourceRepository } from "./public-serving-resources.ts";
import { PostgresReconciliationServingRepository } from "./reconciliation-serving.ts";

// The public serving list routes used to load the whole entitled set on every
// page request and paginate it in memory. They now push a keyset page down to
// SQL. KeysetDb simulates that keyset predicate and limit from the SQL text and
// parameters, so a cursor walk proves every row stays reachable while each
// fetch reads at most one page plus one row.

const identity: RequestIdentity = {
  subject: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-1",
  roles: ["analyst"],
  entitlements: { workspaceIds: ["workspace-1"], fundIds: ["fund-a", "fund-b"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
};

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

class KeysetDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  private readonly rows: PostgresRow[];
  private readonly keyExpression: string;
  private readonly keyOf: (row: PostgresRow) => string;
  constructor(rows: PostgresRow[], keyExpression: string, keyOf: (row: PostgresRow) => string) {
    this.rows = rows;
    this.keyExpression = keyExpression;
    this.keyOf = keyOf;
  }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    for (const parameter of parameters) assert.ok(typeof parameter !== "string" || !parameter.includes("\u0000"));
    const key = escapeRegExp(this.keyExpression);
    const limit = new RegExp(`order by ${key} collate "C" limit \\$(\\d+)\\s*$`).exec(sql);
    assert.ok(limit, `a keyset page orders by the cursor key with a parameterised limit:\n${sql}`);
    const after = new RegExp(`and ${key} collate "C" > \\$(\\d+)`).exec(sql);
    const bound = after ? String(parameters[Number(after[1]) - 1]) : null;
    return this.rows
      .filter((row) => bound === null || this.keyOf(row) > bound)
      .sort((a, b) => compareText(this.keyOf(a), this.keyOf(b)))
      .slice(0, Number(parameters[Number(limit[1]) - 1]));
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

async function walk<T>(fetchPage: (page: KeysetPage) => Promise<T[]>, keyOf: (item: T) => string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const rows = await fetchPage(keysetPage(cursor, limit));
    assert.ok(rows.length <= limit + 1, "one page fetch never loads more than a page plus one row");
    const page: Page<T> = paginate(rows, keyOf, limit, cursor);
    seen.push(...page.items.map(keyOf));
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
}

const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const TOTAL = 523;

type Case = {
  name: string;
  keyExpression: string;
  column: string;
  entitlementPattern: RegExp;
  leadingParameters: PostgresPrimitive[];
  fetch: (db: PostgresSqlApi, page: KeysetPage) => Promise<Array<{ id: string }>>;
};

const tenantAndFunds: PostgresPrimitive[] = [identity.tenantId, JSON.stringify(identity.entitlements.fundIds)];
const cases: Case[] = [
  { name: "funds", keyExpression: "d.entity_id::text", column: "entity_id", entitlementPattern: /join allowed_fund a on a\.fund_id=d\.entity_id\s+where d\.entity_type='fund'/,
    leadingParameters: [JSON.stringify(identity.entitlements.fundIds)], fetch: (db, page) => new PostgresPublicServingResourceRepository(db).funds(identity, page) },
  { name: "companies", keyExpression: "d.entity_id::text", column: "entity_id", entitlementPattern: /join visible_company v on v\.company_id=d\.entity_id\s+where d\.entity_type='company'/,
    leadingParameters: tenantAndFunds, fetch: (db, page) => new PostgresPublicServingResourceRepository(db).companies(identity, page) },
  { name: "consolidated facts", keyExpression: "f.consolidated_fact_id::text", column: "consolidated_fact_id", entitlementPattern: /where f\.tenant_id=\$1::uuid\s+and exists \(/,
    leadingParameters: tenantAndFunds, fetch: (db, page) => new PostgresPublicServingResourceRepository(db).consolidatedFacts(identity, page) },
  { name: "company lifecycle events", keyExpression: "e.lifecycle_event_id::text", column: "lifecycle_event_id", entitlementPattern: /not exists \(select 1 from allowed_fund a where a\.fund_id=hidden\.fund_id\)/,
    leadingParameters: tenantAndFunds, fetch: (db, page) => new PostgresPublicServingResourceRepository(db).companyLifecycleEvents(identity, page) },
  { name: "holdings", keyExpression: "h.holding_id::text", column: "holding_id", entitlementPattern: /where h\.tenant_id=\$1::uuid\s+and \(\s+h\.target_type='company'/,
    leadingParameters: tenantAndFunds, fetch: (db, page) => new PostgresHoldingInstrumentServingRepository(db).holdings(identity, page) },
  { name: "instruments", keyExpression: "i.instrument_id::text", column: "instrument_id", entitlementPattern: /join allowed_fund a on a\.fund_id=i\.fund_id\s+where i\.tenant_id=\$1::uuid/,
    leadingParameters: tenantAndFunds, fetch: (db, page) => new PostgresHoldingInstrumentServingRepository(db).instruments(identity, page) },
  { name: "reconciliations", keyExpression: "r.reconciliation_run_id::text", column: "reconciliation_run_id", entitlementPattern: /join allowed_fund a on a\.fund_id=r\.fund_id\s+where r\.tenant_id=\$1::uuid/,
    leadingParameters: tenantAndFunds, fetch: (db, page) => new PostgresReconciliationServingRepository(db).list(identity, page) },
];

for (const testCase of cases) {
  test(`${testCase.name} keyset-page in SQL: every row is reachable, each fetch is limit + 1, entitlement predicates kept`, async () => {
    const ids = Array.from({ length: TOTAL }, (_, index) => uuid(index)).reverse();
    const db = new KeysetDb(ids.map((id) => ({ [testCase.column]: id })), testCase.keyExpression, (row) => String(row[testCase.column]));
    const seen = await walk((page) => testCase.fetch(db, page), (item) => item.id, 50);
    assert.deepEqual(seen, [...ids].sort(compareText));
    const last = db.calls.at(-1)!;
    assert.match(last.sql, testCase.entitlementPattern);
    assert.deepEqual(last.parameters.slice(0, testCase.leadingParameters.length), testCase.leadingParameters);
    assert.equal(last.parameters.length, testCase.leadingParameters.length + 2, "cursor key and limit are the only added parameters");
    assert.equal(last.parameters.at(-1), 51);
  });
}

test("metric definitions keyset-page on the route's code:version string, not the column tuple", async () => {
  // "a.b" < "a" as tuple-sorted text differs from "a.b:1" < "a:1" as key strings; the SQL key must be the concatenation.
  const rows = ["a", "a.b", "a-b", "ab", "b"].flatMap((metric_code) => ["1", "2", "10"].map((definition_version) => ({ metric_code, definition_version })));
  const keyOf = (row: { metricCode: string; definitionVersion: string }) => `${row.metricCode}:${row.definitionVersion}`;
  const db = new KeysetDb(rows, "(metric_code || ':' || definition_version)", (row) => `${String(row.metric_code)}:${String(row.definition_version)}`);
  const seen = await walk((page) => new PostgresPublicServingResourceRepository(db).metricDefinitions(page), keyOf, 4);
  assert.deepEqual(seen, rows.map((row) => `${row.metric_code}:${row.definition_version}`).sort(compareText));
  assert.match(db.calls.at(-1)!.sql, /where active=true\s+and \(metric_code \|\| ':' \|\| definition_version\) collate "C" > \$1/);
});

test("serving repositories keep their existing full ordered query when no page is given", async () => {
  const db: PostgresSqlApi & { calls: string[] } = {
    calls: [],
    async query(sql: string) { this.calls.push(sql); return []; },
    async execute() {},
    async health() { return true; },
  };
  const serving = new PostgresPublicServingResourceRepository(db);
  await serving.funds(identity);
  await serving.companies(identity);
  await serving.metricDefinitions();
  await serving.consolidatedFacts(identity);
  await serving.companyLifecycleEvents(identity);
  await new PostgresHoldingInstrumentServingRepository(db).holdings(identity);
  await new PostgresHoldingInstrumentServingRepository(db).instruments(identity);
  await new PostgresReconciliationServingRepository(db).list(identity);
  for (const sql of db.calls) {
    assert.doesNotMatch(sql, /collate "C"/);
    assert.doesNotMatch(sql, /limit \$/);
  }
  assert.match(db.calls[4]!, /order by coalesce\(e\.effective_date,e\.announced_date\) desc nulls last,e\.lifecycle_event_id\s*$/);
});
