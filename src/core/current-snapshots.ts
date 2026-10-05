import type { FundSnapshot } from "./contracts.ts";

/**
 * `corvis_serving.fund_period_snapshots` is an append-only version history:
 * every publish, withdraw and supersede transition adds a row under the same
 * snapshot id, keeping the earlier versions as immutable history (publishing a
 * draft v1 appends a published v2; withdrawing it appends a withdrawn v3). The
 * list API therefore returns every version, which is right for audit and for
 * the keyset-paged `/snapshots` listing, but wrong as "what is the state of
 * each fund period now". Counts, freshness and attention must be computed from
 * the current version only; use `currentSnapshots` for that.
 */

/**
 * Maps a serving-view snapshot status to the status the product shows. A draft
 * or blocked snapshot is still working its way to publication, so it is in
 * "Review". A withdrawn or superseded snapshot is no longer published but is not
 * awaiting review either, so it keeps its own label instead of masquerading as a
 * preliminary period. Unknown values fall back to "Review" (never "Published").
 */
export function fundSnapshotStatus(servingStatus: string): FundSnapshot["status"] {
  switch (servingStatus.trim().toLowerCase()) {
    case "published": return "Published";
    case "withdrawn": return "Withdrawn";
    case "superseded": return "Superseded";
    default: return "Review";
  }
}

/**
 * Reduces a version history to one row per snapshot id: the highest `version`
 * (a missing version counts as 0; on a tie the first row in input order wins).
 * Rows keep their input order. A row without an id has no identity to version
 * against, so it is its own current snapshot and passes through untouched; a
 * single-version list is returned as-is, element for element.
 */
export function currentSnapshots(snapshots: readonly FundSnapshot[]): FundSnapshot[] {
  const winner = new Map<string, FundSnapshot>();
  for (const snapshot of snapshots) {
    if (!snapshot.id) continue;
    const held = winner.get(snapshot.id);
    if (!held || (snapshot.version ?? 0) > (held.version ?? 0)) winner.set(snapshot.id, snapshot);
  }
  return snapshots.filter((snapshot) => !snapshot.id || winner.get(snapshot.id) === snapshot);
}

export type SnapshotCounts = {
  total: number;
  published: number;
  /** Draft or blocked snapshots still working toward publication. */
  review: number;
  withdrawn: number;
  superseded: number;
  facts: number;
  holdings: number;
  blockingExceptions: number;
  /** Whole-number percentage of current fund periods that are published. */
  completion: number;
};

/**
 * Overview counts over each fund period's current version. Accepts a full
 * version history and reduces it first, so a published v2 is not double
 * counted with its draft v1.
 */
export function snapshotCounts(snapshots: readonly FundSnapshot[]): SnapshotCounts {
  const current = currentSnapshots(snapshots);
  const count = (status: FundSnapshot["status"]) => current.filter((snapshot) => snapshot.status === status).length;
  const published = count("Published");
  return {
    total: current.length,
    published,
    review: count("Review"),
    withdrawn: count("Withdrawn"),
    superseded: count("Superseded"),
    facts: current.reduce((sum, snapshot) => sum + snapshot.facts, 0),
    holdings: current.reduce((sum, snapshot) => sum + snapshot.holdings, 0),
    blockingExceptions: current.reduce((sum, snapshot) => sum + (snapshot.blockingExceptions ?? 0), 0),
    completion: current.length ? Math.round((published / current.length) * 100) : 0,
  };
}
