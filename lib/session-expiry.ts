/**
 * Decides when a successful workspace load may clear the "session expired" prompt.
 *
 * Anything that sees a 401 reports it (the shared `SESSION_EXPIRED_EVENT`, a failed identity or summary read, a workspace
 * module that answered 401). A workspace load that finishes successfully used to clear the prompt unconditionally, so a
 * load that was already in flight when another call (for example the notification preferences) reported the expiry
 * cleared it again a moment later, depending only on which response arrived last. A load can only vouch for the session
 * if nothing reported an expiry after it started: that is what a Retry after signing in again does (it starts after the
 * report, so it clears the prompt), and what a load that began before the report cannot do.
 *
 * Only the most recently started load ever applies its result (`latest-request.ts`), so one remembered start is enough.
 */
export class SessionExpiryTracker {
  private reports = 0;
  private loadStartedAt = 0;

  /** Something reported that the session expired. */
  report(): void { this.reports += 1; }

  /** A workspace load is starting. */
  beginLoad(): void { this.loadStartedAt = this.reports; }

  /** True when nothing reported an expiry since the most recent load began, so that load, if it succeeded, may clear the prompt. */
  loadMayClear(): boolean { return this.reports === this.loadStartedAt; }
}
