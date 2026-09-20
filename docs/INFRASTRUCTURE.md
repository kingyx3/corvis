# Infrastructure and deployment architecture

This file is the technical source of truth for Corvis infrastructure implementation. Business-level technology decisions and readiness requirements remain in Confluence.

## Production topology

```text
Internet
  ↓
Cloudflare — authoritative DNS / TLS / CDN / DDoS / WAF / rate controls
  ↓ Worker injects edge-only restricted API key
Google API Gateway — usage-priced managed ingress
  ↓ dedicated Google service-account identity
Cloud Run — IAM-private API runtime, no allUsers invoker, scale-to-zero
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

Large source documents do not traverse Cloudflare Worker or API Gateway. The API authorizes/initiates the upload and the browser/client writes the source bytes directly to GCS using the native resumable-upload path.

## Infrastructure principles

1. **Git is the implementation authority.** Terraform, migrations and deployment workflows are reviewed and versioned in this repository.
2. **GitHub Actions is the deployment/configuration control plane.** Human-entered deployment inputs should live in GitHub Environment variables/secrets for `dev`, `uat` and `prod`; workflows propagate configuration to providers.
3. **GitHub is not the runtime secret store.** Runtime secrets are copied/generated into GCP Secret Manager and referenced by Cloud Run/Jobs. Provider credentials needed only during deployment are consumed transiently by GitHub Actions.
4. **Use federation before long-lived credentials.** GCP deployment uses GitHub OIDC → Workload Identity Federation. Do not create or store GCP service-account JSON keys in GitHub.
5. **Prefer workload identity over network-location trust.** The API Gateway service account is the only normal public-path Cloud Run invoker. Cloud Run must not grant `roles/run.invoker` to `allUsers`.
6. **One structured write authority.** Supabase Postgres is the application/control/canonical write authority. Snowflake, if enabled, is downstream only.
7. **Immutable evidence is separate.** Accepted source documents and retained replay artifacts remain in GCS.
8. **Scale to zero by default.** Cloud Run minimum instances are zero unless an observed SLO justifies otherwise.
9. **No console as source of truth.** Manual provider-console changes are break-glass and must be reconciled into Terraform/migrations immediately.
10. **No Corvis-managed AWS by default.** A vendor being hosted on AWS does not justify an AWS account/provider unless Corvis directly provisions AWS resources.

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

Current public API modules are:

```text
infra/terraform/
  modules/
    gcp-foundation/       # services, IAM identities, GCS, queues, registry, KMS
    cloud-run-runtime/    # API runtime and runtime secret references
    gcp-api-gateway/      # API Gateway, restricted edge API key, gateway identity
    cloudflare-edge/      # Worker, route, DNS, WAF, rate limit, cache policy
    gcp-observability/    # alerts, dashboard, optional billing budget
  environments/
    dev/
    uat/
    prod/

db/
  postgres/
    migrations/
    replication/          # only if downstream CDC is activated
  snowflake/              # optional downstream analytics/sharing
