# Deployment and promotion

This file defines the technical deployment flow. Business release/readiness approvals remain governed by Confluence; this document owns the mechanics.

## Deployment principle

GitHub Actions is the deployment orchestration layer. A human should normally configure an environment once in GitHub and then use reviewed workflows to propagate infrastructure, database, runtime configuration and application releases.

```text
GitHub Environment trust roots
  ↓
GitHub Actions
  ├─ authenticate to GCP by OIDC/WIF
  ├─ build reviewed main commit → Artifact Registry
  ├─ resolve release tag → immutable digest
  ├─ Terraform plan/apply Cloudflare + GCP + Supabase
  ├─ apply versioned Postgres migrations
  ├─ create/update Secret Manager versions
  ├─ deploy Cloud Run/Jobs by digest
  ├─ run acceptance checks / emit evidence
  └─ record accepted digest as known-good rollback target
```

## Environments

- `dev` — continuous integration/development environment. Automatic deploys from approved default-branch changes are acceptable once safe.
- `uat` — production-like pre-production / user acceptance environment. Use the same topology/security model as production where practical, with synthetic/sanitized data.
- `prod` — production. Strongest approvals, least privilege and rollback requirements.

The old environment name `staging` is deprecated; use `uat` for new infrastructure and workflows.

## Workflow permissions

A deployment workflow should request only the permissions it needs. GCP federation requires `contents: read` and `id-token: write`. Release-image provenance additionally uses GitHub artifact-attestation permissions. Do not use a stored GCP service-account JSON key.

Provider tokens for Cloudflare/Supabase are read from the selected GitHub Environment and are available only to the deployment job that needs them.

## Release-image build

`.github/workflows/build-release.yml` is the executable release-image boundary.

- It is manual/protected and fails unless invoked from `main`.
- It authenticates to the selected environment's GCP project through GitHub OIDC/WIF.
- It uses the deterministic Artifact Registry path `asia-southeast1-docker.pkg.dev/${GCP_PROJECT_ID}/corvis/api`.
- It builds the production Dockerfile once for that registry target and publishes only the source-addressable tag `git-${GITHUB_SHA}`; it does not use `latest` as a deployment contract.
- It resolves the registry-generated `sha256` digest after push and emits a `release-image.json` artifact containing source SHA, digest reference, build timestamp and workflow run ID.
- It generates GitHub build-provenance attestation for the exact container digest and pushes the attestation to the OCI registry.

Repository CI remains responsible for lint/type/unit/build/browser/security checks. A release image does not become production-approved merely because it was built or attested.

## Deployment selection

`.github/workflows/terraform-deploy.yml` no longer requires an operator-maintained `API_IMAGE` GitHub variable.

The operator selects one of two mutually exclusive immutable release sources:

1. `release_sha` — a full 40-character commit SHA previously published by `build-release.yml` into the target environment's Artifact Registry. The workflow resolves `git-${release_sha}` through Artifact Registry and passes Terraform the resulting `image@sha256:...` reference.
2. `rollback_known_good` — reads the target environment's acceptance-approved `known-good.json` manifest and deploys its exact digest.

The workflow refuses a mutable or malformed image reference. `uat`/`prod` Cloudflare activation still fails closed when no immutable API release is selected.

## Known-good rollback state

A build or Terraform apply is **not** enough to call a release known-good.

`security-acceptance.yml` records `gs://${GCP_PROJECT_ID}-corvis-tf-state/releases/${environment}/known-good.json` only after both independent live jobs succeed:

- edge/origin security acceptance; and
- live Postgres/RLS two-tenant acceptance.

The recorded manifest contains only non-secret release evidence: environment, exact deployed Artifact Registry digest, acceptance timestamp, workflow SHA and run ID. The Terraform state bucket is versioned, so prior manifests remain recoverable through object history.

If either acceptance job fails or is unavailable, known-good state is not advanced.

## Workflow decomposition

Current and target workflows remain intentionally auditable:

1. Terraform validation/planning — provider/IaC validation and reviewed plan.
2. Database migration — forward-only versioned Postgres replay with checksum/version checks.
3. `build-release.yml` — build/push/attest reviewed API image and emit release metadata.
4. `terraform-deploy.yml` — resolve selected release to digest and apply runtime/infrastructure changes.
5. `security-acceptance.yml` — live edge/origin + RLS checks and, only on full success, advance the known-good rollback manifest.

