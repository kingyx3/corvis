import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

const { demoCustomerJourneyStore } = await import("@/platform/demo/customer-journey-store");

test("review(reject) persists state as Rejected, not Needs review", () => {
  const before = demoCustomerJourneyStore.listObservations().find((row) => row.id === "obs-4");
  assert.ok(before, "fixture obs-4 must exist");
  demoCustomerJourneyStore.review({
    observationId: "obs-4",
    decision: "reject",
    reasonCode: "SOURCE_UNRELIABLE",
    expectedVersion: before!.version ?? 1,
  });
  const after = demoCustomerJourneyStore.listObservations().find((row) => row.id === "obs-4");
  assert.equal(after?.state, "Rejected");
});

test("publish() is blocked while an unresolved reconciliation exception remains, even if all observations are approved", () => {
  const scoped = demoCustomerJourneyStore.listObservations().filter((row) => row.snapshotId === "seed-snapshot-2");
  for (const row of scoped) {
    if (row.state === "Approved") continue;
    demoCustomerJourneyStore.review({
      observationId: row.id,
      decision: "approve",
      reasonCode: "SOURCE_VERIFIED",
      expectedVersion: row.version ?? 1,
    });
  }
  assert.ok(
    demoCustomerJourneyStore.listReconciliationExceptions("seed-snapshot-2", 1).length > 0,
    "fixture must seed an open exception on seed-snapshot-2",
  );
  const snapshot = demoCustomerJourneyStore.listSnapshots().find((item) => item.id === "seed-snapshot-2");
  assert.throws(
    () => demoCustomerJourneyStore.publish({ snapshotId: "seed-snapshot-2", action: "publish", expectedVersion: snapshot?.version ?? 1 }),
    /reconciliation exception/i,
  );
});
