# GitHub Environments, variables and secrets

This is the canonical deployment-configuration contract. Corvis uses GitHub Environments `dev`, `uat`, and `prod`; deterministic resource names, hostnames and provider IDs are derived in code rather than copied into GitHub configuration.

## Complete reference

Every GitHub Actions variable (`vars.*`) and secret (`secrets.*`) any workflow reads. `lib/server/github-configuration-docs.test.ts` fails CI when a workflow reads one that is not listed here. Environment scope means the value is set on that GitHub Environment; repository scope means it is set once for the repository.

| Name | Kind | Scope | Required | Read by | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GCP_PROJECT_ID` | variable | `dev`, `uat`, `prod` | yes | build-release, cloudflare-zone-policy, copy-release-to-prod, gcp-bootstrap, gcp-cost-control, gcp-cost-hygiene, gcp-decommission, runtime-secrets, security-acceptance, terraform-deploy | Externally owned GCP project for the environment. |
| `GCP_WIF_PROVIDER` | variable | `dev`, `uat`, `prod` | yes | same as `GCP_PROJECT_ID` | Environment-scoped GitHub Workload Identity Provider resource name. |
| `CORVIS_AUTH_ISSUER` | variable | `uat`, `prod` (and `dev` with a runtime) | before a runtime deploy | terraform-deploy, gcp-decommission | Approved HTTPS OIDC issuer. |
| `CORVIS_AUTH_AUDIENCE` | variable | as above | no (default `corvis`) | terraform-deploy, gcp-decommission | Approved OIDC audience/client identifier. |
| `CORVIS_AUTH_JWKS_URL` | variable | as above | no | terraform-deploy, gcp-decommission | Explicit JWKS URL; OIDC discovery is preferred. |
| `CORVIS_CONTROL_TENANT_ID` | variable | `uat`, `prod` | for security acceptance | security-acceptance | Tenant used for retained sanitized control evidence. |
| `CORVIS_POSTGRES_CA_CERT` | variable | `dev`, `uat`, `prod` | when the provider uses a private CA (Supabase) | terraform-deploy, security-acceptance | Public PEM CA bundle for verified Postgres TLS (not a secret; see RUNTIME_SECRETS.md). |
| `GCP_BILLING_ACCOUNT_ID` | variable | `dev`, `uat`, `prod` | no | gcp-bootstrap, gcp-decommission, terraform-deploy | Attaches a monthly budget. |
| `GCP_MONTHLY_BUDGET_USD` | variable | `dev`, `uat`, `prod` | no | gcp-bootstrap, terraform-deploy | Positive USD monthly budget amount. UAT defaults to `5` when unset; prod/dev retain their higher environment defaults. |
| `MONITORING_NOTIFICATION_CHANNEL_IDS` | variable | `dev`, `uat`, `prod` | yes for a fresh `prod` runtime deploy | gcp-bootstrap, gcp-decommission, terraform-deploy | JSON array of Cloud Monitoring notification channel ids for every alert policy. |
| `CONTROL_LOOP_GITHUB_TOKEN_CONFIGURED` | variable | `uat`, `prod` | no (default `false`) | terraform-deploy | `true` once `corvis-control-loop-github-token-<env>` has an enabled version, so the control-loop jobs authenticate to GitHub. |
| `CLOUDFLARE_ZONE_NAME` | variable | repository | once a domain exists | cloudflare-zone-policy, gcp-decommission, security-acceptance, terraform-deploy | Bare lowercase root zone shared by UAT and prod. |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | variable | repository | yes for the shared zone policy | cloudflare-zone-policy, gcp-decommission, terraform-deploy | `true` on a Pro+ zone (managed WAF, host-scoped rate limits), `false` on Free; no silent default. |
| `CLOUDFLARE_ADMIN_ALLOWED_CIDRS` | variable | repository | no (default `[]`) | cloudflare-zone-policy | JSON array of operator CIDRs allowed to reach the admin hostnames. |
| `RELEASE_GOVERNANCE_TOKEN` | secret | `dev`, `uat`, `prod` | yes for governed builds/applies | build-release, cloudflare-zone-policy, terraform-deploy | Verifies the effective `main` ruleset before governed builds and applies (see below). |
| `CLOUDFLARE_API_TOKEN` | secret | `uat`, `prod` when that edge is active | with a domain | terraform-deploy, gcp-decommission | Environment host resources: DNS, Workers, routes. |
| `CLOUDFLARE_ZONE_POLICY_TOKEN` | secret | `uat` | with a domain | cloudflare-zone-policy | Shared zone settings and rulesets only. |
| `GITHUB_TOKEN` | secret (built in) | automatic | n/a | public-repo-leak-guard | The workflow's own token; never configured by hand. |

Runtime secrets (the Postgres DSN, the control-loop GitHub token) live in GCP Secret Manager, never in GitHub; see [`RUNTIME_SECRETS.md`](RUNTIME_SECRETS.md).

## Required environment variables

Every environment requires:

| Variable | Purpose |
| --- | --- |
| `GCP_PROJECT_ID` | Externally owned GCP project identifier. |
| `GCP_WIF_PROVIDER` | Environment-scoped GitHub Workload Identity Provider resource name. |

Before promoting a production-like UAT/prod runtime, also configure:

| Variable | Purpose |
| --- | --- |
| `CORVIS_AUTH_ISSUER` | Approved HTTPS OIDC issuer. |
| `CORVIS_AUTH_AUDIENCE` | Approved OIDC audience/client identifier. |
| `CORVIS_CONTROL_TENANT_ID` | Tenant used for retained sanitized control evidence. |

`CORVIS_AUTH_JWKS_URL` is optional; standards-based OIDC discovery is preferred.

`CORVIS_POSTGRES_CA_CERT` is optional: set the provider's public PEM CA bundle when its certificates chain to a private root (Supabase), so Postgres TLS stays verified.

`CONTROL_LOOP_GITHUB_TOKEN_CONFIGURED` (per environment, default `false`): set `true` after adding an enabled version to the Terraform-managed `corvis-control-loop-github-token-<env>` secret (a read-only, fine-grained token for this repository); only then do the control-loop jobs receive `GITHUB_TOKEN` instead of the 60-requests-per-hour anonymous GitHub API budget.

Cost/alert inputs are `GCP_BILLING_ACCOUNT_ID`, `GCP_MONTHLY_BUDGET_USD`, and `MONITORING_NOTIFICATION_CHANNEL_IDS`. For the UAT GitHub Environment set `GCP_MONTHLY_BUDGET_USD=5`; code also defaults UAT to `5` so a missing variable does not accidentally raise the guardrail. The project-wide budget sends alerts at 50%, 75%, 85%, and 100%; UAT programmatic notifications invoke the non-destructive cost guard at 85%. `MONITORING_NOTIFICATION_CHANNEL_IDS` is optional for `dev` and `uat` but required for a fresh `prod` runtime deploy (a `rollback_known_good` apply is exempt so an incident rollback is never blocked).

## Single shared Cloudflare domain

UAT and production use one configurable root zone. Set these as repository-level variables so both environments resolve the same zone:

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ZONE_NAME` | Bare lowercase root zone, such as `example.com`; leave unset until a domain is acquired. |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | **Required** for the shared zone policy workflow: `true` when the zone's plan supports the Pro+ managed-WAF/host-scoped rate-limit path, `false` on Free. There is no silent default; `false` is reported as a warning on every run. |
| `CLOUDFLARE_ADMIN_ALLOWED_CIDRS` | Optional JSON array of operator CIDRs (for example `["203.0.113.0/24"]`). When set, the edge blocks the prod and UAT admin hostnames for every other source address; empty (the default) is reported as a warning. |

