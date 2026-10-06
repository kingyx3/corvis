# Continuous business-build / documentation control loop

Implementation tracker: GitHub issue #27. Canonical requirement: Confluence [Continuous Business Build Documentation Control Loop](https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/2064451/Continuous+Business+Build+Documentation+Control+Loop).

This document describes the repository implementation. Confluence remains authoritative for the business/control requirement.

## Current implementation

`services/control-loop/` provides the safety and scanning engine:

- versioned rule catalogue with stable finding fingerprints and explicit authority/remediation metadata;
- documentation-authority, internal-link, architecture-drift and GitHub issue-hygiene scanners;
- deterministic plan/apply envelope with dry-run default and mutation budget;
- health/closure gates that fail closed on incomplete or failed scans;
- daily incremental vs weekly/monthly full-scan scope: the watermark records the last successfully scanned commit and a daily run scans every path changed in `<last scanned commit>..HEAD` (read with `git diff -z`, so non-ASCII and unusual file names match verbatim). A missing watermark, a watermark from before the field existed, an unreachable or non-ancestor commit, or no git checkout (the Cloud Run image) falls back to a full scan;
- durable watermark state;
- single-writer lease with stale-lock recovery;
- one structured `RunReport` instead of scattered side effects.

The CLI registers the GitHub file-edit adapter only with `--apply` plus repository identity and a write-scoped token, and the issue writer independently with `--apply-issues` and those credentials. Scheduled GitHub Actions and Cloud Run jobs still pass neither opt-in and remain read-only. These adapters do not implement Confluence writes or bypass protected-branch rules.

Link repair plans carry complete before/after document snapshots. Parsed destinations are updated together in one file write, retaining anchors and URL encoding without rewriting prose or code examples. Findings sharing the same edit reuse its verified outcome; concurrent source changes fail the optimistic check.

## State adapters

Two state adapters intentionally exist:

1. `FileStateStore` — build-phase/manual GitHub Actions bootstrap. Actions cache restores `services/control-loop/state` between runs. Cache loss is safe because a missing watermark forces a full rescan.
2. `GcsStateStore` — production-like Cloud Run Job runtime. The adapter obtains a short-lived token from the GCP metadata server and stores state in the environment's private GCS control-loop bucket.

The GCS adapter exposes generation-aware conditional writes. `lock.ts` uses Cloud Storage object-generation preconditions for atomic lease acquisition/release, so two overlapping Cloud Run Job executions cannot both become the writer. Watermark updates also use generation-aware compare-and-set, so an expired lease holder cannot overwrite a newer run. A conflict or persistence failure reports an incomplete run.

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

The purpose-built `services/control-loop/Dockerfile` contains the reviewed repository snapshot because the scanner inspects source/docs/infra. A Dockerfile-specific ignore file keeps credentials, build products and local state out without widening the API container build context.

## GitHub issue reads

`github.ts` reads the public repository's `control-loop`-labelled issues without requiring a long-lived GitHub token. If the repository becomes private, or when issue mutation is enabled, the runtime must receive a bounded managed GitHub credential; do not add a personal access token to source, Terraform state or image layers.

## Scheduler cutover boundary

`.github/workflows/control-loop.yml` remains the build-phase/read-only bootstrap scheduler for now. The Cloud Run Jobs are also dry-run/read-only. This overlap is acceptable only while neither path mutates external systems.

Before #27 enables GitHub/Confluence writes, one scheduler must become authoritative and all mutation paths must share the same durable lease/state boundary. The intended production authority is Cloud Scheduler → Cloud Run Job; GitHub Actions should then remain manual/dry-run or be unscheduled.

## Execution safety

