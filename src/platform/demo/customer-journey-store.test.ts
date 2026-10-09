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

test("publish({action: 'withdraw'}) sets status to Withdrawn, not back to Review", () => {
  const before = demoCustomerJourneyStore.listSnapshots().find((item) => item.id === "seed-snapshot-4");
  assert.equal(before?.status, "Published", "fixture seed-snapshot-4 must start Published");
  demoCustomerJourneyStore.publish({ snapshotId: "seed-snapshot-4", action: "withdraw", expectedVersion: before!.version ?? 1 });
  const after = demoCustomerJourneyStore.listSnapshots().find((item) => item.id === "seed-snapshot-4");
  assert.equal(after?.status, "Withdrawn");
});

test("publish({action: 'withdraw'}) refuses a snapshot that is not currently Published", () => {
  const snapshot = demoCustomerJourneyStore.listSnapshots().find((item) => item.id === "seed-snapshot-4");
  assert.equal(snapshot?.status, "Withdrawn", "must run after the withdraw test above");
  assert.throws(
    () => demoCustomerJourneyStore.publish({ snapshotId: "seed-snapshot-4", action: "withdraw", expectedVersion: snapshot!.version ?? 1 }),
    /snapshot_not_publishable/,
  );
  assert.throws(
    () => demoCustomerJourneyStore.publish({ snapshotId: "seed-snapshot-4", action: "supersede", expectedVersion: snapshot!.version ?? 1 }),
    /snapshot_not_publishable/,
  );
});

test("publish({action: 'publish'}) refuses a snapshot that is already Published", () => {
  const snapshot = demoCustomerJourneyStore.listSnapshots().find((item) => item.id === "seed-snapshot-3");
  assert.equal(snapshot?.status, "Published", "fixture seed-snapshot-3 must start Published");
  assert.throws(
    () => demoCustomerJourneyStore.publish({ snapshotId: "seed-snapshot-3", action: "publish", expectedVersion: snapshot!.version ?? 1 }),
    /snapshot_not_publishable/,
  );
});

test("publish({action: 'supersede'}) sets status to Superseded", () => {
  const before = demoCustomerJourneyStore.listSnapshots().find((item) => item.id === "seed-snapshot-1");
  assert.equal(before?.status, "Published", "fixture seed-snapshot-1 must start Published");
  demoCustomerJourneyStore.publish({ snapshotId: "seed-snapshot-1", action: "supersede", expectedVersion: before!.version ?? 1 });
  const after = demoCustomerJourneyStore.listSnapshots().find((item) => item.id === "seed-snapshot-1");
  assert.equal(after?.status, "Superseded");
});