Customer/admin/worker release boundaries should reuse the same immutable-release contract when those distinct runtimes are added rather than sharing a mutable application tag.

## Configuration handling

See [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md).

### Non-secret values

GitHub Environment variables are the preferred human-managed source for environment-specific external roots. Terraform/deployment outputs should generate derived values so they are not duplicated manually.

### Deployment-only provider credentials

`CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN` and similar provider-management credentials are consumed only by CI/IaC jobs. They must not be injected into application runtime containers.

### Runtime secrets

Cloud Run/Jobs should consume GCP Secret Manager references. The deployment workflow may create/rotate a secret version from a GitHub bootstrap secret where unavoidable, but internal runtime secrets should preferably be generated/rotated automatically rather than copied between stores manually.

## Secret propagation pattern

For a secret that must originate in GitHub:

1. read the GitHub Environment secret inside a protected deployment job;
2. authenticate to GCP with WIF;
3. create/update the named Secret Manager secret/version without printing the value;
4. bind only the required runtime service account to that secret;
5. deploy Cloud Run/Job with a Secret Manager reference;
6. rotate/remove superseded versions according to the secret-retention policy.

Do not persist secret values in Terraform source, workflow artifacts, action outputs or deployment summaries. Avoid putting secret values into Terraform state when a provider-independent secret-version step can safely manage them outside Terraform.

## Infrastructure apply order

Recommended dependency order:

1. trust/bootstrap already exists (GCP WIF, provider account ownership);
2. Terraform state/backend;
3. GCP APIs/IAM/KMS/Artifact Registry/GCS/queues/secrets containers;
4. release image is built, pushed and attested;
5. Supabase project/settings;
6. Postgres migrations/RLS/roles;
7. GCP runtime/load-balancer resources deploy the selected image digest;
8. Cloudflare DNS/proxy/WAF/origin rules once origin is healthy;
9. acceptance/security tests;
10. successful acceptance advances the known-good rollback digest.

Avoid switching public DNS to a new origin before the origin is deployed and tested.

## Database release rules

- Postgres is the application write authority.
- Migrations are forward-reviewed and versioned in Git.
- Prefer expand/migrate/contract changes for backwards compatibility.
- Application code must tolerate the migration ordering used during deployment.
- Do not application-dual-write to Snowflake as a migration technique.
- Snowflake migrations/CDC are absent unless the optional warehouse has been approved and activated.

## Promotion

Promote code by immutable commit/image digest, not by a mutable tag. The current workflow resolves a reviewed commit tag to a digest inside the target environment's Artifact Registry before Terraform sees it.

The longer-term preferred topology remains build-once promotion of the identical digest across `dev → uat → prod`. If environment registries live in separate GCP projects, cross-project copy/reader permissions must be implemented explicitly before claiming that one physical registry artifact is promoted across all three environments; the current workflow does not silently assume such trust exists.

## Rollback

Keep at least one acceptance-approved previous application release deployable. `terraform-deploy.yml` supports `rollback_known_good=true`, which reads the exact digest recorded by the most recent fully successful live Security acceptance run.

Rollback must:

- redeploy an acceptance-approved image digest;
- preserve source evidence and database history;
- never automatically reverse a destructive database migration without an explicit tested procedure;
- keep infrastructure changes forward-fixable or revertible from reviewed Terraform;
- retain the acceptance/deployment evidence identifying what was restored.

Use feature flags/kill switches for risky product behavior when they are the safer rollback mechanism, but do not use flags to bypass authorization or contractual rights.

## Preview environments

Preview environments are optional and must remain cheap:

- scale-to-zero services;
- no dedicated load balancer per preview;
- no production data or secrets;
- auto-destroy within 24 hours of PR merge/close or inactivity;
- prefer shared non-production services when isolation risk is acceptable.

## Production release gate

At minimum, production promotion must have passing repository checks and environment acceptance checks. Current source gates include:

- deterministic dependency install;
- lint/type/unit/build;
- critical-path browser E2E;
- dependency vulnerability gate;
- CodeQL;
- Terraform formatting/validation for implemented roots;
- reviewed database migrations;
- immutable digest resolution and build provenance;
- production-equivalent acceptance tests.

Confluence owns whether the business/control readiness gate is approved; passing CI or producing an attestation alone never constitutes enterprise readiness.
