import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("portfolio-only API resources are capability gated", async () => {
  for (const path of ["app/api/v1/portfolios/route.ts","app/api/v1/portfolio-holdings/route.ts"]) {
    const source = await readFile(path,"utf8");
    assert.match(source,/assertFeatureEnabled\(identity,PORTFOLIO_ATTRIBUTION_FLAG,"customer_api"\)/);
  }
});

test("fund position financials do not depend on portfolio attribution unless portfolioId is requested", async () => {
  const route = await readFile("app/api/v1/position-financials/route.ts","utf8");
  const repository = await readFile("lib/server/position-financial-statements.ts","utf8");
  assert.match(route,/if \(portfolioId\) await assertFeatureEnabled\(identity,PORTFOLIO_ATTRIBUTION_FLAG,"customer_api"\)/);
  assert.match(repository,/if \(query\.portfolioId\) \{/);
  assert.match(repository,/corvis_serving\.client_portfolio_holding_attribution/);
});

test("client financials hide and avoid portfolio resources when the module is disabled", async () => {
  const source = await readFile("features/analytics/position-financials-view.tsx","utf8");
  assert.match(source,/capabilities\.features\?\.portfolioAttribution === true/);
  assert.match(source,/if \(!portfolioAttributionEnabled\) return;/);
  assert.match(source,/portfolioAttributionEnabled && selectedPortfolio \?/);
  assert.match(source,/\{portfolioAttributionEnabled && <label><span>Portfolio<\/span>/);
});