Derived hostnames are:

- prod: `api.${zone}`, `app.${zone}`, `admin.${zone}`;
- UAT: `api-uat.${zone}`, `app-uat.${zone}`, `admin-uat.${zone}`.

Do not create hostname variables and do not use nested `*.uat.${zone}` names in the baseline. A normal full-zone Universal SSL certificate covers the apex and first-level subdomains, which is why UAT uses `*-uat` labels.

A domain is **not required** for **Bootstrap GCP foundation**.

## Active GitHub secrets

| Secret | Scope | Purpose |
| --- | --- | --- |
| `RELEASE_GOVERNANCE_TOKEN` | `dev`, `uat`, `prod` | Lets the release-governance verifier prove the effective `main` ruleset and bypass configuration before governed applies/builds. |
| `CLOUDFLARE_API_TOKEN` | UAT/prod only when that environment edge is active | Environment-scoped Cloudflare credential for zone lookup plus that environment's DNS, Worker deployment and route resources. |
| `CLOUDFLARE_ZONE_POLICY_TOKEN` | protected UAT Environment after a domain exists | Dedicated token used only by the shared-zone workflow for zone TLS settings and zone Rulesets/WAF/rate/cache policy. |

GCP deployment does not use a custom credential secret; GitHub OIDC -> GCP Workload Identity Federation is mandatory.