- persist the exact file and issue proposals before any external write; a failed plan save blocks mutation;
- dry-run by default;
- nonnegative safe-integer mutation budgets and canonical-path allowlist enforcement; zero disables writes, invalid values fail before work;
- budgets count attempted logical actions, including uncertain writes and state changes whose follow-up comment fails (one issue action may issue a state request plus a comment);
- budget exhaustion, missing configured writers and failed writes mark the run incomplete and retain the prior success watermark; no later issue closure follows a failed reconciliation action;
- final health/findings/closure reflect the final run outcome; the CLI exits nonzero on non-skipped incomplete or failed runs;
- atomic production lease and stale-lock reclamation;
- no automatic closure after partial/failed scans;
- corrupted/missing watermark degrades to a full rescan;
- weekly/monthly modes always perform full scans;
- runtime image is immutable-digest pinned;
- UAT/prod known-good cannot advance until the deployed jobs, schedules, invoker identity and state-bucket controls pass live acceptance.

## Still open under issue #27

The runtime/scheduler infrastructure is no longer the primary code gap, but #27 remains open because the business-control loop is not yet fully operational:

1. live Confluence read/reconciliation is not wired into the scheduled runtime;
2. GitHub issue create/reopen/close by fingerprint and allowlisted repository documentation remediation are implemented, but scheduled writes remain disabled pending the single-writer cutover, scoped credentials and rollback/acceptance evidence;
3. automated health-issue synchronization and Confluence remediation are not implemented;
4. business-maturity comparison against the Confluence gap/readiness/control/risk registers is not implemented;
5. production scheduler cutover and recurring provider-backed execution evidence have not yet been demonstrated;
6. incident/postmortem feedback into regression rules remains future work.

These are functional/operating-control gaps, not reasons to weaken the runtime safety model.

## Finding fingerprints

A finding fingerprint is `domain:owners:subject`, where the subject segment is `<slug>#<hash>`: a readable slug of the subject plus the first 10 hex characters of the SHA-256 of the raw, unslugged subject (`services/control-loop/classifiers/fingerprint.ts`). The hash keeps subjects that slug to the same text distinct (`docs/a-b.md` vs `docs/a_b.md`, or paths differing only in case or punctuation), so `dedupeFindings` never drops one of them, and a subject with no ASCII letters is still fingerprinted. Tracked issues carry the fingerprint in a `Finding fingerprint:` line of their body, and `parseFingerprint` only accepts this format.

## Runbook

- **Run reports failed:** inspect the structured report's `notes` and scanner completeness. Failed scans cannot close issues.
- **Health is unhealthy:** inspect `health.reasons`; a complete daily/weekly/monthly run restores the relevant health state naturally.
- **Cloud Run lock contention:** a fresh other-owner lease means the second run exits without becoming writer; stale leases are reclaimed after the configured staleness window.
- **Corrupted/missing watermark:** no manual repair is required; the next run performs a full scan and rewrites a valid watermark after successful completion.
- **GCS state errors:** verify the control-loop service account has object access only to `${project_id}-corvis-control-loop-${environment}`, public access prevention remains enforced, and Scheduler/job identities match Terraform.
- **Incomplete run:** inspect notes and failed/skipped outcomes, repair the cause, then rescan. Do not advance readiness or treat the proposed watermark as persisted when a watermark-write error is recorded.
- **Bad remediation:** scheduled mutation remains disabled. For an explicitly enabled manual write, preserve the saved `plan_<mode>` and report, inspect the exact GitHub commit, and revert via the normal reviewed PR path. Never overwrite subsequent human changes. A production rollout still needs tested rollback and retained evidence.

## Testing

`npm test` includes all `services/control-loop/*.test.ts` tests. Coverage includes fingerprints, scanners, health/closure gates, scan scope, watermark recovery, stale-lock behavior, concurrent conditional-lock acquisition, GCS generation preconditions, plan/apply budgets, scheduler mode resolution and end-to-end orchestrator behavior.

CI also builds the dedicated control-loop image as non-root and executes a scanner smoke run. Terraform CI validates the UAT/prod Cloud Run Job/Scheduler module before merge; provider-backed acceptance remains a UAT/prod deployment gate rather than a repository-only claim.
