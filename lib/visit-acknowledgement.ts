/**
 * The "What changed" digest is rebuilt server-side from the last acknowledged visit, so the visit
 * may be acknowledged only once per mount: the first summary the user actually saw. A later
 * refresh (pin, retry, Refresh workspace) carries a newer generatedAt and must not advance the
 * cursor, or it would erase a digest the user has not yet read. Returns the `seenAt` to post, or
 * null when there is nothing to acknowledge (no summary yet, or already acknowledged).
 */
export function claimVisitAcknowledgement(state: { acknowledged: boolean }, generatedAt: string | null | undefined): string | null {
  if (!generatedAt || state.acknowledged) return null;
  state.acknowledged = true;
  return generatedAt;
}
