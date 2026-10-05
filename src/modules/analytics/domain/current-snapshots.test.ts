import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../../../shared/domain/contracts.ts";
import type { FundSnapshot } from "../../../shared/domain/contracts.ts";
import { currentSnapshots, fundSnapshotStatus, snapshotCounts } from "./current-snapshots.ts";

function snapshot(overrides: Partial<FundSnapshot>): FundSnapshot {
  return { id: "s1", version: 1, fund: "Fund A", period: "Q2 2026", status: "Review", holdings: 3, facts: 10, changed: "now", ...overrides };
}

test("the contracts module stays type-only, so importing it has no runtime effect", () => {
  assert.deepEqual(Object.keys(contracts), []);
});

test("serving statuses map to a truthful product status", () => {
  assert.equal(fundSnapshotStatus("published"), "Published");
  assert.equal(fundSnapshotStatus(" Published "), "Published");
  assert.equal(fundSnapshotStatus("withdrawn"), "Withdrawn");
  assert.equal(fundSnapshotStatus("SUPERSEDED"), "Superseded");
  // Not yet published: still in review, and blocked work is review work too.
  assert.equal(fundSnapshotStatus("draft"), "Review");
  assert.equal(fundSnapshotStatus("blocked"), "Review");
  // Never optimistic about something unrecognised.
  assert.equal(fundSnapshotStatus(""), "Review");
  assert.equal(fundSnapshotStatus("archived"), "Review");
});

test("a version history reduces to the highest version of each snapshot, whatever the input order", () => {
  const v1 = snapshot({ version: 1, status: "Review" });
  const v2 = snapshot({ version: 2, status: "Published" });
  const v3 = snapshot({ version: 3, status: "Withdrawn" });
  const other = snapshot({ id: "s2", fund: "Fund B", version: 1 });
  for (const history of [[v3, v2, v1, other], [v1, v2, v3, other], [v2, other, v3, v1]]) {
    const current = currentSnapshots(history);
    assert.equal(current.length, 2);
    assert.equal(current.find((item) => item.id === "s1"), v3);
    assert.equal(current.find((item) => item.id === "s2"), other);
  }
  // Survivors keep their relative input order.
  assert.deepEqual(currentSnapshots([v2, other, v3, v1]).map((item) => `${item.id}@${item.version}`), ["s2@1", "s1@3"]);
});

test("current reduction treats a missing version as the oldest and the first row as the winner of a tie", () => {
  const unversioned = snapshot({ version: undefined, status: "Review" });
  const versioned = snapshot({ version: 1, status: "Published" });
  assert.equal(currentSnapshots([unversioned, versioned])[0], versioned);
  assert.equal(currentSnapshots([versioned, unversioned])[0], versioned);
  const first = snapshot({ version: 2, fund: "first" });
  const second = snapshot({ version: 2, fund: "second" });
  assert.deepEqual(currentSnapshots([first, second]), [first]);
  const bareA = snapshot({ version: undefined, fund: "a" });
  const bareB = snapshot({ version: undefined, fund: "b" });
  assert.deepEqual(currentSnapshots([bareA, bareB]), [bareA]);
});

test("single-version lists and id-less rows pass through untouched, and the input is not mutated", () => {
  const demo = [snapshot({ id: "a", fund: "A" }), snapshot({ id: "b", fund: "B", status: "Published" })];
  const result = currentSnapshots(demo);
  assert.deepEqual(result, demo);
  assert.notEqual(result, demo, "returns a new array");
  assert.equal(result[0], demo[0]);
  // Without an id there is nothing to version against: two rows for one fund and period both stay.
  const anonymous = [snapshot({ id: undefined, version: undefined }), snapshot({ id: undefined, version: undefined })];
  assert.equal(currentSnapshots(anonymous).length, 2);
  assert.deepEqual(currentSnapshots([]), []);
  assert.equal(demo.length, 2);
});

test("Overview counts describe current versions: a published period is not also a preliminary one", () => {
  const published = [
    snapshot({ id: "s1", version: 1, status: "Review", facts: 10, holdings: 3, blockingExceptions: 2 }),
    snapshot({ id: "s1", version: 2, status: "Published", facts: 10, holdings: 3, blockingExceptions: 0 }),
  ];
  assert.deepEqual(snapshotCounts(published), { total: 1, published: 1, review: 0, withdrawn: 0, superseded: 0, facts: 10, holdings: 3, blockingExceptions: 0, completion: 100 });

  const mixed = [
    ...published,
    snapshot({ id: "s2", version: 1, status: "Review", facts: 5, holdings: 1, blockingExceptions: 1 }),
    snapshot({ id: "s3", version: 1, status: "Published", facts: 7, holdings: 2 }),
    snapshot({ id: "s3", version: 2, status: "Superseded", facts: 7, holdings: 2 }),
    snapshot({ id: "s4", version: 1, status: "Published", facts: 1, holdings: 1 }),
    snapshot({ id: "s4", version: 2, status: "Withdrawn", facts: 1, holdings: 1 }),
  ];
  assert.deepEqual(snapshotCounts(mixed), { total: 4, published: 1, review: 1, withdrawn: 1, superseded: 1, facts: 23, holdings: 7, blockingExceptions: 1, completion: 25 });
  assert.deepEqual(snapshotCounts([]), { total: 0, published: 0, review: 0, withdrawn: 0, superseded: 0, facts: 0, holdings: 0, blockingExceptions: 0, completion: 0 });
});
