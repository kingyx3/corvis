import type { FundSnapshot, ObservationRecord } from "./contracts.ts";

type ScopableObservation = Pick<ObservationRecord, "snapshotId" | "fund" | "fundId" | "period">;
type ScopingSnapshot = Pick<FundSnapshot, "id" | "fund" | "fundId" | "period">;

function same(a: string | undefined, b: string | undefined): boolean {
  const left = a?.trim().toLowerCase();
  return Boolean(left) && left === b?.trim().toLowerCase();
}

/**
 * Whether one observation belongs to the selected fund-period snapshot.
 *
 * A row that carries its own snapshotId is decided by that id alone (the demo store stamps it).
 * The Postgres `corvis_serving.observations` view has no snapshot column, so there a row belongs
 * to a snapshot when it is the same fund and the same period: a consolidated snapshot is exactly
 * one fund and one explicit economic period (the reconciled stage rejects anything else), so the
 * snapshot's report_period equals the observations' economic_period. Fund ids are compared when
 * both sides have them, display names otherwise. A missing value is never a match.
 */
function belongsToSnapshot(row: ScopableObservation, snapshot: ScopingSnapshot): boolean {
  if (row.snapshotId) return Boolean(snapshot.id) && row.snapshotId === snapshot.id;
  const sameFund = row.fundId && snapshot.fundId ? row.fundId === snapshot.fundId : same(row.fund, snapshot.fund);
  return sameFund && same(row.period, snapshot.period);
}

/**
 * Observations the Review screen shows, counts and gates publication on for the selected snapshot.
 * With a snapshot selected the result never widens to every observation in the tenant: an
 * unmatched snapshot yields an empty queue, which is safer than another fund's live decisions.
 * With no snapshot selected there is nothing to scope by, so the rows are returned unchanged.
 */
export function scopeObservationsToSnapshot<T extends ScopableObservation>(rows: readonly T[], snapshot: ScopingSnapshot | undefined): T[] {
  if (!snapshot) return [...rows];
  return rows.filter((row) => belongsToSnapshot(row, snapshot));
}
