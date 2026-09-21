# Deployment and promotion

This file is the technical source of truth for Corvis deployment mechanics. Confluence owns business readiness and launch approval.

## Principle

After the one-time external trust bootstrap, GitHub Actions is the deployment control plane. Routine environment changes do not require local `gcloud`, Terraform or manual provider-console edits.

```text
reviewed PR -> protected main -> immutable release images + provenance
  -> GitHub OIDC/WIF
  -> Terraform plan
  -> Postgres secret readiness
  -> checksum-verified forward migrations + evidence
  -> exact Terraform apply
       ├─ Cloud Run API
       ├─ IAM-private Cloud Run worker
       ├─ Pub/Sub push + DLQ
       ├─ Cloud Tasks retry
       ├─ Cloud Scheduler delivery drain
       ├─ scheduled control-loop Cloud Run Jobs + durable state
       ├─ API Gateway
       └─ Cloudflare Worker/DNS/WAF/rate controls
  -> public health
  -> edge + RLS + control-loop live acceptance
  -> accepted release set recorded as known-good
```

## Environments

- `dev` — disposable/low-cost development environment; no production customer data.
- `uat` — separate production-like environment using synthetic or explicitly sanitized data.
- `prod` — production environment with the strongest provider and release protections.

`staging` is deprecated; use `uat`.

## Release images

`.github/workflows/build-release.yml` is the image boundary. It runs only from protected `main`, verifies release governance, authenticates through GitHub OIDC/WIF, and emits GitHub provenance attestations.

For a source commit it builds:

- `corvis/api:git-${GITHUB_SHA}` — shared immutable API/worker application image;
- `corvis/control-loop:git-${GITHUB_SHA}` — purpose-built repository-scanner image used only by the scheduled control-loop jobs.

Both tags are immediately resolved to immutable digests and captured in `release-image.json`. A production-like promotion resolves both images from the same reviewed source commit. A built image set is not known-good until live acceptance passes.

The current builder publishes into the selected environment registry. If UAT and prod use separate GCP projects/registries, **strict build-once cross-project promotion remains a separate #13 item**: copy/promote the already-built physical image or use explicit bounded cross-project reader trust and verify the digest. Rebuilding the same source commit independently is not proof of byte-identical promotion.

## Promotion inputs

`.github/workflows/promote-environment.yml` is the normal operator entry point for `uat` and `prod`. It accepts exactly one of:

1. `release_sha` — a full reviewed `main` commit whose release images already exist in the target registry; or
2. `rollback_known_good=true` — the last acceptance-approved release set for that environment.

The workflow itself must be dispatched from `main`.

The lower-level `terraform-deploy.yml` remains directly dispatchable for plans/diagnostics and `security-acceptance.yml` remains directly rerunnable for acceptance. Both are reusable workflows consumed by the governed promotion path.

Runtime removal is never an accidental side effect of an empty release input; use `gcp-decommission.yml` for lifecycle changes.

## One auditable promotion path

A normal production-like promotion performs this ordered graph:

1. validate `main`, target environment and release selection;
2. verify live GitHub release governance;
3. authenticate through WIF and require the bootstrap-owned remote state bucket;
4. resolve the API/worker and control-loop image tags to immutable digests;
5. validate Terraform and produce the exact locked plan;
6. require the enabled canonical Postgres DSN secret;
7. apply versioned forward-only migrations and retain sanitized evidence;
8. apply the exact Terraform plan;
9. verify public API health when the edge is enabled;
10. run live edge/IAM/worker acceptance, two-tenant Postgres/RLS acceptance and scheduled control-loop runtime acceptance;
11. only when all acceptance families pass, record the accepted API/worker + control-loop image set in `known-good.json`;
12. complete the parent promotion run.

A failed deploy never starts acceptance. Failed or incomplete acceptance never advances known-good.

## Runtime topology

### API and worker

- `corvis-api-${environment}` — customer/API backend; only the dedicated API Gateway identity has `roles/run.invoker`.
- `corvis-worker-${environment}` — background processing/delivery; only the dedicated worker identity has `roles/run.invoker`.

Managed asynchronous transport is keyless:

- Pub/Sub pushes immediate stage work to `/api/internal/processing-stage` using Google OIDC;
- Cloud Tasks schedules persisted retries to the same worker boundary;
- Cloud Scheduler calls `/api/internal/delivery` to drain durable processing/export/webhook outboxes;
- no production `CORVIS_WORKER_SECRET` is required.

### Continuous control loop