### Cloudflare least-privilege split

`CLOUDFLARE_ZONE_POLICY_TOKEN` is restricted to the selected Corvis zone and only the shared-policy permissions needed by `infra/terraform/shared/cloudflare` (zone read, Zone Settings write/edit and Zone WAF/Rulesets write/edit). It should not receive DNS/Workers deployment authority unless the provider proves that permission is required.

`CLOUDFLARE_API_TOKEN` is for environment host resources only: zone lookup, DNS records, Worker creation/update/deployment and Workers routes. Cloudflare DNS authorization is zone-scoped rather than record-name-scoped, so Corvis also relies on deterministic names, separate Terraform states, main-only reviewed applies and contract tests for environment separation.

See [`CLOUDFLARE_SHARED_ZONE.md`](CLOUDFLARE_SHARED_ZONE.md) for the detailed one-domain operating model.

### Release governance token

Use a fine-grained token or GitHub App credential scoped only to this repository. A fine-grained token needs **Administration: Read and write**, **Contents: Read**, **Checks: Read** and implicit Metadata read so the verifier can see effective ruleset bypass configuration. Store it as an environment secret, rotate it, and do not reuse it for deployment-provider access.

## Derived values

| Derived value | Derivation |
| --- | --- |
| GCP region | `asia-southeast1` |
| Deploy identity | `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` |
| Environment state bucket | `${GCP_PROJECT_ID}-corvis-tf-state` |
| Shared Cloudflare state bucket | `${UAT_GCP_PROJECT_ID}-corvis-shared-tf-state` |
| Shared Cloudflare state prefix | `corvis/cloudflare-zone-policy` |
| Environment Terraform root | `infra/terraform/environments/${environment}` |
| Shared Cloudflare Terraform root | `infra/terraform/shared/cloudflare` |
| Source bucket | `${GCP_PROJECT_ID}-documents` |
| Artifact Registry API repository | `asia-southeast1-docker.pkg.dev/${GCP_PROJECT_ID}/corvis/api` |
| Runtime API/worker image | selected release tag resolved to the immutable `image@sha256:<digest>` before Terraform runs |
| Postgres runtime secret | `corvis-postgres-dsn-${environment}` |
| Cloudflare zone/account IDs | Provider lookup from `CLOUDFLARE_ZONE_NAME` |
| Public hostnames | Derived from the single zone and environment as listed above |

`API_IMAGE` is not a human-managed GitHub Environment variable. The build/deploy path derives the runtime API/worker image from a reviewed `main` release and its immutable registry digest. Known-good rollback state is acceptance-gated rather than manually entered.

