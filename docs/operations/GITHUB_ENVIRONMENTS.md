# GitHub Environments, variables and secrets

This is the canonical deployment-configuration contract. Corvis uses GitHub Environments `dev`, `uat`, and `prod`; deterministic resource names, hostnames and provider IDs are derived in code rather than copied into GitHub configuration. Release-governance credential and environment-protection details are expanded in [`RELEASE_GOVERNANCE.md`](./RELEASE_GOVERNANCE.md).

## Complete reference

Every GitHub Actions variable (`vars.*`) and secret (`secrets.*`) any workflow reads. `tools/repo-checks/workflows/github-configuration-docs.test.ts` fails CI when a workflow reads one that is not listed here. Environment scope means the value is set on that GitHub Environment; repository scope means it is set once for the repository.

| Name | Kind | Scope | Required | Read by | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GCP_PROJECT_ID` | variable | `dev`, `uat`, `prod` | yes | build-release, cloudflare-zone-policy, copy-release-to-prod, gcp-bootstrap, gcp-cost-control, gcp-cost-hygiene, gcp-decommission, runtime-secrets, security-acceptance, terraform-deploy, ai-integration-secrets, augment-known-good-ai | Externally owned GCP project for the environment. |
| `GCP_WIF_PROVIDER` | variable | `dev`, `uat`, `prod` | yes | same as `GCP_PROJECT_ID` | Environment-scoped GitHub Workload Identity Provider resource name. |
| `CORVIS_AUTH_ISSUER` | variable | `uat`, `prod` (and `dev` with a runtime) | before a runtime deploy | terraform-deploy, gcp-decommission | Approved HTTPS OIDC issuer. |
| `CORVIS_AUTH_AUDIENCE` | variable | as above | no (default `corvis`) | terraform-deploy, gcp-decommission | Approved OIDC audience/client identifier. |
| `CORVIS_AUTH_JWKS_URL` | variable | as above | no | terraform-deploy, gcp-decommission | Explicit JWKS URL; OIDC discovery is preferred. |
| `CORVIS_EXTRACTION_ENDPOINT` | variable | `uat`, `prod` | when governed extraction is enabled | terraform-deploy | HTTPS endpoint implementing Corvis `/v1/extractions`; leave unset to fail closed. |
| `CORVIS_EXTRACTION_AUDIENCE` | variable | `uat`, `prod` | no | terraform-deploy | Google OIDC audience for the extraction harness. |
| `CORVIS_EXTRACTION_TIMEOUT_MS` | variable | `uat`, `prod` | no (default `300000`) | terraform-deploy | Extraction-provider timeout; accepted range 1000-480000 ms. |
| `CORVIS_LITELLM_BASE_IMAGE` | variable | `dev`, `uat` build environments | yes for **Build release image** | build-release | Immutable upstream LiteLLM reference ending in `@sha256:<digest>`. |
| `CORVIS_LITELLM_MODELS_JSON` | variable | `uat`, `prod` | when managed AI extraction is enabled | terraform-deploy | Non-secret alias-to-provider/model map; must include `corvis-extract-primary`. |
| `CORVIS_CONTROL_TENANT_ID` | variable | `uat`, `prod` | for security acceptance | security-acceptance | Tenant used for retained sanitized control evidence. |
| `CORVIS_POSTGRES_CA_CERT` | variable | `dev`, `uat`, `prod` | when provider uses a private CA | terraform-deploy, security-acceptance | Public PEM CA bundle for verified Postgres TLS. |
| `GCP_BILLING_ACCOUNT_ID` | variable | `dev`, `uat`, `prod` | no | gcp-bootstrap, gcp-decommission, terraform-deploy | Billing account for managed budgets. |
| `GCP_MONTHLY_BUDGET_USD` | variable | `dev`, `uat`, `prod` | no | gcp-bootstrap, terraform-deploy | Positive monthly budget; UAT defaults to `5`. |
| `MONITORING_NOTIFICATION_CHANNEL_IDS` | variable | `dev`, `uat`, `prod` | yes for a fresh `prod` runtime deploy | gcp-bootstrap, gcp-decommission, terraform-deploy | JSON Cloud Monitoring notification-channel IDs. |
| `CONTROL_LOOP_GITHUB_TOKEN_CONFIGURED` | variable | `uat`, `prod` | no (default `false`) | terraform-deploy | `true` after the runtime control-loop GitHub token has an enabled Secret Manager version. |
| `CLOUDFLARE_ZONE_NAME` | variable | repository | once a domain exists | cloudflare-zone-policy, gcp-decommission, security-acceptance, terraform-deploy | Bare root zone shared by UAT and prod. |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | variable | repository | yes for shared-zone policy | cloudflare-zone-policy, gcp-decommission, terraform-deploy | Explicit Cloudflare managed-WAF capability flag. |
| `CLOUDFLARE_ADMIN_ALLOWED_CIDRS` | variable | repository | no (default `[]`) | cloudflare-zone-policy | JSON operator CIDRs allowed to reach admin hosts. |
| `RELEASE_GOVERNANCE_TOKEN` | secret | `dev`, `uat`, `prod` | yes for governed builds/applies | build-release, cloudflare-zone-policy, terraform-deploy | Historical name for the GitHub App credential JSON used to mint a short-lived repository installation token. **Do not store a PAT here.** See `RELEASE_GOVERNANCE.md`. |
| `CLOUDFLARE_API_TOKEN` | secret | `uat`, `prod` when edge is active | with a domain | terraform-deploy, gcp-decommission | Environment host DNS/Worker/route authority. |
| `CLOUDFLARE_ZONE_POLICY_TOKEN` | secret | `uat` | with a domain | cloudflare-zone-policy | Shared-zone TLS/settings/rulesets authority. |
| `CORVIS_AI_PROVIDER_CREDENTIALS_JSON` | secret | `uat`, `prod` | when static provider credentials are needed | ai-integration-secrets | Provisioning input copied to GCP Secret Manager. |
| `CORVIS_LITELLM_MASTER_KEY` | secret | `uat`, `prod` | when LiteLLM is deployed | ai-integration-secrets | LiteLLM root/gateway credential provisioning input. |
| `CORVIS_ATLASSIAN_SKILL_READ_CREDENTIALS_JSON` | secret | `uat`, `prod` | when extraction reads Confluence skills | ai-integration-secrets | Read-capability skill credential/config provisioning input. |
| `CORVIS_ATLASSIAN_SKILL_UPDATE_CREDENTIALS_JSON` | secret | `uat`, `prod` | only for approved skill maintenance | ai-integration-secrets | Separately governed skill-update credential/config. |
| `GITHUB_TOKEN` | secret (built in) | automatic | n/a | public-repo-leak-guard | Workflow token; never configured by hand. |

Persistent runtime secrets live in GCP Secret Manager or the relevant provider-managed store. GitHub Environment AI secrets above are protected provisioning inputs only; workflows write new Secret Manager versions and never turn those values into Terraform variables. See [`RUNTIME_SECRETS.md`](./RUNTIME_SECRETS.md) and [`AI_MODEL_GATEWAY.md`](../architecture/AI_MODEL_GATEWAY.md).

## Required environment variables

Every environment requires `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER`. Before a production-like runtime promotion also configure `CORVIS_AUTH_ISSUER`; `CORVIS_AUTH_AUDIENCE` defaults to `corvis`, and `CORVIS_AUTH_JWKS_URL` remains optional because standards-based OIDC discovery is preferred. Configure `CORVIS_CONTROL_TENANT_ID` before retained security acceptance. Set `CORVIS_POSTGRES_CA_CERT` only when the provider chain requires a private CA.

### Release governance and GitHub Environment protection

`RELEASE_GOVERNANCE_TOKEN` **must contain GitHub App credential JSON, not a fine-grained or classic PAT**. The expected shape is documented in [`RELEASE_GOVERNANCE.md`](./RELEASE_GOVERNANCE.md). The verifier signs a short-lived App JWT and requests a repository-scoped installation token for each run; long-lived PATs are rejected by code.

Configure all three GitHub Environments to allow deployment from `main` only. Production should require independent reviewers and disallow administrator bypass when the GitHub account/plan and operating model support it. In the documented solo-maintainer mode, the exact-release checks, non-bypassable `main` ruleset, reviewed Terraform plan digest, UAT acceptance gate, and live post-deploy acceptance are mandatory compensating controls.

The GCP WIF provider is also fail-closed to repository + environment + `assertion.ref == 'refs/heads/main'`; `verify-gcp-trust-anchor.sh` rejects a broader provider condition.

### Governed extraction harness

`corvis-worker-<env>` calls the private `corvis-extractor-<env>` boundary using Google OIDC. The extractor reads immutable interpretation evidence and the approved read-only skill snapshot, calls private LiteLLM, and writes candidate evidence. LiteLLM alone receives model-provider credentials. The extractor does not receive Postgres credentials or Confluence write authority.

Managed AI stays disabled until `CORVIS_LITELLM_MODELS_JSON` is configured. `CORVIS_LITELLM_BASE_IMAGE` is a build input and must be an immutable digest. Build release produces API/worker, control-loop, extractor and LiteLLM as one attested release set; production copies the accepted UAT digests rather than rebuilding them.

`CORVIS_EXTRACTION_TIMEOUT_MS` defaults to `300000` ms and accepts 1000-480000. `CORVIS_EXTRACTION_ENDPOINT` must point to the governed extractor, never directly to LiteLLM or a raw provider API.

## Single shared Cloudflare domain

UAT and production use one configurable root zone. Keep `CLOUDFLARE_ZONE_NAME`, `CLOUDFLARE_MANAGED_WAF_ENABLED`, and `CLOUDFLARE_ADMIN_ALLOWED_CIDRS` at repository scope. Derived hostnames are prod `api.${zone}`, `app.${zone}`, `admin.${zone}` and UAT `api-uat.${zone}`, `app-uat.${zone}`, `admin-uat.${zone}`. Do not create hostname variables. A domain is **not required** for **Bootstrap GCP foundation**.

`CLOUDFLARE_ZONE_POLICY_TOKEN` owns only shared-zone TLS/settings/rulesets. `CLOUDFLARE_API_TOKEN` owns environment host resources. Cloudflare DNS authorization is zone-scoped, so deterministic names, separate Terraform state, main-only reviewed applies and contract tests provide environment separation.

## Derived values

| Derived value | Derivation |
| --- | --- |
| GCP region | `asia-southeast1` |
| Deploy identity | `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` |
| Environment state bucket | `${GCP_PROJECT_ID}-corvis-tf-state` |
| Shared Cloudflare state bucket | `${UAT_GCP_PROJECT_ID}-corvis-shared-tf-state` |
| Environment Terraform root | `infra/terraform/environments/${environment}` |
| Source bucket | `${GCP_PROJECT_ID}-documents` |
| Artifact Registry API repository | `asia-southeast1-docker.pkg.dev/${GCP_PROJECT_ID}/corvis/api` |
| Artifact Registry extractor repository | `asia-southeast1-docker.pkg.dev/${GCP_PROJECT_ID}/corvis/extractor` |
| Artifact Registry LiteLLM repository | `asia-southeast1-docker.pkg.dev/${GCP_PROJECT_ID}/corvis/litellm` |
| Runtime images | accepted release digests expressed as immutable `image@sha256:<digest>` references |
| Postgres runtime secret | `corvis-postgres-dsn-${environment}` |
| AI provider credentials secret | `corvis-ai-provider-credentials-${environment}` |
| LiteLLM master-key secret | `corvis-litellm-master-key-${environment}` |
| Confluence skill read secret | `corvis-atlassian-skill-read-${environment}` |
| Confluence skill update secret | `corvis-atlassian-skill-update-${environment}` |
| Public hostnames | derived from the single zone and environment |

`API_IMAGE`, `EXTRACTOR_IMAGE`, and `LITELLM_IMAGE` are not human-managed GitHub Environment variables. The build/deploy path derives runtime images from a reviewed `main` release and immutable registry digests. Known-good rollback state is acceptance-gated rather than manually entered.

## Remove or avoid creating

Do not create GitHub variables for derived values such as image digest refs, Cloudflare zone/account IDs, API/customer/admin hostnames, API Gateway hostnames/keys, Cloud Run URLs, service-account names or state bucket names. Do not hardcode `corvis.com`, `corvis.ai`, or another candidate TLD anywhere in the deployment contract.

## Provider/runtime secret boundary

Runtime secret values belong in GCP Secret Manager or the relevant provider-managed store, not ordinary GitHub variables. The Postgres DSN is written to `corvis-postgres-dsn-${environment}` and read through WIF/IAM. Model-provider API keys, LiteLLM credentials, and Atlassian credentials follow the same persistent-storage rule and must never enter extraction evidence, logs, model prompts, Terraform variables, or committed config.

## Setup order

1. Create the billed GCP project.
2. Create `corvis-deploy` plus the repository/environment/main-ref-scoped WIF provider and impersonation binding.
3. Create `dev`, `uat`, `prod` GitHub Environments; restrict deployment to `main`, configure `GCP_PROJECT_ID` + `GCP_WIF_PROVIDER`, and add the App-backed `RELEASE_GOVERNANCE_TOKEN` credential JSON.
4. Run **Bootstrap GCP foundation** plan then apply from `main`.
5. Before runtime promotion, activate Postgres and the approved IdP contract.
6. When a domain is selected, set repository `CLOUDFLARE_ZONE_NAME`, apply the shared zone policy, then activate environment edge resources.
7. For managed extraction, configure the immutable LiteLLM base digest, model aliases and protected provisioning secrets, then build/promote the normal four-image release set.
8. Validate representative quarterly-report packages in UAT and run Security acceptance before treating a release as known-good.

The build-once promotion sequence is: build/attest in UAT -> deploy exact digests to UAT -> live acceptance -> bind exact source SHA and AI digests into `known-good.json` -> verify those accepted digests and attestations -> copy exact OCI digests to prod -> reviewed Terraform plan/apply -> prod acceptance.

## Promotion and lifecycle rules

- Production release tags are immutable; `git-<sha>` cannot be moved to different bytes.
- UAT cleanup pointers may move, but production promotion trusts `known-good.json` digest references, not mutable UAT tags.
- Shared-zone and environment applies are main-only and serialized with `cancel-in-progress: false`.
- Normal deploy never doubles as decommission; decommission has a separate guarded workflow.
- Known-good rollback skips forward migrations and uses the accepted immutable digest set.
- Artifact Registry cleanup may prune low-value UAT/dev history while retaining active/known-good artifacts; production immutable release tags remain durable evidence.

## Checklist

- [ ] `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER` are configured for each environment.
- [ ] each environment allows deployment from `main` only; prod reviewer/no-bypass protection is enabled when available.
- [ ] `RELEASE_GOVERNANCE_TOKEN` contains GitHub App credential JSON, not a PAT.
- [ ] UAT `GCP_MONTHLY_BUDGET_USD` is `5` unless intentionally overridden.
- [ ] GCP foundation bootstrap succeeds before runtime activation.
- [ ] production-like Postgres/IdP roots are configured before runtime promotion.
- [ ] UAT release builds use immutable `CORVIS_LITELLM_BASE_IMAGE`.
- [ ] managed extraction aliases and protected provider/LiteLLM/Atlassian provisioning secrets are configured only when needed.
- [ ] `CORVIS_EXTRACTION_ENDPOINT` targets the governed extractor, not LiteLLM or a raw model API.
- [ ] one repository `CLOUDFLARE_ZONE_NAME` is shared by UAT and prod when Cloudflare is enabled.
- [ ] no derived hostname/provider ID/runtime URL is duplicated into GitHub configuration.
