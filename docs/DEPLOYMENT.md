# Deployment and promotion

This file defines the technical deployment flow. Business release/readiness approvals remain governed by Confluence; this document owns the mechanics.

## Deployment principle

GitHub Actions is the deployment orchestration layer. A human should normally configure an environment once in GitHub and then use reviewed workflows to propagate infrastructure, database, runtime configuration and application releases.

```text
GitHub Environment inputs
  ↓
GitHub Actions
  ├─ authenticate to GCP by OIDC/WIF
  ├─ Terraform plan/apply Cloudflare + GCP + Supabase
  ├─ apply versioned Postgres migrations
  ├─ build image → Artifact Registry
  ├─ create/update Secret Manager versions
  ├─ deploy Cloud Run/Jobs
  ├─ configure edge/origin routing
  └─ run acceptance checks / emit deployment evidence
```

## Environments

- `dev` — continuous integration/development environment. Automatic deploys from approved default-branch changes are acceptable once safe.
- `uat` — production-like pre-production / user acceptance environment. Use the same topology/security model as production where practical, with synthetic/sanitized data.
- `prod` — production. Strongest approvals, least privilege and rollback requirements.

The old environment name `staging` is deprecated; use `uat` for new infrastructure and workflows.

## Workflow permissions

A deployment workflow should request only the permissions it needs. GCP federation requires:

```yaml
permissions:
  contents: read
  id-token: write
```

Do not use a stored GCP service-account JSON key.

Provider tokens for Cloudflare/Supabase are read from the selected GitHub Environment and are available only to the deployment job that needs them.

## Suggested workflow decomposition

Keep workflows small enough to audit and rerun safely:

1. `infra-plan.yml`
   - select `dev|uat|prod`;
   - authenticate providers;
   - Terraform fmt/init/validate/plan;
   - publish plan artifact/summary;
   - no mutation.

2. `infra-apply.yml`
   - protected environment;
   - apply reviewed plan or regenerate immediately before apply;
   - output non-secret infrastructure IDs/URLs for downstream jobs.

3. `db-migrate.yml`
   - run versioned Postgres migrations with migration locking/version checks;
   - fail before application promotion on incompatible migration errors;
   - never expose DSNs/passwords in logs.

4. `build-release.yml`
   - `npm ci`, lint, typecheck, unit, build, E2E, dependency audit/CodeQL gates as applicable;
   - build immutable container;
   - push to Artifact Registry by commit SHA/digest.

5. `deploy-app.yml`
   - deploy exact image digest;
   - set non-secret runtime configuration;
   - reference GCP Secret Manager secrets;
   - deploy customer/admin/API/worker surfaces independently where practical.

6. `acceptance.yml`
   - health/readiness;
   - auth/tenant negative checks;
   - direct GCS upload path;
   - Pub/Sub/Tasks smoke;
   - Postgres/RLS smoke;
   - Cloudflare→origin routing and direct-origin bypass;
   - rollback readiness.

These may initially be combined, but logical phases and permissions should remain explicit.

## Configuration handling

See [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md).

### Non-secret values

GitHub Environment variables are the preferred human-managed source for environment-specific non-secret inputs. Terraform/deployment outputs should generate derived values so they are not duplicated manually.

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
4. Supabase project/settings;
5. Postgres migrations/RLS/roles;
6. GCP runtime/load-balancer resources;
7. application image deployment;
8. Cloudflare DNS/proxy/WAF/origin rules once origin is healthy;
9. acceptance/security tests.

Avoid switching public DNS to a new origin before the origin is deployed and tested.

## Database release rules

- Postgres is the application write authority.
- Migrations are forward-reviewed and versioned in Git.
- Prefer expand/migrate/contract changes for backwards compatibility.
- Application code must tolerate the migration ordering used during deployment.
- Do not application-dual-write to Snowflake as a migration technique.
- Snowflake migrations/CDC are absent unless the optional warehouse has been approved and activated.

## Promotion

Promote code by immutable commit/image digest, not by rebuilding independently for each environment where avoidable.

Preferred pattern:

```text
commit SHA
  ↓ build once
Artifact Registry image digest
  ↓ deploy
 dev → uat → prod
```

Environment-specific settings are injected at deployment time; the application artifact should remain identical.

## Rollback

Keep at least one known-good previous application release deployable. Rollback should:

- redeploy the previous image digest;
- preserve source evidence and database history;
- never automatically reverse a destructive database migration without an explicit tested procedure;
- keep infrastructure changes forward-fixable or revertible from reviewed Terraform;
- record the rollback as a deployment event/evidence item.

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
- production-equivalent acceptance tests.

Confluence owns whether the business/control readiness gate is approved; passing CI alone never constitutes enterprise readiness.
