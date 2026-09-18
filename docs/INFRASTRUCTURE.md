# Infrastructure and deployment architecture

This file is the technical source of truth for Corvis infrastructure implementation. Business-level technology decisions and readiness requirements remain in Confluence.

## Production topology

```text
Internet
  ↓
Cloudflare — authoritative DNS / TLS / CDN / DDoS / WAF / rate controls
  ↓ authenticated origin path
Shared GCP external HTTPS load balancer
  ↓
Cloud Run — customer web / admin web / API
  ├─ Cloud Run Jobs / workers
  ├─ Pub/Sub / Cloud Tasks / Cloud Scheduler
  ├─ GCS — immutable source + replayable artifacts
  ├─ Secret Manager / KMS
  ├─ Cloud Logging / Monitoring / Trace
  └─ Supabase Postgres — Singapore
       ├─ control and operational state
       ├─ canonical / curated state
       ├─ RLS and tenant-safe serving
       └─ search / pgvector where justified
              ↓ optional downstream replication only after approval
          Snowflake analytics / secure sharing
```

## Infrastructure principles

1. **Git is the implementation authority.** Terraform, migrations and deployment workflows are reviewed and versioned in this repository.
2. **GitHub Actions is the deployment/configuration control plane.** Human-entered deployment inputs should live in GitHub Environment variables/secrets for `dev`, `uat` and `prod`; workflows propagate configuration to providers.
3. **GitHub is not the runtime secret store.** Runtime secrets are copied/generated into GCP Secret Manager and referenced by Cloud Run/Jobs. Provider credentials needed only during deployment are consumed transiently by GitHub Actions.
4. **Use federation before long-lived credentials.** GCP deployment uses GitHub OIDC → Workload Identity Federation. Do not create or store GCP service-account JSON keys in GitHub.
5. **One structured write authority.** Supabase Postgres is the application/control/canonical write authority. Snowflake, if enabled, is downstream only.
6. **Immutable evidence is separate.** Accepted source documents and retained replay artifacts remain in GCS.
7. **Scale to zero by default.** Cloud Run minimum instances are zero unless an observed SLO justifies otherwise.
8. **No console as source of truth.** Manual provider-console changes are break-glass and must be reconciled into Terraform/migrations immediately.
9. **No Corvis-managed AWS by default.** A vendor being hosted on AWS does not justify an AWS account/provider unless Corvis directly provisions AWS resources.

## Environment model

The canonical environments are `dev`, `uat`, and `prod`.

```text
infra/terraform/environments/
  dev/
  uat/
  prod/
```

Each environment must have isolated provider resources and credentials. Production customer data must never be copied into `dev`; `uat` uses synthetic or explicitly sanitized data.

### Environment isolation

- Prefer separate GCP projects for `dev`, `uat`, and `prod` once production is being provisioned.
- Use separate Supabase projects/databases per environment.
- Use separate Cloudflare environment hostnames and environment-scoped tokens where practical.
- Use separate GitHub Environment variables/secrets; never reuse a production runtime secret in `dev` or `uat`.
- Production approval/protection rules should be stricter than `dev`/`uat`.

## Terraform ownership

Target repository layout:

```text
infra/terraform/
  modules/
    cloudflare/
    gcp/
    supabase/
    snowflake/        # optional; instantiate only after activation decision
  environments/
    dev/
    uat/
    prod/

db/
  postgres/
    migrations/
    replication/     # only if downstream CDC is activated
  snowflake/         # optional downstream analytics/sharing
```

Use Terraform for provider/resource configuration where supported. Keep PostgreSQL DDL, constraints, indexes, extensions, RLS, database roles/functions and replication publication/identity in reviewed SQL migrations.

## GCP

### Baseline services

- Cloud Run / Cloud Run Jobs
- External HTTPS load balancer shared across relevant origins
- GCS Singapore source/artifact buckets
- Pub/Sub
- Cloud Tasks
- Cloud Scheduler
- Secret Manager
- Cloud KMS
- Artifact Registry
- Cloud Logging / Monitoring / Trace
- Identity Platform where used for authentication

### Identity

GitHub Actions authenticates to GCP with OIDC Workload Identity Federation. Runtime services use dedicated service accounts and workload identity. Avoid long-lived service-account keys.

