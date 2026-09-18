# Incident Response Runbook

## Purpose
Operate a consistent response to security, privacy, data-quality and availability incidents without weakening tenant isolation or evidence preservation.

## Severity
- **SEV1** — confirmed/suspected cross-tenant data exposure, material corruption, credential compromise with customer-data access, or widespread critical outage.
- **SEV2** — material customer workflow unavailable, serious security weakness with plausible exposure, or significant publication delay.
- **SEV3** — limited degradation or contained defect with a workaround.
- **SEV4** — low-impact defect or operational issue.

## First 15 minutes
1. Open an incident record and assign incident commander, technical lead and communications owner.
2. Record UTC start time, detection source, affected tenant/service and current evidence. Do not place customer source material in chat/tickets unless the system is approved for it.
3. For suspected exposure, **contain before debugging**: disable the affected feature/credential/tenant route, revoke leaked credentials and preserve relevant logs/audit rows.
4. Do not delete suspicious objects, audit events, model traces or job records. Quarantine them and preserve hashes/versions.
5. For SEV1/SEV2, establish a restricted incident channel and page the security/engineering owner.

## Investigation
Use the request ID, tenant ID, document/artifact IDs, job IDs and audit-event IDs to trace the path. Determine scope independently for normalized facts and source-document access; permission to view one is not proof of permission to view the other.

For AI/retrieval events, inspect query routing, Cortex Search filters, source-reference entitlements and exact citations. For upload incidents, inspect quarantine object version, scanner result, checksum, multipart audit and final artifact registration.

## Containment options
- Feature-flag or entitlement disable.
- Revoke/rotate OIDC, Snowflake, object-store, scanner or worker credentials.
- Disable a tenant role mapping in `PM_CONTROL.ROLE_TENANT_ACCESS`.
- Quarantine a document/artifact and block publication.
- Suspend affected job type or worker.
- Disable exports/source reads while preserving structured serving access if appropriate.

## Recovery
Recovery requires a named decision owner. Validate tenant isolation, data integrity, source lineage and downstream outputs before re-enabling. Backfill/replay from immutable artifacts rather than hand-editing derived facts.

## Customer / legal communication
The incident commander and legal/security owner determine notification based on contractual and legal obligations. Record the decision and supporting facts; do not speculate about scope before evidence is established.

## Exit criteria
- Immediate customer/security impact is contained.
- Recovery validation passed.
- Monitoring covers the failure mode.
- A root-cause review has an owner and due date.
- Corrective actions are tracked to closure.
- Evidence used for the incident decision is retained.

## Exercise cadence
Run at least one tabletop annually and after material authorization/storage architecture changes. Include a cross-tenant retrieval scenario and a source-document exposure scenario.
