import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASELINE = "db/postgres/migrations/001_baseline.sql";

// Slice one view definition (it ends at the first statement terminator) out of the baseline.
function viewDefinition(sql: string, name: string): string {
  const start = sql.indexOf(`create view ${name} `);
  assert.ok(start >= 0, `missing view ${name}`);
  const end = sql.indexOf(";\n", start);
  assert.ok(end > start, `unterminated view ${name}`);
  return sql.slice(start, end);
}

test("client portfolio layer sits above funds and preserves canonical holdings", async () => {
  const sql = (await readFile(BASELINE,"utf8")).toLowerCase();
  const attribution = viewDefinition(sql, "corvis_serving.client_portfolio_holding_attribution");
  const portfolioViews = [
    viewDefinition(sql, "corvis_serving.client_portfolios"),
    viewDefinition(sql, "corvis_serving.client_portfolio_fund_positions"),
    attribution,
  ];

  assert.match(sql,/create table corvis_facts\.client_portfolio \(/);
  assert.match(sql,/create table corvis_facts\.client_portfolio_fund_position \(/);
  assert.match(sql,/alter table only corvis_facts\.client_portfolio_fund_position\s+add constraint \w+ foreign key \(fund_id\) references corvis_identity\.fund\(global_fund_id\)/);
  assert.match(sql,/create view corvis_serving\.client_portfolio_holding_attribution /);
  assert.match(attribution,/with recursive fund_path as/);
  assert.match(attribution,/join corvis_serving\.holdings h/);
  assert.match(attribution,/h_1\.target_type = 'fund'::text/);
  assert.match(attribution,/not \(h_1\.target_fund_id = any \(fp_1\.fund_path\)\)/);
  assert.match(attribution,/lookthrough_depth < 15/);

  // The attribution view carries identity/path only. It never scales company
  // operating facts by fund ownership or by a client portfolio interest.
  for (const view of portfolioViews) {
    assert.equal(/revenue\s*\*/.test(view),false);
    assert.equal(/ebitda\s*\*/.test(view),false);
    assert.equal(/value_number\s*\*/.test(view),false);
  }

  for (const table of ["client_portfolio", "client_portfolio_fund_position"]) {
    assert.match(sql,new RegExp(`alter table corvis_facts\\.${table} enable row level security`));
    assert.match(sql,new RegExp(`alter table only corvis_facts\\.${table} force row level security`));
    assert.match(sql,new RegExp(`create policy \\w+ on corvis_facts\\.${table} for select using [^;]*has_workspace_access`));
  }
  assert.equal(portfolioViews.filter((view) => /^create view \S+ with \(security_invoker='true'\) as/.test(view)).length,3);
});

test("portfolio serving intersects workspace membership with authoritative fund entitlements", async () => {
  const source = (await readFile("src/modules/analytics/server/client-portfolio-attribution.ts","utf8")).toLowerCase();
  assert.match(source,/p\.tenant_id=\$1::uuid/);
  assert.match(source,/p\.workspace_id::text=\$2/);
  assert.match(source,/join allowed_fund af on af\.fund_id=pf\.fund_id/);
  assert.match(source,/a\.root_fund_id in \(select value from jsonb_array_elements_text\(\$3::jsonb\)\)/);
  assert.match(source,/a\.owning_fund_id in \(select value from jsonb_array_elements_text\(\$3::jsonb\)\)/);
  assert.match(source,/a\.target_type<>'fund' or a\.target_fund_id in/);
  assert.match(source,/portfolio membership is an attribution dimension, never an authorization grant/);
  assert.match(source,/sqlkeyset\("p\.portfolio_id::text"/);
  assert.match(source,/sqlkeyset\("a\.attribution_key"/);
});

test("position financials can scope by portfolio without ownership-weighting statement values", async () => {
  const source = (await readFile("src/modules/analytics/server/position-financial-statements.ts","utf8")).toLowerCase();
  assert.match(source,/portfolioid\?: string/);
  assert.match(source,/corvis_serving\.client_portfolio_holding_attribution pa/);
  assert.match(source,/pa\.holding_id::text=v\.holding_id/);
  assert.match(source,/pa\.owning_fund_id=v\.fund_id/);
  assert.equal(/value_number\s*\*/.test(source),false);
});

test("portfolio workspace routes are explicitly classified outside the stable external API contract", async () => {
  const classification = JSON.parse(await readFile("openapi/v1-route-classification.json","utf8")) as { routes: Array<{ pattern: string; visibility: string; reason: string }> };
  const portfolios = classification.routes.find((route) => route.pattern === "/portfolios");
  const holdings = classification.routes.find((route) => route.pattern === "/portfolio-holdings");
  assert.equal(portfolios?.visibility,"workspace_control");
  assert.equal(holdings?.visibility,"workspace_control");
  assert.match(portfolios?.reason ?? "",/attribution/);
  assert.match(holdings?.reason ?? "",/never grants fund access|attribution/);
});