### GCS

Accepted source evidence is private, versioned and protected from public access. Source upload is direct browser → GCS resumable upload after a Corvis authorization/initiation request; Cloudflare and the API must not proxy ordinary multi-GB source bodies.

Suggested lifecycle defaults:

- abandoned upload/quarantine scratch: 1–7 days;
- rebuildable intermediate/render/export artifacts: normally 30 days;
- retained source evidence: governance/legal/contractual retention, not cost-driven deletion.

### Artifact Registry

Keep deployed images, one known-good rollback and a bounded recent history. Delete untagged/unreferenced images after roughly 7 days and avoid retaining unlimited historical images.

### Secret Manager

Runtime secrets belong in Secret Manager. Keep the current version plus at most one rollback version during rotation; destroy superseded secret values after the approved successful-rotation window unless recovery requires longer. Disabled old versions should not be treated as free archival storage.

## Cloudflare

Cloudflare is the public-edge provider. Manage zone/DNS/proxy/TLS/WAF/rate-limit/cache/origin-protection configuration with Terraform where supported.

Rules:

- cache only explicitly safe public/static responses;
- authenticated customer/admin/API responses must not leak across tenants through cache keys or shared caching;
- block/directly test origin bypass;
- do not store customer source documents in Cloudflare as the source of truth;
- Turnstile is appropriate for public abuse-prone surfaces but is not an authorization mechanism.

The Cloudflare API token is an environment-scoped GitHub secret because Terraform requires provider authorization and there is no equivalent GCP-style GitHub federation baseline for this repository.

## Supabase/Postgres

Supabase Postgres Singapore is the primary structured data platform. The application writes only to Postgres. Project/settings resources may be Terraform-managed where supported; database objects are managed through SQL migrations.

Production uses a paid backup-capable tier. Free projects are suitable only for disposable development/prototypes and never production customer data.

Do not adopt Supabase Storage/Auth/Realtime/Edge Functions automatically. GCS, Identity Platform, Cloud Run and Pub/Sub remain the baseline unless a documented simplification justifies a change.

## Snowflake

Snowflake is absent initially unless a business/customer/workload activation trigger is approved. When enabled, it is downstream analytics/secure sharing only. Postgres remains authoritative and Snowflake failure must not block application transactions.

See [`DATA_PLATFORM.md`](DATA_PLATFORM.md).

## Retention / cost controls

- Cloud Run min instances: zero by default.
- PR/preview environments: destroy within 24 hours of merge/close or inactivity.
- Avoid one load balancer per preview/service.
- Bound Artifact Registry, Secret Manager, transient GCS and log retention.
- Prefer managed/serverless services before always-on infrastructure.
- Keep Snowflake spend at zero until an activation trigger is approved.
- Cost alerts and budgets are infrastructure code / deployment concerns; business spending thresholds remain governed in Confluence.

## Deployment responsibility

GitHub Actions should perform the following from reviewed code:

1. authenticate to GCP via OIDC/WIF;
2. consume Cloudflare/Supabase provider tokens from GitHub Environment secrets;
3. run Terraform plan/apply for the selected environment;
4. run database migrations in controlled order;
5. build immutable application images and push to Artifact Registry;
6. create/update GCP Secret Manager secret versions from approved GitHub bootstrap secrets or generated deployment secrets when required;
7. deploy Cloud Run/Jobs referencing Secret Manager, not plaintext workflow output;
8. run environment acceptance tests;
9. publish deployment/evidence metadata.

See [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md) and [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Bootstrap exceptions

A few items cannot safely cascade from GitHub before trust exists. They are one-time external bootstrap actions, not ongoing configuration sources:

- ownership/billing for the GCP organization/projects or bootstrap project;
- initial GCP Workload Identity Pool/provider and deploy-service-account trust granting GitHub OIDC permission;
- domain registration and account ownership/billing for Cloudflare;
- creation/ownership/billing of the Supabase organization and generation of its management token;
- creation of GitHub Environments and entering their variables/secrets;
- third-party account/billing/contract setup where an API cannot safely bootstrap ownership.

After bootstrap, infrastructure/configuration changes should flow from GitHub whenever the provider supports it.