```

The previous `gcp-serverless-origin` load-balancer / Cloud Armor module has been removed from the baseline implementation.

Use Terraform for provider/resource configuration where supported. Keep PostgreSQL DDL, constraints, indexes, extensions, RLS, database roles/functions and replication publication/identity in reviewed SQL migrations.

## GCP

### Baseline services

- Cloud Run / Cloud Run Jobs
- API Gateway + API Keys for the production-like public API ingress
- GCS Singapore source/artifact buckets
- Pub/Sub
- Cloud Tasks
- Cloud Scheduler where required
- Secret Manager
- Cloud KMS
- Artifact Registry
- Cloud Logging / Monitoring / Trace
- Identity Platform where used for authentication

A GCP External Application Load Balancer and Cloud Armor are not baseline services merely to front Cloud Run. Add them only if a documented network-layer, customer, regulatory, or service-capability requirement cannot be met by the gateway/IAM design.

### Identity

GitHub Actions authenticates to GCP with OIDC Workload Identity Federation. Runtime services use dedicated service accounts and workload identity. Avoid long-lived service-account keys.

For the public API path:

- Terraform creates `corvis-gateway-${environment}` as a keyless service account;
- API Gateway uses that identity for backend authentication;
- Cloud Run grants `roles/run.invoker` only to that service account on the API service;
- the API Gateway service agent can mint tokens for that gateway identity;
- the GitHub deploy identity can attach the gateway identity to API configs;
- direct unauthenticated `run.app` calls are expected to fail IAM authorization.

Cloud Run uses `INGRESS_TRAFFIC_ALL` because API Gateway is not classified as Cloud Run internal ingress. This is intentional: IAM, not public network reachability, is the invocation boundary.

### API Gateway

`modules/gcp-api-gateway` owns the production-like API gateway.

The gateway transport specification is deliberately narrower than the business OpenAPI contract: it exposes the `/api/v1` surface, requires an API key at the gateway boundary, and forwards to the Cloud Run service using the dedicated gateway service account. Application authentication/tenant authorization remains authoritative behind the gateway.

Terraform creates a Google API key restricted to the generated Corvis managed API. That key is passed directly to the Cloudflare module as a sensitive Terraform value and becomes a Worker `secret_text` binding. It is not a human-managed GitHub secret or user credential.

### GCS

Accepted source evidence is private, versioned and protected from public access. Source upload is direct browser → GCS resumable upload after a Corvis authorization/initiation request; Cloudflare and API Gateway must not proxy ordinary multi-GB source bodies.

Approved portal/data-room connectors write acquired documents into the same GCS ingestion/document-registration path as customer uploads. They must not create a parallel source lake or extraction path. See [`SOURCE_CONNECTORS.md`](SOURCE_CONNECTORS.md).

Suggested lifecycle defaults:

- abandoned upload/quarantine scratch: 1–7 days;
- rebuildable intermediate/render/export artifacts: normally 30 days;
- retained source evidence: governance/legal/contractual retention, not cost-driven deletion.

### Artifact Registry

Keep deployed images, one known-good rollback and a bounded recent history. Delete untagged/unreferenced images after roughly 7 days and avoid retaining unlimited historical images.

### Secret Manager

Runtime secrets belong in Secret Manager. Keep the current version plus at most one rollback version during rotation; destroy superseded secret values after the approved successful-rotation window unless recovery requires longer. Disabled old versions should not be treated as free archival storage.

Customer-provided credentials/tokens for approved GP portals, data rooms or source repositories are runtime tenant secrets, not GitHub deployment secrets. Store them in Secret Manager with tenant/connection-scoped references and least-privilege access; Postgres stores connection metadata and the secret reference, never plaintext credential material.

### Source connector workers

Automated source acquisition should normally run in isolated Cloud Run Jobs/workers using dedicated service identities and durable scheduling/retry state. Prefer provider APIs/OAuth; use browser automation only for reviewed connectors where the customer is authorized and the source permits the automation. Never bypass MFA, CAPTCHA or source access controls. Connector-acquired files enter the standard GCS integrity/quarantine/document-registration pipeline before downstream extraction.

See [`SOURCE_CONNECTORS.md`](SOURCE_CONNECTORS.md) for credential setup, connector isolation, source lineage and browser-automation rules.

## Cloudflare

Cloudflare is the public-edge provider. Manage zone/DNS/proxy/TLS/WAF/rate-limit/cache/Worker configuration with Terraform where supported.

The API Worker:

- is reachable through the custom API hostname route only; `workers.dev` and Worker preview URLs are disabled;
- accepts only the `/api/v1` surface;
- overwrites caller-supplied `x-api-key` with the Terraform-managed gateway key;
- forwards normal application authorization headers/assertions unchanged;
- adds `x-corvis-edge-proxy: cloudflare-worker` for acceptance evidence;
- does not store or proxy ordinary source documents.

Rules:

- authenticated API responses must never be shared-cached;
- block/directly test gateway and Cloud Run bypass paths;
- Turnstile is appropriate for public abuse-prone surfaces but is not an authorization mechanism;
- the edge key proves approved edge traversal only; it never proves customer identity or entitlement.

The Cloudflare API token is an environment-scoped GitHub secret because Terraform requires provider authorization and there is no equivalent GCP-style GitHub federation baseline for this repository. The Cloudflare account ID and zone ID are derived from the configured zone lookup and must not become copied GitHub variables.

## Supabase/Postgres

Supabase Postgres Singapore is the primary structured data platform. The application writes only to Postgres. Project/settings resources may be Terraform-managed where supported; database objects are managed through SQL migrations.

Production uses a paid backup-capable tier. Free projects are suitable only for disposable development/prototypes and never production customer data.

Do not adopt Supabase Storage/Auth/Realtime/Edge Functions automatically. GCS, the approved identity layer, Cloud Run and Pub/Sub remain the baseline unless a documented simplification justifies a change.

## Snowflake

Snowflake is absent initially unless a business/customer/workload activation trigger is approved. When enabled, it is downstream analytics/secure sharing only. Postgres remains authoritative and Snowflake failure must not block application transactions.

See [`DATA_PLATFORM.md`](DATA_PLATFORM.md).

## Retention / cost controls

- Cloud Run min instances: zero by default.
- API Gateway and Cloudflare Worker are usage-priced/serverless; do not replace them with always-on edge infrastructure without a documented requirement.
- PR/preview environments: destroy within 24 hours of merge/close or inactivity.
- Bound Artifact Registry, Secret Manager, transient GCS and log retention.
- Prefer managed/serverless services before always-on infrastructure.
- Keep Snowflake spend at zero until an activation trigger is approved.
- Cost alerts and budgets are infrastructure code / deployment concerns; business spending thresholds remain governed in Confluence.
- `modules/gcp-observability` implements the repository SLO alert policies that have corresponding GCP metrics, a summary dashboard, and an optional monthly billing budget.

## Deployment responsibility

GitHub Actions should perform the following from reviewed code:

1. authenticate to GCP via OIDC/WIF;
2. consume Cloudflare/Supabase provider tokens from GitHub Environment secrets only when those integrations are active;
3. run Terraform plan/apply for the selected environment;
4. run database migrations in controlled order;
5. build immutable application images and push to Artifact Registry;
6. create/update GCP Secret Manager secret versions from approved bootstrap flows or generated deployment secrets when required;
7. deploy Cloud Run/Jobs referencing Secret Manager, not plaintext workflow output;
8. provision/update API Gateway and Cloudflare Worker edge configuration through Terraform;
9. run environment acceptance tests, including gateway-key bypass and Cloud Run IAM-policy checks;
10. publish deployment/evidence metadata.

Customer-created source-portal credentials are intentionally outside this GitHub propagation flow: customers submit/authorize them through the authenticated Corvis application, and the runtime writes them to managed secret storage.

See [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md), [`DEPLOYMENT.md`](DEPLOYMENT.md), and [`SECURITY_ACCEPTANCE.md`](SECURITY_ACCEPTANCE.md).

## Bootstrap exceptions

A few items cannot safely cascade from GitHub before trust exists. They are one-time external bootstrap actions, not ongoing configuration sources:

- ownership/billing for the GCP organization/projects or bootstrap project;
- initial GCP Workload Identity Pool/provider and deploy-service-account trust granting GitHub OIDC permission;
- domain registration and account ownership/billing for Cloudflare;
- creation/ownership/billing of the Supabase organization and generation of its management token;
- creation of GitHub Environments and entering their variables/secrets;
- third-party account/billing/contract setup where an API cannot safely bootstrap ownership.

After bootstrap, infrastructure/configuration changes should flow from GitHub whenever the provider supports it.
