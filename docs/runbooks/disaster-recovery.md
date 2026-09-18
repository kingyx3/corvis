# Disaster Recovery & Restore Runbook

## Objectives
Corvis is designed so immutable source artifacts plus reviewed/versioned structured records can reconstruct downstream derived layers. Recovery objectives must be validated per deployed service tier; the baseline target is **RPO ≤ 24 hours for rebuildable structured metadata, near-zero RPO for versioned source objects**, and **RTO ≤ 8 hours for core document/serving recovery**. Tighter contractual objectives require tested infrastructure and staffing evidence.

## Recovery order
1. Identity / secrets / KMS access.
2. Private source-object store and version history.
3. Snowflake control/source/canonical data.
4. Job/orchestration state.
5. Serving views and tenant role mappings.
6. Search index rebuild.
7. Application/API.
8. Derived exports and caches.

Search indexes, exports and semantic caches are disposable; never recover them ahead of authoritative source/canonical state.

## Required backups / recoverability
- S3-compatible source bucket: versioning enabled; short Object Lock governance protection; provider durability plus approved backup/replication strategy for the deployed tier.
- Snowflake: use Time Travel/fail-safe capabilities appropriate to edition plus scheduled logical exports/snapshots of critical control/configuration where required by policy.
- Infrastructure: Terraform and Snowflake migrations in Git.
- Secrets: recover through the organization secrets manager; secrets must not be backed up into the repository.
- Search: rebuild from `PM_SOURCE.DOCUMENT_CHUNK` and source-reference metadata.

## Restore test
Quarterly in production or a production-like isolated recovery environment:
1. Select a documented restore point and capture expected RPO/RTO.
2. Restore/recreate infrastructure and Snowflake structures from reviewed code.
3. Restore or recover selected tenant data without copying another tenant's source/facts.
4. Verify at least one document artifact hash, one reviewed observation lineage path and one published snapshot.
5. Rebuild retrieval index and prove unauthorized-tenant search returns zero source chunks.
6. Run application smoke tests and a source drill-through.
7. Record actual RPO/RTO, failures, owner and remediation.

## Evidence template
Record: exercise ID, UTC start/end, environment, owner, restore point, source object/version IDs (non-sensitive identifiers only), Snowflake recovery method, actual RPO/RTO, tenant-isolation test result, lineage test result, search-rebuild result, open findings and approval.

## Failure / escalation
A failed restore test is a control failure. Create a tracked P0/P1 remediation based on customer impact, do not silently change the stated recovery objective, and repeat the failed portion after remediation.
