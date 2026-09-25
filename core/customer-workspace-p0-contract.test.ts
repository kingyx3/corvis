import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("overview keeps a prominent actionable attention state", async () => {
  const overview = await source("features/overview/overview-view.tsx");
  assert.match(overview, /Reporting overview · \{attentionHeadline\}/);
  assert.match(overview, /All caught up/);
  assert.match(overview, /Review now/);
  assert.match(overview, /Workspace metrics ordered for/);
});

test("position financials keeps trust, period deltas and source evidence wired", async () => {
  const financials = await source("features/analytics/position-financials-view.tsx");
  assert.match(financials, /financialDelta/);
  assert.match(financials, /Period-over-period change display/);
  assert.match(financials, /financialTrustLabel/);
  assert.match(financials, /financialAsOf/);
  assert.match(financials, /workspacePort\.sourceEvidence/);
  assert.match(financials, /Open source evidence/);
  assert.match(financials, /Open source document/);
  assert.match(financials, /Source evidence restricted by access/);
});
