# Corvis production runbook

## Severity

- **SEV1:** suspected customer-data exposure, cross-tenant access, widespread corruption, or critical outage.
- **SEV2:** material workflow unavailable, persistent publication delay, dead-letter backlog, or restore objective at risk.
- **SEV3:** limited degradation with workaround.
- **SEV4:** low-impact defect.

## First response

1. Establish incident commander and correlation/time window.
2. Preserve audit/log/trace evidence; do not delete or rewrite source artifacts.
3. For suspected tenant exposure, disable affected serving/retrieval path and rotate relevant credentials before restoring traffic.
4. For pipeline failures, stop automatic retries if they amplify corruption; retain dead-letter jobs for replay.
5. Identify customer scope from tenant IDs and serving/audit lineage, not from global identities.
6. Record decisions and customer-notification assessment.

## Upload failure

- Check upload-session state and object-store multipart state.
- Resume only missing parts; do not create a second document artifact for the same idempotency key.
- Quarantine artifacts that fail checksum, type validation, or malware policy.
- Abort abandoned multipart uploads per lifecycle policy.

## Processing failure

- Trace `correlationId` across source registration, representation, extraction, review and serving.
- Inspect attempt/maxAttempts and dead-letter state.
- Retry from durable upstream records; never require customer re-upload when immutable source bytes are intact.
- Before replaying canonicalization/publication, verify idempotency and target version.

## Data incident

- Freeze affected snapshot versions rather than overwriting history.
- Use lineage: snapshot → consolidated fact → observation → source reference → artifact version.
- Publish corrected data as a new version/supersession with review event and audit evidence.

## Recovery

- Restore structured metadata/canonical data from the approved backup path.
- Reconcile immutable object-store source inventory against `DOCUMENT_ARTIFACT_VERSION`.
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
