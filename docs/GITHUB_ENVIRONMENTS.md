# GitHub Environments, variables and secrets

This is the canonical deployment-configuration contract. Corvis uses GitHub Environments `dev`, `uat`, and `prod`; deterministic resource names, hostnames and provider IDs are derived in code rather than copied into GitHub configuration.

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

Optional cost/alert inputs are `GCP_BILLING_ACCOUNT_ID` and `MONITORING_NOTIFICATION_CHANNEL_IDS`.

## Single shared Cloudflare domain

UAT and production use one configurable root zone. Set these as repository-level variables so both environments resolve the same zone:

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ZONE_NAME` | Bare lowercase root zone, such as `example.com`; leave unset until a domain is acquired. |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | Defaults to `false`; set `true` only when the selected Cloudflare plan supports the Pro+ managed-WAF/host-scoped rate-limit path. |

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

Use a fine-grained token or GitHub App credential scoped only to this repository with the repository administration visibility needed to read effective ruleset bypass configuration, plus Contents read and Checks read. Store it as an environment secret, rotate it, and do not reuse it for deployment-provider access.

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
| Postgres runtime secret | `corvis-postgres-dsn-${environment}` |
| Cloudflare zone/account IDs | Provider lookup from `CLOUDFLARE_ZONE_NAME` |
| Public hostnames | Derived from the single zone and environment as listed above |

Do not create GitHub variables for Cloudflare zone/account IDs, API/customer/admin hostnames, API Gateway hostnames/keys, Cloud Run URLs, service-account names, state bucket names or image digests.

Do not hardcode `corvis.com`, `corvis.ai`, or another candidate TLD anywhere in the deployment contract.

## Provider/runtime secret boundary

Runtime secret values belong in GCP Secret Manager or the relevant provider-managed store, not ordinary GitHub variables. The Postgres DSN is written directly to `corvis-postgres-dsn-${environment}` and read through WIF/IAM by migrations and runtime workloads. Terraform generates the restricted API Gateway edge key and passes it to the Worker as a sensitive binding.

## Setup order

1. Create the billed GCP project.
2. Create `corvis-deploy` plus the repository/environment-scoped WIF provider and impersonation binding.
3. Create GitHub Environments and configure `GCP_PROJECT_ID` + `GCP_WIF_PROVIDER`.
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
- Normal Terraform deploy never doubles as decommission; `gcp-decommission.yml` owns environment idle/full transitions.

## Checklist

- [ ] `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER` are configured for each environment.
- [ ] `RELEASE_GOVERNANCE_TOKEN` is configured for each environment.
- [ ] GCP foundation bootstrap succeeds before runtime activation.
- [ ] production-like Postgres/IdP roots are configured before runtime promotion.
- [ ] when Cloudflare is enabled, one repository `CLOUDFLARE_ZONE_NAME` is used by both UAT and prod.
- [ ] shared Cloudflare zone policy has been applied with the dedicated policy token.
- [ ] UAT/prod each have an environment edge token only when needed.
- [ ] no zone-wide Cloudflare resources exist in environment Terraform modules.
- [ ] no derived hostname/zone ID/account ID/gateway key/runtime URL is duplicated into GitHub configuration.
