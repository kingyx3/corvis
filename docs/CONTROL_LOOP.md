# Continuous business-build / documentation control loop

Implementation tracker: GitHub issue #27. Canonical requirement: Confluence [Continuous Business Build Documentation Control Loop](https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/2064451/Continuous+Business+Build+Documentation+Control+Loop).

This document describes the repository implementation. Confluence remains authoritative for the business/control requirement.

## Current implementation

`control-loop/` provides the safety and scanning engine:

- versioned rule catalogue with stable finding fingerprints and explicit authority/remediation metadata;
- documentation-authority, internal-link, architecture-drift and GitHub issue-hygiene scanners;
- deterministic plan/apply envelope with dry-run default and mutation budget;
- health/closure gates that fail closed on incomplete or failed scans;
- daily incremental vs weekly/monthly full-scan scope;
- durable watermark state;
- single-writer lease with stale-lock recovery;
- one structured `RunReport` instead of scattered side effects.

No production remediator is registered. `--apply` therefore still cannot mutate GitHub or Confluence and reports an automatic action as skipped when no applier exists.

## State adapters

Two state adapters intentionally exist:

1. `FileStateStore` — build-phase/manual GitHub Actions bootstrap. Actions cache restores `control-loop/state` between runs. Cache loss is safe because a missing watermark forces a full rescan.
2. `GcsStateStore` — production-like Cloud Run Job runtime. The adapter obtains a short-lived token from the GCP metadata server and stores state in the environment's private GCS control-loop bucket.

The GCS adapter exposes generation-aware conditional writes. `lock.ts` uses Cloud Storage object-generation preconditions for atomic lease acquisition/release, so two overlapping Cloud Run Job executions cannot both become the writer. Watermark updates remain ordinary writes because only the lease holder is permitted to reach them.

The durable GCS state contains operational control-loop state and sanitized run reports, not customer documents or application secrets.

## Production-like scheduler/runtime

UAT/prod Terraform now defines a dedicated `corvis-control-loop-${environment}` service identity, private/versioned state bucket and three Cloud Run Jobs using the separately built `corvis/control-loop@sha256:...` image.

| Job | Singapore schedule | CLI mode |
| --- | --- | --- |
| Daily | `02:17` every day | `daily` |
| Weekly | Sunday `03:23` | `weekly` |
| Monthly candidate | Sunday `04:31` | `monthly-candidate` |

The monthly candidate resolves inside `schedule.ts` using the `Asia/Singapore` calendar: day 1–7 becomes `monthly`; later Sundays become `weekly`. This preserves the original monthly-first-Sunday contract without UTC/date-boundary ambiguity.

Cloud Scheduler calls the Cloud Run Jobs `:run` API with OAuth as the dedicated control-loop service account. The job identity receives only logging, its private state-bucket object access, and the exact job-invoker bindings required for the schedules. It does not inherit API/worker/Postgres permissions.

The purpose-built `Dockerfile.control-loop` contains the reviewed repository snapshot because the scanner inspects source/docs/infra. A Dockerfile-specific ignore file keeps credentials, build products and local state out without widening the API container build context.

## GitHub issue reads

`github.ts` reads the public repository's `control-loop`-labelled issues without requiring a long-lived GitHub token. If the repository becomes private, or when issue mutation is implemented, the runtime must receive a bounded managed GitHub credential; do not add a personal access token to source, Terraform state or image layers.

## Scheduler cutover boundary

`.github/workflows/control-loop.yml` remains the build-phase/read-only bootstrap scheduler for now. The Cloud Run Jobs are also dry-run/read-only. This overlap is acceptable only while neither path mutates external systems.

Before #27 enables GitHub/Confluence writes, one scheduler must become authoritative and all mutation paths must share the same durable lease/state boundary. The intended production authority is Cloud Scheduler → Cloud Run Job; GitHub Actions should then remain manual/dry-run or be unscheduled.

## Execution safety

- plan before apply;
- dry-run by default;
- mutation budget and allowlist enforcement;
- atomic production lease and stale-lock reclamation;
- no automatic closure after partial/failed scans;
- corrupted/missing watermark degrades to a full rescan;
- weekly/monthly modes always perform full scans;
- runtime image is immutable-digest pinned;
- UAT/prod known-good cannot advance until the deployed jobs, schedules, invoker identity and state-bucket controls pass live acceptance.

## Still open under issue #27

The runtime/scheduler infrastructure is no longer the primary code gap, but #27 remains open because the business-control loop is not yet fully operational:

1. live Confluence read/reconciliation is not wired into the scheduled runtime;
2. GitHub issue create/update/close/reopen is not implemented;
3. allowlisted documentation remediation is not implemented;
4. business-maturity comparison against the Confluence gap/readiness/control/risk registers is not implemented;
5. production scheduler cutover and recurring provider-backed execution evidence have not yet been demonstrated;
6. incident/postmortem feedback into regression rules remains future work.

These are functional/operating-control gaps, not reasons to weaken the runtime safety model.

## Runbook

- **Run reports failed:** inspect the structured report's `notes` and scanner completeness. Failed scans cannot close issues.
- **Health is unhealthy:** inspect `health.reasons`; a complete daily/weekly/monthly run restores the relevant health state naturally.
- **Cloud Run lock contention:** a fresh other-owner lease means the second run exits without becoming writer; stale leases are reclaimed after the configured staleness window.
- **Corrupted/missing watermark:** no manual repair is required; the next run performs a full scan and rewrites a valid watermark after successful completion.
- **GCS state errors:** verify the control-loop service account has object access only to `${project_id}-corvis-control-loop-${environment}`, public access prevention remains enforced, and Scheduler/job identities match Terraform.
- **Bad remediation:** currently impossible in production because no remediator is registered. When remediation is added, its rollback/evidence contract must be added before enabling scheduler-side mutation.

## Testing

`npm test` includes all `control-loop/*.test.ts` tests. Coverage includes fingerprints, scanners, health/closure gates, scan scope, watermark recovery, stale-lock behavior, concurrent conditional-lock acquisition, GCS generation preconditions, plan/apply budgets, scheduler mode resolution and end-to-end orchestrator behavior.

CI also builds the dedicated control-loop image as non-root and executes a scanner smoke run. Terraform CI validates the UAT/prod Cloud Run Job/Scheduler module before merge; provider-backed acceptance remains a UAT/prod deployment gate rather than a repository-only claim.
