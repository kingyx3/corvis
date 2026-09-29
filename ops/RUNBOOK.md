# Corvis production runbook

## Severity

- **SEV1:** suspected customer-data exposure, cross-tenant access, widespread corruption, or critical outage.
- **SEV2:** material workflow unavailable, persistent publication delay, dead-letter backlog, or restore objective at risk.
- **SEV3:** limited degradation with workaround.
- **SEV4:** low-impact defect.

## First response

1. Establish incident commander and correlation/time window.
2. Preserve audit/log/trace evidence; do not delete or rewrite retained source artifacts.
3. For suspected tenant exposure, disable affected serving/retrieval path and rotate relevant credentials before restoring traffic.
4. For pipeline failures, stop automatic retries if they amplify corruption; retain dead-letter jobs for replay.
5. Identify customer scope from tenant IDs and serving/audit lineage, not from global identities.
6. Record decisions and customer-notification assessment.

## Upload failure

- Check the Corvis upload-session record and the authorized GCS resumable session/object state.
- Query the GCS resumable session for the committed byte range before retrying; continue from the next committed byte rather than restarting blindly.
- If the GCS resumable session has expired, abort the Corvis upload session and initiate a replacement session under the same logical file/idempotency flow; do not create duplicate document truth.
- Verify final GCS object size/generation and retained storage checksum metadata before quarantine processing.
- Quarantine artifacts that fail type/signature, checksum/integrity, or malware policy.
- Clean up abandoned resumable sessions/objects according to lifecycle policy without deleting retained accepted source evidence.

## Processing failure

- Trace `correlationId` across source registration, representation, extraction, review and serving.
- Inspect attempt/maxAttempts and dead-letter state.
- Retry from durable upstream records; never require customer re-upload when immutable source bytes are intact.
- Before replaying canonicalization/publication, verify idempotency and target version.
- **Transport dead-letter** (alert `corvis-<env>-processing-transport-dead-letter`): an outbox event exhausted its publish attempts and its document stays `registered`. As a tenant admin, `GET /api/v1/admin/processing-transport/dead-letters` lists the events with their last (redacted) error; fix the cause, then `POST` the same path with `{ "eventId", "reason" }` to requeue one. The requeue is audited (`processing_transport.requeue_dead_letter`), restores the full attempt budget and is a no-op (409 `event_not_dead_lettered`) for an event that was already requeued or published.

## Data incident

- Freeze affected snapshot versions rather than overwriting history.
- Use lineage: snapshot → consolidated fact → observation → source reference → artifact version.
- Publish corrected data as a new version/supersession with review event and audit evidence.

## Data-rewriting migrations (064 and later)

The runner applies each migration in one transaction, so every lock a migration takes is held until it commits (#228).

- **Maintenance window.** `064_compatibility_cleanup_guards.sql` backfills `consolidated_fact.value` and adds constraints under an ACCESS EXCLUSIVE lock that is held for the whole migration (`lock_timeout` 30s, `statement_timeout` 15 min). On a populated `consolidated_fact` it blocks every read of it, including Overview and semantic queries. Apply it (and any environment still behind it) in an announced maintenance window, after checking `select count(*) from corvis_consolidated.consolidated_fact where nullif(btrim(value->'semanticDimensions'->>'subjectLevel'), '') is null` to size the rewrite.
- **Migration role.** Run migrations as a role that bypasses RLS (Supabase's `postgres`). Under FORCE RLS (051) a non-bypassing role sees no rows, so 064's guard and backfill silently do nothing and the deploy fails later at `VALIDATE CONSTRAINT`.
- **Blank `subject_type` guard.** If 064 aborts with `consolidated_fact contains blank subject_type`, the deploy stops before changing anything. Find the rows with `select tenant_id, consolidated_fact_id, snapshot_id from corvis_consolidated.consolidated_fact where nullif(btrim(subject_type), '') is null`, correct them through the governed data-correction path (`/api/v1/admin/data-corrections`, which republishes a new version rather than editing published history), then re-run the deploy.
- **Customer-visible changes.** 064 paused webhook subscriptions left with no customer-facing event type without an audit row; migration 069 records `webhook_subscription.paused_by_migration` for each and fills `paused_at`/`paused_by`. Tell affected tenants to re-subscribe to a supported event type. 064's rewrite of `consolidated_fact.value` only added `semanticDimensions.subjectLevel` (copied from `subject_type`); no figure changed.
- **Future backfills.** Split a data backfill from its constraint: first a migration (or bounded batch job) that backfills in batches, then a separate migration that adds the constraint `NOT VALID` and validates it. Write an `audit_event` in the same migration for every customer-visible row it changes, and keep a before-image when the change is not reconstructible.

## Recovery

- Restore structured metadata/canonical data from the approved backup path.
- Reconcile immutable GCS source inventory against `DOCUMENT_ARTIFACT_VERSION`, including object generation and stored checksum metadata.
- Replay derived layers only after tenant-policy tables and data-rights metadata are restored.
- Validate row-access isolation before reopening customer traffic.
- Record actual RPO/RTO and retain restore evidence.

## Readiness checks after recovery

- `/api/v1/health` responds.
- Admin readiness reports required production bindings configured.
- Cross-tenant negative authorization test passes.
- Published-fact source-reference coverage is 100%.
- Dead-letter queue is understood/owned.
- Critical alerts and customer communications are resolved or explicitly accepted.
