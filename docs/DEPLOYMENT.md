# Deployment and promotion

This file is the technical source of truth for Corvis deployment mechanics. Confluence owns business readiness and launch approval.

## Principle

After the one-time external trust bootstrap, GitHub Actions is the deployment control plane. Routine Corvis environment changes do not require local `gcloud`, Terraform or manual provider-console edits.

```text
reviewed PR -> protected main -> immutable image + provenance
  -> GitHub OIDC/WIF
  -> Terraform plan
  -> Postgres secret readiness
  -> checksum-verified forward migrations + evidence
  -> exact Terraform apply
       ├─ Cloud Run API
       ├─ IAM-private Cloud Run worker
       ├─ Pub/Sub push + DLQ
       ├─ Cloud Tasks scheduled retry
       ├─ Cloud Scheduler delivery drain
       ├─ API Gateway
       └─ Cloudflare Worker/DNS/WAF/rate controls
  -> public health
  -> live security/RLS acceptance
  -> accepted digest recorded as known-good
```

## Environments

- `dev` — disposable/low-cost development environment; no production customer data.
- `uat` — separate production-like environment using synthetic or explicitly sanitized data.
- `prod` — production environment with the strongest provider and release protections.

`staging` is deprecated; use `uat`.

## Release image

`.github/workflows/build-release.yml` is the image boundary.

- Runs only from `main`.
- Verifies effective release governance before provider authentication.
- Authenticates to GCP through GitHub OIDC/WIF; no static GCP key exists.
- Publishes `git-${GITHUB_SHA}` to `asia-southeast1-docker.pkg.dev/${GCP_PROJECT_ID}/corvis/api`.
- Resolves and records the immutable registry digest.
- Emits `release-image.json` and GitHub build-provenance attestation.
- The same immutable image is used by the API and private worker runtime for that environment.

A built image is not a known-good production release until live acceptance passes.

The current release builder publishes into the selected environment registry. When Corvis uses separate GCP projects/registries for environments, strict build-once cross-project copying of an already-built physical digest remains a separate activation hardening item; do not claim rebuilds of the same source commit are byte-identical promotion.

## Promotion inputs

`.github/workflows/promote-environment.yml` is the normal operator entry point for production-like `uat` and `prod` promotion. It accepts either:

1. `release_sha` — full reviewed `main` commit already built in the target environment registry; or
2. `rollback_known_good=true` — the last acceptance-approved digest for that environment.

They are mutually exclusive, and exactly one is required. The workflow itself must be dispatched from `main`.

The lower-level `.github/workflows/terraform-deploy.yml` remains directly dispatchable for Terraform plans, diagnostics and explicitly controlled lower-level operations. `.github/workflows/security-acceptance.yml` remains directly dispatchable when acceptance needs to be rerun without a new deployment. Both are also reusable workflows consumed by the governed promotion path.

Runtime removal is never an accidental side-effect of an empty release input; use the guarded decommission workflow for lifecycle changes.

Before a production-like runtime can be promoted, the environment must also have:

- `CORVIS_AUTH_ISSUER` and `CORVIS_AUTH_AUDIENCE` configured as the approved OIDC contract;
- an enabled `corvis-postgres-dsn-${environment}` Secret Manager version written by the environment Postgres activation path;
- Cloudflare roots when public API publication is enabled.

See [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md).

## One auditable promotion path

For a normal `uat` or `prod` promotion, `promote-environment.yml` executes one ordered GitHub Actions graph:

1. validate that the request comes from `main`, targets only `uat`/`prod`, and selects exactly one release source;
2. call `terraform-deploy.yml` with `action=apply`;
3. complete release-governance verification, WIF authentication, remote-state validation, immutable release resolution, Terraform plan, Postgres secret readiness, live migrations with retained evidence, exact Terraform apply and public health;
4. only after deployment succeeds, call `security-acceptance.yml`;
5. run edge/IAM/worker-transport acceptance and live Postgres/RLS acceptance;
6. advance the environment known-good pointer only when both acceptance families succeed;
7. complete the parent promotion run only after the acceptance workflow and known-good recording succeed.

This creates one top-level promotion audit trail while preserving the detailed migration, infrastructure and security evidence in the called workflows. A failed deployment never starts acceptance, and failed acceptance never advances known-good.

For the deployment phase specifically, `terraform-deploy.yml` executes this order:

1. verify the release commit is on `main` and the live ruleset/check governance is non-bypassable;
2. authenticate through WIF;
3. require the bootstrap-owned remote state bucket;
4. resolve the selected release to an immutable digest;
5. initialize/validate Terraform and create the exact locked plan;
6. require an enabled Postgres DSN secret version;
7. read that DSN through IAM without logging it;
8. run `db/postgres/migrate.ts --apply` against the live environment;
9. upload sanitized migration evidence;
10. apply the exact previously created Terraform plan;
11. when the edge is enabled, require `/api/v1/health` to succeed through Cloudflare -> API Gateway -> Cloud Run.

