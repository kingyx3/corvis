# Continuous business-build / documentation control loop

Implementation tracker: GitHub issue #27. Canonical requirement: Confluence
[Continuous Business Build Documentation Control Loop](https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/2064451/Continuous+Business+Build+Documentation+Control+Loop).

This document describes what `control-loop/` actually does today. It does not
redefine the Confluence-owned requirement; where this document and the
Confluence page disagree, the Confluence page governs.

## What is implemented

**Phase 1 — read-only scanners, rules, fingerprints and run report** (`control-loop/`):

- `rules/catalog.ts` — the versioned rule catalogue (`CL-DOC-*`, `CL-ARCH-*`,
  `CL-ISSUE-*`, `CL-HEALTH-001`), each with a stable id, domain, owners,
  severity, authority (`confluence` | `github`), remediation class
  (`auto-fix` | `human-approval`) and an explicit allowlist.
- `classifiers/fingerprint.ts` — deterministic `domain:owners:subject`
  fingerprints, deduplication and stable sort order.
- `scanners/documentation-authority.ts` — flags Confluence-owned business/
  control truth stated in GitHub docs without a Confluence link
  (`CL-DOC-001`), and GitHub-owned technical detail deferred to Confluence
  instead of being implemented in GitHub (`CL-DOC-002`).
- `scanners/internal-links.ts` — flags a canonical internal documentation
  link that no longer resolves to a tracked repository path (`CL-DOC-003`),
  proposing a safe rename when exactly one file shares the broken link's
  basename.
- `scanners/architecture-drift.ts` — flags `core/` importing a provider
  adapter or server runtime module (`CL-ARCH-001`), and `features/`
  importing server/provider modules instead of typed ports (`CL-ARCH-002`).
- `scanners/issue-hygiene.ts` — given a snapshot of `control-loop`-labeled
  GitHub issues, flags an issue with no parseable fingerprint
  (`CL-ISSUE-001`), duplicate open issues sharing one fingerprint
  (`CL-ISSUE-002`), and a closed issue whose finding recurred and must
  reopen rather than duplicate (`CL-ISSUE-003`). With no issue snapshot
  available (no `GITHUB_TOKEN` configured), it reports itself incomplete
  rather than silently skipping.
- `reports/health.ts` — the mandated health rule: unhealthy when no
  successful daily run has completed within 36 hours, two consecutive runs
  have not reached `complete` status, or the most recent weekly/monthly scan
  did not complete. While unhealthy, `automaticClosureEnabled` is `false`.
- `watermark.ts` / `state.ts` — a durable, versioned watermark
  (`control-loop/state/watermark.json`, committed by the workflow after a
  run) that a daily run reads to scan incrementally; a weekly or monthly run
  always ignores it and scans fully.
- `lock.ts` — a single-writer application-level lock (`control-loop/state/lock.json`)
  with a bounded staleness window, so one crashed run cannot permanently wedge
  the loop but two concurrent runs can never both proceed.
- `plan.ts` / `apply.ts` — the mandated two-phase execution: `planActions`
  classifies every finding into a proposed action and persists it in the run
  report *before* anything is applied; `applyActions` then applies only
  automatic, allowlisted actions, bounded by a mutation budget, and defaults
  to `dry-run` (never calls an applier) unless the caller explicitly opts
  into `execute` mode.
- `orchestrator.ts` — ties all of the above into one `runControlLoop()` call
  that acquires the lock, scans under the mode's scope rules, classifies and
  (dry-run by default) applies findings, evaluates health, decides whether
  automatic issue closure is allowed, and persists the watermark — returning
  one `RunReport` (`schemaVersion: 1`) rather than scattered side effects.
  It never throws: an unexpected scanner failure is caught and reported as a
  `failed` run so a crash cannot corrupt the watermark.
- `github.ts` — reads open/closed `control-loop`-labeled issues via the
  GitHub REST API, extracting each issue's fingerprint from the same
  `` Finding fingerprint: `...` `` convention this repository's own P0
  tracker issues already use.
- `cli.ts` — the entry point `.github/workflows/control-loop.yml` calls:
  `node control-loop/cli.ts --mode <daily|weekly|monthly|manual> [--evidence path] [--apply]`.
  Without `--apply` the run is dry-run. With `--apply`, an automatic action
  still reports as `skipped: no_applier_configured` today, because **no
  remediator is registered yet** (see "What is not implemented" below) — the
  safety envelope exists and is tested, but nothing currently exercises it
  end to end against a real edit.

### Scheduler contract

`.github/workflows/control-loop.yml` runs on the build-phase GitHub Actions
schedule from the issue, converted from Asia/Singapore (UTC+8, no DST) to the
UTC cron GitHub Actions requires — the conversion is documented inline in the
workflow file. `workflow_dispatch` allows a manual dry-run in any mode. A
single `concurrency: group: control-loop` prevents two scheduled or manual
runs from executing at the same time, on top of the application-level lock
enforced by `lock.ts`.

