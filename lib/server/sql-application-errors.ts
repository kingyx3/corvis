/**
 * SQL functions signal expected business outcomes (an expired invitation, a
 * non-terminal job) with `RAISE EXCEPTION`. The native driver never surfaces
 * driver text because it can carry SQL values, row data or credentials, so
 * callers could no longer tell those outcomes from a real failure and mapped
 * them all to a 500.
 *
 * This closed allowlist restores that signal safely: the driver reports only
 * the allowlisted fragment that the raised message contains, never the
 * message itself. Add a fragment here only for a message authored in our own
 * SQL that contains no interpolated data.
 */
export const SQL_APPLICATION_ERRORS = [
  // corvis_control.accept_tenant_invitation (056)
  "invitation_not_found",
  "invitation_not_pending",
  "invitation_expired",
  "invitation_identity_disabled",
  "invitation_membership_exists",
  "invitation_email_mismatch",
  "invalid_invitation_identity",
  // corvis_control.recover_dead_letter_processing_job (027, 046)
  "retained durable stage-delivery evidence",
  "retained predecessor lineage evidence",
  "only terminal dead-letter jobs",
  "idempotency key was reused with different command content",
  "requires an exhausted job",
  // corvis_control.claim_processing_stage_delivery authenticity guard (046, 050)
  "event id has no matching outbox record",
] as const;

export type SqlApplicationError = (typeof SQL_APPLICATION_ERRORS)[number];

/** The allowlisted fragment contained in a raised SQL message, if any. */
export function matchSqlApplicationError(error: unknown): SqlApplicationError | undefined {
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  if (typeof message !== "string") return undefined;
  return SQL_APPLICATION_ERRORS.find((fragment) => message.includes(fragment));
}

/** Reads the allowlisted code carried by a driver error, falling back to a raw message for non-native drivers and fakes. */
export function sqlApplicationErrorOf(error: unknown): string {
  if (error && typeof error === "object") {
    const carried = (error as { applicationError?: unknown }).applicationError;
    if (typeof carried === "string") return carried;
    if ((error as { name?: unknown }).name === "PostgresDriverError") return "";
  }
  return error instanceof Error ? error.message : String(error);
}