UAT/prod also provision a dedicated keyless identity `corvis-control-loop-${environment}` plus a private, uniform-access, public-access-prevented, versioned GCS state bucket. The identity has object administration only on that state bucket and logging permission; it does not inherit API/worker data-plane roles.

Three Cloud Run Jobs share the accepted `corvis/control-loop@sha256:...` image:

- daily — `02:17 Asia/Singapore`;
- weekly — Sunday `03:23 Asia/Singapore`;
- monthly candidate — Sunday `04:31 Asia/Singapore`; the application resolves it to monthly only when Singapore day-of-month is 1–7, otherwise it performs the weekly mode.

Cloud Scheduler invokes the Cloud Run Jobs API with an OAuth token for the control-loop identity. Each job is granted only its required `roles/run.invoker` binding. The job runs in dry-run/read-only mode today; no remediator or GitHub/Confluence write integration is enabled.

The production state adapter stores watermark, lock and sanitized latest run reports in GCS. Lock acquisition uses Cloud Storage object-generation preconditions, so overlapping job executions cannot both acquire the mutation lease. The existing GitHub Actions scheduler remains a build-phase/read-only bootstrap until provider activation; it must not be promoted to a parallel mutation path.

Customer-web/admin-web runtime separation remains a separate #10/#13 item and must be implemented together with real application-level surface boundaries. Extra Cloud Run service names around the same unrestricted application would not create a meaningful security boundary.

## Authentication and secrets

Production OIDC bearer tokens are verified directly against the configured issuer/JWKS and audience. Tenant/workspace headers remain untrusted selectors; effective membership, roles, entitlements, data rights and session state are re-resolved from Postgres.

- GCP provider access uses WIF, never JSON keys.
- `corvis-postgres-dsn-${environment}` is the canonical runtime database secret.
- API, worker, migration and live acceptance consume that same managed DSN through IAM.
- The control loop does not receive the Postgres DSN or API/worker identities.
- The API Gateway edge key is Terraform-generated and restricted to the managed API.
- Provider-management credentials such as the scoped Cloudflare token are deployment-only and are never injected into runtime containers.

## Acceptance and known-good state

`security-acceptance.yml` covers at least:

- Cloudflare/API Gateway traversal and direct-bypass negatives;
- exact API and worker invoker IAM;
- Pub/Sub/Scheduler authenticated worker transport;
- live two-tenant Postgres/RLS isolation;
- all three control-loop Cloud Run Jobs pinned to one immutable control-loop digest;
- exact Singapore schedules and OAuth scheduler identity;
- private/versioned control-loop state bucket and bounded bucket IAM;
- automated sanitized evidence persistence.

Only a fully successful acceptance run writes:

`gs://${GCP_PROJECT_ID}-corvis-tf-state/releases/${environment}/known-good.json`

The manifest contains both the accepted API/worker image and accepted control-loop image. Rollback redeploys that accepted set, then reruns live acceptance before completing.

Database rollback remains forward-safe: routine release rollback never silently reverses a migration or rewrites source/canonical history. Use expand/migrate/contract changes, feature kill switches, or the incident recovery process as appropriate.

## Infrastructure lifecycle

`gcp-decommission.yml` is the only normal teardown path:

- `idle` removes runtime/public-edge resources while retaining durable foundations, data and Terraform state;
- `full` explicitly removes Terraform-managed data/resources and deletes remote state last while retaining the recoverable KMS/bootstrap trust anchors defined by the lifecycle contract.

Control-loop Cloud Run Jobs follow the same decommission switch. Their state bucket is durable foundation state and is purgeable only through explicit full decommission.

## External/provider-bound activation

Before first UAT apply, operators still need the external trust roots the repository cannot create for itself:

- billed GCP project, `corvis-deploy` service account and repository-scoped WIF trust;
- Cloudflare zone/account ownership and scoped token;
- separate production-like Postgres/Supabase environment and secure DSN activation;
- approved OIDC/SAML provider configuration;
- any optional AI/search/representation/extraction/delivery provider selected for the UAT journey.

Those are bootstrap inputs, not an ongoing manual deployment model.

## Release gate

Repository CI requires deterministic install, lint, TypeScript, unit tests, production build, browser E2E, dependency audit, CodeQL, public-repository leak/history checks, non-root API and control-loop container validation, clean Postgres migration application, and Terraform formatting/provider validation. Passing repository CI proves the reviewed source contract; production readiness still requires provider-backed UAT evidence and the open Confluence/GitHub readiness gates.
