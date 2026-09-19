# Standard enterprise customer implementation

This directory is the repository-owned technical implementation/cutover kit. Confluence remains authoritative for customer acceptance policy and production launch approval.

## Safety boundary

The manifest contains stable IDs, rights decisions, immutable release references and **secret names/references only**. Never put passwords, tokens, DSNs, private keys, customer source credentials or real customer documents in this public repository. The validator fails closed on secret-like fields.

## Preflight

Validate a sanitized manifest:

```sh
npm run customer:preflight -- ops/customer-implementation/sanitized-fixture.json
```

Evaluate cutover evidence as well:

```sh
npm run customer:preflight -- ops/customer-implementation/sanitized-fixture.json ops/customer-implementation/acceptance-fixture.json
```

A `ready` result means the supplied technical evidence set is complete; it is not business approval and it does not substitute for live UAT evidence.

## Cutover sequence

1. Pin the exact reviewed commit, immutable image digest and migration high-water mark.
2. Resolve the tenant/workspace, approved fund/data rights and provider references without copying secret payloads.
3. Verify database migrations and runtime secret versions before enabling source or delivery traffic.
4. Run source/upload and delivery connectivity checks with the customer's approved scope.
5. Run tenant/RLS negatives and a representative source-to-serving lineage sample.
6. Run/resume historical backfill through the normal idempotent processing path and reconcile completeness.
7. Exercise rollback to `cutover.rollbackImageDigest` with compatible database state.
8. Produce the acceptance scorecard; unresolved exceptions or undocumented manual interventions block cutover.
9. After cutover, record first-cycle/hypercare exceptions and convert recurring engineering work into an owned product/operations issue rather than an undocumented runbook step.

## Rollback/cutback

Rollback changes runtime release selection; it must not rewrite observations, snapshot history, audit events or source evidence. Data-quality defects use the governed correction/reprocessing path rather than direct database edits. If a migration is not backward compatible, stop cutover and use the reviewed forward-fix/recovery plan instead of destructive schema rollback.
