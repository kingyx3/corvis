import { nextAttemptDelayMs, type ConnectionStatus } from "./source-connectors.ts";

/**
 * When a source connection is collected from next. The schedule is one column per connection
 * (`source_connection.next_scheduled_at`), and it doubles as the lease a running sync holds:
 *
 *  - null: due at the next collection run. A connection that was never scheduled, or whose collection was stopped
 *    (paused, reauthorization required, suspended) and has come back, starts straight away.
 *  - in the past: due.
 *  - in the future: not due. While a sync runs this is the lease expiry, so no second worker takes the connection; when
 *    the run ends it is replaced by the interval (success) or a bounded backoff (failure). A worker that dies leaves the
 *    lease to lapse, after which the connection is due again.
 */

/** How often a healthy connection is collected from. Well inside the 48-hour staleness window. */
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How long a claimed connection is held by one worker. A sync that outlives it may be taken over; collection is idempotent, so that costs time, never duplicates. */
export const SYNC_LEASE_MS = 60 * 60 * 1000;

/** What one scheduler pass did. `errors` counts connections whose pass raised an unexpected fault (they are retried after a backoff). */
export type SourceSyncSummary = {
  /** Active connections found due that have a registered driver. */
  due: number;
  succeeded: number;
  /** Runs that ended in a failure the provider or the pipeline reported; the connection backs off or stops. */
  failed: number;
  /** Runs that stopped before collecting, including fail-closed credential or permission failures. */
  refused: number;
  /** Due connections another worker claimed first, or that stopped being active before this pass could claim them. */
  skipped: number;
  errors: number;
};

export function emptySyncSummary(): SourceSyncSummary {
  return { due: 0, succeeded: 0, failed: 0, refused: 0, skipped: 0, errors: 0 };
}

export type RunOutcome = "succeeded" | "failed";

/** The time after a run of an active connection: the interval after a success, the bounded exponential backoff (one minute doubling to an hour, jittered) for the failure streak after a failure. */
export function scheduleAfter(outcome: RunOutcome, consecutiveFailures: number, now: number): Date {
  return new Date(now + (outcome === "succeeded" ? SYNC_INTERVAL_MS : nextAttemptDelayMs(consecutiveFailures)));
}

/**
 * The next scheduled time after a run, for the status the run left the connection in. A connection that is no longer
 * active has no schedule: it is due the moment it is reauthorized or resumed.
 */
export function nextRunAt(input: { outcome: RunOutcome; status: ConnectionStatus; consecutiveFailures: number; now: number }): Date | null {
  return input.status === "active" ? scheduleAfter(input.outcome, input.consecutiveFailures, input.now) : null;
}

/** The lease a worker takes on a connection it claims at `now`. */
export function leaseExpiry(now: number): Date {
  return new Date(now + SYNC_LEASE_MS);
}
