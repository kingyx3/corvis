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
  // corvis_control.apply_identity_lifecycle / reactivate_identity_admin (011, 041, 043, 048)
  "invalid identity lifecycle operation",
  "human identity lifecycle only supports oidc or saml",
  "invalid identity lifecycle fields",
  "memberships must be an array",
  "disable must not include memberships",
  "invalid membership entry",
  "duplicate membership entry",
  "identity lifecycle event replay conflict",
  "identity subject is already mapped to a different user",
  "disabled identity requires explicit reactivation",
  "identity subject does not match the requested user",
  "identity subject does not match requested user",
  "identity is not disabled",
  "tenant_admin_role_requires_tenant_admin_actor",
  // corvis_control.apply_resource_entitlement_admin / apply_data_right_admin (040)
  "invalid resource entitlement operation",
  "invalid resource type",
  "invalid resource permission",
  "resource id required",
  "reason required",
  "invalid entitlement effective dates",
  "invalid data-right operation",
  "invalid data-right effective dates",
  // "active support workspace not found" contains "workspace not found": keep the
  // longer fragment first because the first contained fragment wins.
  "active support workspace not found",
  "workspace not found",
  "subject user not found",
  // corvis_control.apply_support_access_admin (041, 045, 048)
  "invalid support access operation",
  "invalid support auth method",
  "invalid support role",
  "support purpose required",
  "approval reference required",
  "support access requires a future expiry",
  "support access cannot be self-approved",
  "active support identity not found",
  "requested support role is already active outside this grant",
  "support grant id required",
  "support grant not found",
  // corvis_source.release_clean_artifact (072)
  "artifact was purged and cannot be released",
  // corvis_control.open/replay/resolve_data_correction_incident (022, 031, 068) and the publication guard (030)
  "idempotency key reused with different correction scope",
  "correction incident is not replayable",
  "has no retained source document to replay",
  "correction incident is not resolvable",
  "replacement snapshot must already be published",
  "replacement snapshot scope does not match correction incident",
  "active data correction incident blocks publication",
  // corvis_control.report_data_issue / transition_data_issue_case (083)
  "idempotency key reused with different data issue report",
  "data issue snapshot not found for fund",
  "data issue case status changed",
  "data issue transition not allowed",
  "data issue correction not found",
  "data issue correction scope mismatch",
  "data issue correction was cancelled",
  "data issue correction required",
  "data issue correction is not resolved",
  "data issue resolution note required",
  // corvis_control.request_tenant_export / decide_tenant_export (084)
  "tenant export purpose required",
  "tenant export requires an active organization admin",
  "tenant export already in progress",
  "tenant export requires an independent approver",
  "tenant export can only be cancelled by its requester",
  "tenant export approval window has passed",
  "tenant export decision note required",
  "tenant export status changed",
  "tenant export transition not allowed",
  // corvis_control.create_export_schedule / set_export_schedule_status (085)
  "idempotency key reused with different export schedule",
  "export schedule scope is invalid",
  "export schedule limit reached",
  "export schedule transition not allowed",
  // corvis_control.set_review_item_assignee / add_review_item_comment (086)
  "review item not found",
  "review item actor not found",
  "review assignee not eligible",
  "review mention not eligible",
  "review item assignment changed",
  "review comment limit reached",
  "idempotency key reused with different review comment",
  // corvis_control.set_tenant_session_policy / sign_out_user_everywhere (087)
  "session policy requires an active organization admin",
  "session policy bounds exceeded",
  "session policy version conflict",
  "session sign-out needs a stated reason",
  "session sign-out cannot target current user",
  "session sign-out target not found",
  // corvis_control.create_service_account / issue_service_account_credential / revoke_service_account_credentials / disable_service_account (088)
  "service account requires an active organization admin",
  "service account name required",
  "service account purpose required",
  "service account role not allowed",
  "service account expiry invalid",
  "service account name already in use",
  "service account limit reached",
  "service account credential request invalid",
  "service account not found",
  "service account is not active",
  "service account already has a credential",
  "service account has no active credential",
  "service account justification required",
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

/**
 * Client-facing classification of the admin-function fragments above: the
 * stable public error code and HTTP status a route returns instead of a 500.
 * Fragments consumed elsewhere (invitations, dead-letter recovery, the
 * delivery authenticity guard) are mapped by their own callers and are absent.
 */