## Remove or avoid creating

Do not create GitHub variables for derived values such as `API_IMAGE`, Cloudflare zone/account IDs, API/customer/admin hostnames, API Gateway hostnames/keys, Cloud Run URLs, service-account names, state bucket names or image digests.

Do not hardcode `corvis.com`, `corvis.ai`, or another candidate TLD anywhere in the deployment contract.

## Provider/runtime secret boundary

Runtime secret values belong in GCP Secret Manager or the relevant provider-managed store, not ordinary GitHub variables. The Postgres DSN is written directly to `corvis-postgres-dsn-${environment}` and read through WIF/IAM by migrations and runtime workloads. Terraform generates the restricted API Gateway edge key and passes it to the Worker as a sensitive binding.

## Setup order

1. Create the billed GCP project.
2. Create `corvis-deploy` plus the repository/environment-scoped WIF provider and impersonation binding.
3. Create GitHub Environments and configure `GCP_PROJECT_ID` + `GCP_WIF_PROVIDER`; set UAT `GCP_MONTHLY_BUDGET_USD=5` when environment-variable administration is available.
4. Run **Bootstrap GCP foundation** plan then apply from `main`.
5. Before runtime promotion, activate Postgres and the approved IdP contract.
6. When a domain is selected, activate it as the single Cloudflare zone and set repository `CLOUDFLARE_ZONE_NAME`.
7. Configure `CLOUDFLARE_ZONE_POLICY_TOKEN`; run **Cloudflare shared zone policy** plan then apply from `main`.
8. Configure the environment `CLOUDFLARE_API_TOKEN`; deploy UAT/prod through the normal immutable-release Terraform path.
9. Run Security acceptance before treating the release as known-good.

Steps 1-4 require no domain, Cloudflare, Postgres or IdP.

## Promotion and lifecycle rules

- Shared-zone policy is applied before an environment public edge is first activated or whenever shared zone policy changes.
- Environment deploys own only their own DNS/Workers/routes; they cannot own zone-wide rulesets/settings.
- Shared-zone mutations are serialized by a dedicated workflow concurrency group and apply only from `main` after release-governance verification.
- Shared Cloudflare state is stored in its own protected bucket and is not deleted by UAT environment decommission.
- Every Terraform-touching workflow (deploy, bootstrap, decommission) uses the `terraform-<environment>` concurrency group with `cancel-in-progress: false`.
- Bootstrap refuses to delete or replace existing resources; the `allow_destroy` input is honoured for `dev`/`uat` only, never `prod`.
- Normal Terraform deploy never doubles as decommission; `gcp-decommission.yml` owns environment idle/full transitions.
- UAT cost hibernation is non-destructive: it pauses Scheduler jobs and the processing queue, retains data/state/secrets/images, and is manually resumable through `gcp-cost-control.yml`.
- Artifact Registry cleanup and `gcp-cost-hygiene.yml` prune low-value historical versions while preserving active and known-good rollback artifacts.

## Checklist

- [ ] `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER` are configured for each environment.
- [ ] UAT `GCP_MONTHLY_BUDGET_USD` is set to `5` (or intentionally overridden); the code fallback is also `5`.
- [ ] `RELEASE_GOVERNANCE_TOKEN` is configured for each environment.
- [ ] GCP foundation bootstrap succeeds before runtime activation.
- [ ] production-like Postgres/IdP roots are configured before runtime promotion.
- [ ] when Cloudflare is enabled, one repository `CLOUDFLARE_ZONE_NAME` is used by both UAT and prod.
- [ ] shared Cloudflare zone policy has been applied with the dedicated policy token.
- [ ] UAT/prod each have an environment edge token only when needed.
- [ ] no zone-wide Cloudflare resources exist in environment Terraform modules.
- [ ] no derived hostname/zone ID/account ID/gateway key/runtime URL is duplicated into GitHub configuration.
