import assert from "node:assert/strict";
import test from "node:test";
import { reviewStateLabel, rowCoverage, scopeLabel, sourceLabel, stateLabel } from "./delivery-presentation.ts";
import type { ExportManifest } from "../../../shared/domain/enterprise.ts";

function manifest(overrides: Partial<ExportManifest> = {}): ExportManifest {
  return {
    exportId: "export_1", tenantId: "t1", generatedAt: "2026-01-01T00:00:00Z", schemaVersion: "v1", taxonomyVersion: "v1",
    snapshotIds: ["snap-1"], format: "csv", rowCounts: { observations: 10 }, checksumSha256: "abc",
    ...overrides,
  };
}

test("stateLabel() turns a snake_case state into a capitalized phrase", () => {
  assert.equal(stateLabel("complete"), "Complete");
  assert.equal(stateLabel("in_progress"), "In progress");
});

test("sourceLabel() defaults missing source to Data delivery, maps review explicitly", () => {
  assert.equal(sourceLabel(undefined), "Data delivery");
  assert.equal(sourceLabel("delivery"), "Data delivery");
  assert.equal(sourceLabel("review"), "Data review");
});

test("scopeLabel() falls back to the full-tenant default when the manifest carries none", () => {
  assert.equal(scopeLabel(manifest()), "All entitled published snapshots");
  assert.equal(scopeLabel({ ...manifest(), scopeLabel: "Fund X" } as ExportManifest & { scopeLabel: string }), "Fund X");
});

test("rowCoverage() prefers scorecard rows, then position-financials rows, then observations", () => {
  assert.equal(rowCoverage(manifest({ rowCounts: { performanceScorecard: 5, observations: 10 } })), "5 scorecard rows · 1 snapshots");
  assert.equal(rowCoverage(manifest({ rowCounts: { positionFinancials: 7, observations: 10 } })), "7 financial rows · 1 snapshots");
  assert.equal(rowCoverage(manifest({ rowCounts: { observations: 10 } })), "10 observations · 1 snapshots");
  assert.equal(rowCoverage(manifest({ rowCounts: {} })), "0 observations · 1 snapshots");
});

test("reviewStateLabel() reports 'Not recorded' for pre-D16 exports and summarizes version range + open exceptions otherwise", () => {
  assert.equal(reviewStateLabel(manifest()), "Not recorded");
  assert.equal(reviewStateLabel(manifest({ snapshotState: [{ snapshotId: "a", version: 2, openExceptionCount: 0 }] })), "v2 · no open exceptions");
  assert.equal(
    reviewStateLabel(manifest({ snapshotState: [
      { snapshotId: "a", version: 2, openExceptionCount: 1 },
      { snapshotId: "b", version: 5, openExceptionCount: 2 },
    ] })),
    "v2–v5 · 3 open exceptions",
  );
});