const ADMIN_SQL_ERROR_CLASSIFICATION: Partial<Record<SqlApplicationError, { code: string; status: number }>> = {
  "invalid identity lifecycle operation": { code: "invalid_request", status: 400 },
  "human identity lifecycle only supports oidc or saml": { code: "invalid_request", status: 400 },
  "invalid identity lifecycle fields": { code: "invalid_request", status: 400 },
  "memberships must be an array": { code: "invalid_request", status: 400 },
  "disable must not include memberships": { code: "invalid_request", status: 400 },
  "invalid membership entry": { code: "invalid_request", status: 400 },
  "duplicate membership entry": { code: "invalid_request", status: 400 },
  "identity lifecycle event replay conflict": { code: "identity_lifecycle_event_conflict", status: 409 },
  "identity subject is already mapped to a different user": { code: "identity_subject_conflict", status: 409 },
  "disabled identity requires explicit reactivation": { code: "identity_disabled", status: 409 },
  "identity subject does not match the requested user": { code: "identity_subject_mismatch", status: 409 },
  "identity subject does not match requested user": { code: "identity_subject_mismatch", status: 409 },
  "identity is not disabled": { code: "identity_not_disabled", status: 409 },
  "tenant_admin_role_requires_tenant_admin_actor": { code: "tenant_admin_role_requires_tenant_admin_actor", status: 403 },
  "invalid resource entitlement operation": { code: "invalid_request", status: 400 },
  "invalid resource type": { code: "invalid_request", status: 400 },
  "invalid resource permission": { code: "invalid_request", status: 400 },
  "resource id required": { code: "invalid_request", status: 400 },
  "reason required": { code: "invalid_request", status: 400 },
  "invalid entitlement effective dates": { code: "invalid_request", status: 400 },
  "invalid data-right operation": { code: "invalid_request", status: 400 },
  "invalid data-right effective dates": { code: "invalid_request", status: 400 },
  "active support workspace not found": { code: "support_workspace_not_found", status: 404 },
  "workspace not found": { code: "workspace_not_found", status: 404 },
  "subject user not found": { code: "subject_user_not_found", status: 404 },
  "invalid support access operation": { code: "invalid_request", status: 400 },
  "invalid support auth method": { code: "invalid_request", status: 400 },
  "invalid support role": { code: "invalid_request", status: 400 },
  "support purpose required": { code: "invalid_request", status: 400 },
  "approval reference required": { code: "invalid_request", status: 400 },
  "support access requires a future expiry": { code: "invalid_request", status: 400 },
  "support access cannot be self-approved": { code: "support_access_self_approval_denied", status: 403 },
  "active support identity not found": { code: "support_identity_not_found", status: 404 },
  "requested support role is already active outside this grant": { code: "support_role_already_active", status: 409 },
  "support grant id required": { code: "invalid_request", status: 400 },
  "support grant not found": { code: "support_grant_not_found", status: 404 },
  // A release that lost a race with abort/expiry/sweep: the session is no longer active.
  "artifact was purged and cannot be released": { code: "upload_not_active", status: 409 },
  // Data-correction incidents: refusals of a command the incident's current state or key history cannot accept.
  "idempotency key reused with different correction scope": { code: "idempotency_key_reused", status: 409 },
  "correction incident is not replayable": { code: "correction_incident_not_replayable", status: 409 },
  "has no retained source document to replay": { code: "correction_incident_no_source_document", status: 409 },
  "correction incident is not resolvable": { code: "correction_incident_not_resolvable", status: 409 },
  "replacement snapshot must already be published": { code: "replacement_snapshot_not_published", status: 409 },
  "replacement snapshot scope does not match correction incident": { code: "replacement_snapshot_scope_mismatch", status: 409 },
  "active data correction incident blocks publication": { code: "publication_blocked_by_correction", status: 409 },
  // Data-issue reports (F5): refusals of a report or a case command that its key history or current status cannot accept.
  "idempotency key reused with different data issue report": { code: "idempotency_key_reused", status: 409 },
  "data issue snapshot not found for fund": { code: "data_issue_snapshot_not_found", status: 404 },
  "data issue case status changed": { code: "data_issue_status_changed", status: 409 },
  "data issue transition not allowed": { code: "data_issue_transition_not_allowed", status: 409 },
  "data issue correction not found": { code: "data_issue_correction_not_found", status: 404 },
  "data issue correction scope mismatch": { code: "data_issue_correction_scope_mismatch", status: 409 },
  "data issue correction was cancelled": { code: "data_issue_correction_cancelled", status: 409 },
  "data issue correction required": { code: "data_issue_correction_required", status: 409 },
  "data issue correction is not resolved": { code: "data_issue_correction_not_resolved", status: 409 },
  "data issue resolution note required": { code: "invalid_note", status: 400 },
  // Full tenant export (F10): who may ask and decide, and what a request's current state can accept.
  "tenant export purpose required": { code: "invalid_reason", status: 400 },
  "tenant export requires an active organization admin": { code: "tenant_admin_required", status: 403 },
  "tenant export already in progress": { code: "data_export_already_active", status: 409 },
  "tenant export requires an independent approver": { code: "data_export_independent_approver_required", status: 403 },
  "tenant export can only be cancelled by its requester": { code: "data_export_cancel_requester_only", status: 403 },
  "tenant export approval window has passed": { code: "data_export_approval_expired", status: 409 },
  "tenant export decision note required": { code: "invalid_note", status: 400 },
  "tenant export status changed": { code: "data_export_status_changed", status: 409 },
  "tenant export transition not allowed": { code: "data_export_transition_not_allowed", status: 409 },
  // Scheduled exports (F4): refusals of a schedule or a status change that its key history, quota or current state cannot accept.
  "idempotency key reused with different export schedule": { code: "idempotency_key_reused", status: 409 },
  "export schedule scope is invalid": { code: "invalid_scope", status: 400 },
  "export schedule limit reached": { code: "export_schedule_limit_reached", status: 409 },
  "export schedule transition not allowed": { code: "export_schedule_transition_not_allowed", status: 409 },
  // Review item discussion (F3): a missing or invisible item, an ineligible person, a stale assignment or a replayed key.
  "review item not found": { code: "review_item_not_found", status: 404 },
  "review item actor not found": { code: "human_identity_required", status: 403 },
  "review assignee not eligible": { code: "assignee_not_eligible", status: 422 },
  "review mention not eligible": { code: "mention_not_eligible", status: 422 },
  "review item assignment changed": { code: "assignment_changed", status: 409 },
  "review comment limit reached": { code: "review_comment_limit_reached", status: 409 },
  "idempotency key reused with different review comment": { code: "idempotency_key_reused", status: 409 },
  // Organization session policy (F7): who may change it, the Corvis bounds, a stale version and the sign-out refusals.
  "session policy requires an active organization admin": { code: "tenant_admin_required", status: 403 },
  "session policy bounds exceeded": { code: "session_policy_out_of_bounds", status: 400 },
  "session policy version conflict": { code: "session_policy_version_conflict", status: 409 },
  "session sign-out needs a stated reason": { code: "invalid_reason", status: 400 },
  "session sign-out cannot target current user": { code: "cannot_sign_out_current_user", status: 409 },
  "session sign-out target not found": { code: "member_not_found", status: 404 },
  // Service accounts (F6): who may manage them, what a request may ask for and what an account's current state can accept.
  "service account requires an active organization admin": { code: "tenant_admin_required", status: 403 },
  "service account name required": { code: "invalid_name", status: 400 },
  "service account purpose required": { code: "invalid_purpose", status: 400 },
  "service account role not allowed": { code: "invalid_role", status: 400 },
  "service account expiry invalid": { code: "invalid_expiry", status: 400 },
  "service account name already in use": { code: "service_account_name_in_use", status: 409 },
  "service account limit reached": { code: "service_account_limit_reached", status: 409 },
  "service account credential request invalid": { code: "invalid_request", status: 400 },
  "service account not found": { code: "service_account_not_found", status: 404 },
  "service account is not active": { code: "service_account_not_active", status: 409 },
  "service account already has a credential": { code: "service_account_credential_exists", status: 409 },
  "service account has no active credential": { code: "service_account_no_active_credential", status: 409 },
  "service account justification required": { code: "invalid_reason", status: 400 },
};

/**
 * The public code/status for an admin SQL business error, or undefined when
 * the error is not one (so callers fall through to their normal handling).
 * Native driver errors carry only the allowlisted fragment; fakes and non-native
 * drivers are matched on their raw message.
 */
export function adminSqlErrorClassification(error: unknown): { code: string; status: number } | undefined {
  if (error && typeof error === "object") {
    const carried = (error as { applicationError?: unknown }).applicationError;
    if (typeof carried === "string") return ADMIN_SQL_ERROR_CLASSIFICATION[carried as SqlApplicationError];
    if ((error as { name?: unknown }).name === "PostgresDriverError") return undefined;
  }
  const fragment = matchSqlApplicationError(error);
  return fragment ? ADMIN_SQL_ERROR_CLASSIFICATION[fragment] : undefined;
}
