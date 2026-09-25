import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_POSITIONS, demoPositionFinancialStatements } from "./position-financial-statements-demo.ts";

test("demoPositionFinancialStatements returns rows for every demo position, two lines by three quarters each", () => {
  const rows = demoPositionFinancialStatements();
  assert.equal(rows.length, DEMO_POSITIONS.length * 2 * 3);
  for (const row of rows) assert.equal(row.statementType, "income_statement");
});

test("demoPositionFinancialStatements filters by companyId, matching the observation ids adapters/demo/catalog.ts carries", () => {
  const rows = demoPositionFinancialStatements({ companyId: "company-abc-corp" });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.companyId, "company-abc-corp");
    assert.equal(row.fundId, "fund-advent-viii");
    assert.equal(row.holdingId, "holding-abc-corp");
  }
});

test("demoPositionFinancialStatements filters by fundId and holdingId", () => {
  const byFund = demoPositionFinancialStatements({ fundId: "fund-nordic-v" });
  assert.ok(byFund.every((row) => row.fundId === "fund-nordic-v"));
  assert.ok(byFund.length > 0);

  const byHolding = demoPositionFinancialStatements({ holdingId: "holding-project-sparrow" });
  assert.ok(byHolding.every((row) => row.holdingId === "holding-project-sparrow"));
  assert.ok(byHolding.length > 0);
});

test("demoPositionFinancialStatements returns nothing for an unknown company", () => {
  assert.deepEqual(demoPositionFinancialStatements({ companyId: "does-not-exist" }), []);
});

test("demoPositionFinancialStatements has real quarter-over-quarter movement and a preliminary latest quarter", () => {
  const rows = demoPositionFinancialStatements({ companyId: "company-abc-corp", periodicity: "quarterly" }).filter((row) => row.lineKey === "revenue");
  const byQuarter = new Map(rows.map((row) => [row.fiscalQuarter, row]));
  assert.equal(byQuarter.get(1)?.valueNumber, "780");
  assert.equal(byQuarter.get(2)?.valueNumber, "842");
  assert.equal(byQuarter.get(2)?.isRestatement, true);
  assert.equal(byQuarter.get(3)?.valueNumber, "905");
  assert.equal(byQuarter.get(3)?.preliminary, true);
});

test("demoPositionFinancialStatements respects limit", () => {
  const rows = demoPositionFinancialStatements({ limit: 2 });
  assert.equal(rows.length, 2);
});
