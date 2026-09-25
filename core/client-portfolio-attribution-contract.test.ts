import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("client portfolio layer sits above funds and preserves canonical holdings", async () => {
  const sql = (await readFile("db/postgres/migrations/053_client_portfolio_attribution.sql","utf8")).toLowerCase();

  assert.match(sql,/create table if not exists corvis_facts\.client_portfolio \(/);
  assert.match(sql,/create table if not exists corvis_facts\.client_portfolio_fund_position \(/);
  assert.match(sql,/foreign key \(fund_id\)[\s\S]*references corvis_identity\.fund\(global_fund_id\)/);
  assert.match(sql,/create or replace view corvis_serving\.client_portfolio_holding_attribution/);
  assert.match(sql,/with recursive fund_path as/);
  assert.match(sql,/join corvis_serving\.holdings h/);
  assert.match(sql,/h\.target_type='fund'/);
  assert.match(sql,/not \(h\.target_fund_id = any\(fp\.fund_path\)\)/);
  assert.match(sql,/lookthrough_depth < 15/);

  // The attribution view carries identity/path only. It never scales company
  // operating facts by fund ownership or by a client portfolio interest.
  assert.equal(/revenue\s*\*/.test(sql),false);
  assert.equal(/ebitda\s*\*/.test(sql),false);
  assert.equal(/value_number\s*\*/.test(sql),false);

  assert.match(sql,/enable row level security/);
  assert.match(sql,/force row level security/);
  assert.match(sql,/has_workspace_access/);
  assert.equal((sql.match(/with \(security_invoker=true\)/g) ?? []).length,3);
});

test("portfolio serving intersects workspace membership with authoritative fund entitlements", async () => {
  const source = (await readFile("lib/server/client-portfolio-attribution.ts","utf8")).toLowerCase();
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
  const source = (await readFile("lib/server/position-financial-statements.ts","utf8")).toLowerCase();
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
