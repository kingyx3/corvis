import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExportRequest, type ExportRequest } from "./delivery.ts";

test("no export request normalizes to an unscoped request", () => {
  assert.deepEqual(normalizeExportRequest(undefined), {});
});

test("the pre-D12 snapshot-scope call becomes a scoped Review export", () => {
  assert.deepEqual(normalizeExportRequest({ snapshotId: "snap-1" }), { scope: { snapshotId: "snap-1" }, source: "review" });
});

test("an explicit request keeps its scope and source untouched, for every scope kind", () => {
  const requests: ExportRequest[] = [
    { scope: { snapshotId: "snap-1" }, source: "review" },
    { scope: { positionFinancials: { fundId: "f", holdingId: "h", companyId: "c", periodicity: "annual" } }, source: "delivery" },
    { scope: { performanceScorecard: true }, source: "delivery" },
    { source: "delivery" },
  ];
  for (const request of requests) assert.equal(normalizeExportRequest(request), request);
});