The monthly-vs-weekly distinction on the shared Saturday-evening UTC slot is
resolved against the **Asia/Singapore** calendar date inside the workflow
(`TZ=Asia/Singapore date +%-d`), not the UTC date, since a Saturday-evening
UTC run can already be the first Sunday of the next Singapore month.

### Execution safety

- Two-phase: `planActions` (persisted in the report) happens before
  `applyActions` (bounded, dry-run by default).
- Single global concurrency group (GitHub Actions) plus an independent
  application-level lock (`lock.ts`), both tested.
- A partial or failed scan can add a health finding but cannot allow issue
  closure — `closureDecision()` requires `status === "complete"` and every
  scanner to report `complete: true`.
- The daily watermark and full weekly/monthly rescan behavior are enforced
  by `selectScanScope()` and covered by tests.
- The health rule disables automatic closure while unhealthy, and is
  evaluated from the *post-run* watermark, so a genuinely successful,
  fully-complete run can restore health in the same run that fixes the
  underlying gap.
- A corrupted watermark file degrades to a full rescan rather than crashing
  or trusting partial state.

## What is NOT implemented

This is deliberately a phase 1 (scanners, fingerprinting, health/watermark/
lock, two-phase safety envelope) plus the phase-2 dry-run seam. Do not treat
issue #27 as closeable on the strength of this document alone — per the
issue itself, it stays open until scheduled runs are operating reliably with
evidence, which requires all of the following still-outstanding work:

1. **No remediator is registered.** `applyActions` is fully tested against a
   fake `EditApplier`, but no real file-editing remediator exists yet for
   `CL-DOC-003`'s safe-rename suggestion or any other rule. `--apply` today
   only proves the safety envelope (budget, allowlist, dry-run default); it
   does not fix anything.
2. **No GitHub issue mutation.** The orchestrator computes
   `closureCandidates` / `reopenCandidates` (via `scanIssueHygiene`) and
   reports them in the run output, but nothing in this repository creates,
   updates, closes or reopens a GitHub issue. That is phase 3 of the
   Confluence specification and is intentionally out of scope here: an
   automated system that can open or close issues needs more scrutiny than
   fits in this pass.
3. **No Confluence read or write access.** The documentation-authority
   scanner works entirely from the *GitHub side* — it looks for missing
   links or misplaced technical detail in GitHub docs. It cannot detect
   technical detail duplicated into Confluence (the requirement's other
   direction) because that requires a Confluence API integration that does
   not exist here.
4. **No business-maturity comparison against Confluence registers** (phase
   4), and **no production Cloud Scheduler → Cloud Run Job migration**
   (phase 5, coordinated with issue #13's runtime provisioning) — GitHub
   Actions remains the only scheduler.
5. **No regression-rule feedback loop from incidents/postmortems** (phase 6).
6. The daily-incremental `changedPaths` input in the workflow currently uses
   `git diff HEAD~1 HEAD`, which is correct for a single push-driven event
   but is not itself a substitute for the durable watermark — the watermark
   is what actually gates incremental-vs-full scanning across scheduled runs.

## Runbook

- **A scheduled run fails outright** (workflow-level failure, not a
  `RunStatus: "failed"` report): check the uploaded
  `control-loop-report-<mode>` artifact first — the orchestrator itself
  should have produced one unless the failure happened before `node
  control-loop/cli.ts` ran (checkout, `npm ci`). If a report exists with
  `status: "failed"`, its `notes` array names the scan failure.
- **The loop reports unhealthy** (`health.healthy: false`): read
  `health.reasons`. `no_successful_daily_run_in_36h` and
  `two_consecutive_failures` both resolve themselves once a run reaches
  `status: "complete"`; `incomplete_weekly_scan` only resolves on a
  successful weekly or monthly run. While unhealthy, no issue closure
  happens even if every finding otherwise looks resolved — this is
  intentional and requires no manual override.
- **The lock appears stuck**: `control-loop/state/lock.json` self-expires
  after the configured staleness window (default one hour) and the next run
  reclaims it automatically. Deleting the file manually is safe but should
  not be necessary.
- **The watermark looks wrong or corrupted**: `readWatermark` already
  degrades a corrupted or schema-mismatched file to a full rescan rather
  than failing, so the safe recovery is simply to let the next run replace
  it; manually deleting `control-loop/state/watermark.json` has the same
  effect.
- **Recovering from a bad remediation** is not currently a concern, because
  no remediator writes anything yet (see "What is NOT implemented").

## Testing

`npm test` runs `control-loop/*.test.ts` alongside the rest of the suite. The
tests cover: fingerprint formatting/parsing/dedup/sort, the health state
machine and closure gate, every scanner (including no-Confluence-link
detection, deferral detection, broken-link/rename suggestions, architecture
boundary violations, and issue hygiene's closure/reopen/duplicate/missing-
fingerprint cases), scan-scope selection (full vs. incremental), the state
store/lock/watermark primitives (including stale-lock reclamation and
corrupted-watermark recovery), the plan/apply classification and budget
enforcement, and full end-to-end orchestrator runs (lock contention,
consecutive-failure accounting, weekly-completeness tracking, and the
dry-run-by-default safety guarantee).