The migration runner is forward-only, gap/checksum aware and records its own `corvis_migration.schema_migration` ledger. Re-running an already-current environment is a no-op for migration SQL.

## Runtime topology

The promoted immutable image currently feeds two distinct runtime identities:

- `corvis-api-${environment}` — public API backend, invokable only by the dedicated API Gateway service account;
- `corvis-worker-${environment}` — background-processing/delivery runtime, invokable only by its dedicated worker service account.

Managed asynchronous transport is keyless:

- Pub/Sub pushes immediate stage deliveries to `/api/internal/processing-stage` using Google OIDC;
- Cloud Tasks schedules persisted retries to the same endpoint using the worker identity;
- Cloud Scheduler calls `/api/internal/delivery` to drain durable processing/export/webhook outboxes;
- the worker Cloud Run service uses an explicit custom OIDC audience derived from the environment;
- no production `CORVIS_WORKER_SECRET` is required.

The API uses the same worker identity only to enqueue authenticated scheduled retries; it cannot anonymously invoke the worker.

A dedicated production Cloud Scheduler -> Cloud Run Job boundary for the continuous business/control loop remains separate from this request-serving worker and is still required before the first production customer. Customer-web/admin-web runtime separation must likewise be implemented together with application-level surface boundaries; merely deploying the same unrestricted Next.js image under extra service names would not create a meaningful security boundary.

## Authentication boundary

Production OIDC bearer tokens are verified directly against the configured issuer/JWKS and audience. Tenant/workspace headers are untrusted context selectors only; effective membership, roles, entitlements, data rights and session state are re-resolved from Postgres before authorization.

The signed Corvis gateway-assertion contract remains available for a future reviewed SAML/identity broker, but OIDC production does not depend on deploying an assertion-minting proxy first.

## Secret handling

- GCP provider access uses WIF, not JSON keys.
- The canonical application database secret is `corvis-postgres-dsn-${environment}` in Secret Manager.
- API, worker, migration and Security-acceptance paths consume that same managed value through IAM.
- The API Gateway edge key is Terraform-generated, restricted to the managed API and injected directly into the Cloudflare Worker secret binding.
- Do not duplicate DSNs, worker secrets, gateway keys or provider-derived runtime URLs into GitHub variables.

Provider-management credentials such as the scoped Cloudflare API token are deployment-only and are never injected into application containers.

## Acceptance and known-good state

`security-acceptance.yml` runs production-like provider checks after deployment. The harness covers at least:

- Cloudflare Worker traversal, HTTPS/WAF/rate/cache controls;
- missing/invalid direct API Gateway edge-key rejection;
- direct unauthenticated API Cloud Run rejection and exact gateway-only invoker IAM;
- direct unauthenticated worker rejection and exact worker-only invoker IAM;
- Pub/Sub/Scheduler targets and OIDC identity/audience wiring;
- live two-tenant Postgres/RLS isolation;
- automated evidence persistence.

Only a fully successful acceptance run records:

`gs://${GCP_PROJECT_ID}-corvis-tf-state/releases/${environment}/known-good.json`

If acceptance fails or cannot run, the known-good pointer does not advance.

## Rollback

`rollback_known_good=true` through `promote-environment.yml` redeploys the last accepted immutable image and then reruns live acceptance before the promotion completes. Rollback must preserve database/source history and never silently reverse a forward database migration.

Use expand/migrate/contract database changes and feature kill switches where they are safer than destructive schema reversal. A database restore is an incident-recovery procedure, not routine application rollback.

## Infrastructure lifecycle

Environment teardown is owned exclusively by `.github/workflows/gcp-decommission.yml`:

- `idle` removes API/worker/public-edge runtime while preserving durable foundation, data and Terraform state;
- `full` explicitly removes Terraform-managed data/resources and deletes remote state last, while retaining the recoverable KMS bootstrap anchor and external WIF trust anchor.

Destructive transitions require exact confirmation strings. See [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md).

## What remains external/provider-bound

The repository cannot safely bootstrap ownership of an otherwise untrusted provider account. Before the first UAT apply, operators still must establish:

- billed GCP project + `corvis-deploy` service account + repository-scoped WIF trust;
- Cloudflare zone/account ownership and scoped Terraform token;
- separate Supabase/Postgres environment project and secure DSN activation;
- approved OIDC/SAML provider configuration;
- any optional external AI/search/representation/extraction/delivery provider chosen for the UAT journey.

Those roots are environment activation inputs, not excuses for ongoing undocumented manual deployment.

## Release gate

Repository CI requires deterministic install, lint, TypeScript, unit tests, production build, browser E2E, dependency audit, CodeQL, secret/history guard, non-root container assertion, clean Postgres migration application and Terraform formatting/provider validation. Passing those checks proves the reviewed source contract; production readiness still requires the live provider/UAT evidence owned by Confluence and the open readiness trackers.
