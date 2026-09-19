# GitHub Environments, variables and secrets

This is the canonical setup checklist for repository deployment configuration.

## Policy

Corvis uses GitHub Environments `dev`, `uat`, and `prod`.

Keep GitHub configuration to **external trust roots and genuine operator decisions only**. Anything deterministic from those roots, the selected environment, Terraform/provider lookups, deployed-resource outputs, or fixed architecture defaults must be derived in code instead of copied into another GitHub variable.

GitHub is the deployment/configuration control plane, not the long-term runtime secret store. Runtime secrets belong in GCP Secret Manager. Customer source credentials are tenant runtime secrets configured through the authenticated product, never GitHub deployment secrets.

## Active GitHub variables

### Required in every environment

| Variable | Purpose | Why it remains a root |
| --- | --- | --- |
| `GCP_PROJECT_ID` | Target GCP project | Externally assigned/global identifier; cannot be safely inferred from `dev`/`uat`/`prod`. |
| `GCP_WIF_PROVIDER` | Full Workload Identity Provider resource name | Required before GitHub can authenticate to GCP; the project number inside the resource name is not available until trust is established. |

### Runtime activation (`uat` / `prod`)

| Variable | Purpose | Why it remains |
| --- | --- | --- |
| `API_IMAGE` | Immutable Artifact Registry image reference ending in `@sha256:<digest>` | Release/promotion input until the build-and-promote workflow writes the selected digest automatically. Empty keeps the API runtime and public API origin unprovisioned. |

### Cloudflare edge (`uat` / `prod` only)

| Variable | Purpose | Why it remains |
| --- | --- | --- |
| `CLOUDFLARE_ZONE_NAME` | Registered Corvis Cloudflare zone | External domain ownership. Prefer one repository-level variable if UAT and prod share the same root zone. |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | Enables plan-dependent Cloudflare/OWASP managed rulesets | Intentional rollout/capability decision, not a value that can be inferred safely. Defaults to `false`. |

When `CLOUDFLARE_ZONE_NAME` is configured, `API_IMAGE` must also be configured. Terraform creates the GCP external HTTPS load balancer, derives its global IPv4 address, creates the Google Certificate Manager DNS authorization record in Cloudflare, and then publishes only the API hostname. Customer/admin hostnames remain unpublished until their distinct production runtime boundaries exist.

### Security acceptance (`uat` / `prod` only)

| Variable | Purpose | Why it remains |
| --- | --- | --- |
| `GCP_DIRECT_ORIGIN_PROBE_URLS` | Semicolon-separated direct-origin URLs used to prove Cloudflare bypass is blocked | Temporary deployment output until public origin service URLs are queryable from managed GCP resources. |

No GitHub variable is required for the Postgres DSN secret name. Security acceptance derives the contract `corvis-${environment}-postgres-dsn`.

## Active GitHub secrets

| Secret | Scope | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `uat` / `prod` when edge deployment is enabled | Least-privilege deployment credential for Cloudflare DNS/zone/rules configuration. |

There are **no custom GCP credential secrets**. GCP CI/CD uses GitHub OIDC -> Workload Identity Federation. `GITHUB_TOKEN` is supplied automatically by GitHub Actions and must not be created manually.

## Values derived automatically

The deployment and acceptance workflows derive these instead of storing them in GitHub:

| Derived value | Derivation |
| --- | --- |
| GCP region | `asia-southeast1` |
| Deploy service account | `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` |
| Source/document bucket | `${GCP_PROJECT_ID}-documents` |
| Terraform state bucket | `${GCP_PROJECT_ID}-corvis-tf-state` |
| Terraform root | `infra/terraform/environments/${environment}` |
| Artifact Registry repository | Terraform module default `corvis` |
| Cloudflare zone ID | Provider lookup by `CLOUDFLARE_ZONE_NAME` using `CLOUDFLARE_API_TOKEN` |
| Production API hostname | `api.${zone}` |
| UAT API hostname | `api.uat.${zone}` |
| GCP API origin IPv4 | `gcp-serverless-origin` global-address output wired directly into Cloudflare DNS |
| Certificate validation record | Google Certificate Manager DNS authorization output wired directly into Cloudflare DNS |
| Postgres DSN secret name | `corvis-${environment}-postgres-dsn` |
| API/worker service-account names | Terraform resources derived from project + environment |

Cloud Run service URLs, image digests after automated promotion, runtime endpoints and future customer/admin origin addresses should likewise flow from Terraform/build outputs rather than becoming GitHub variables.

## GitHub values to remove or avoid creating

Remove these if they already exist; they are fixed, derived, or provider-resolvable:

- `GCP_REGION`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCS_SOURCE_BUCKET_NAME`
- `ARTIFACT_REGISTRY_REPOSITORY`
- `GCP_ORIGIN_IPV4_ADDRESS`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `CUSTOMER_HOSTNAME`
- `ADMIN_HOSTNAME`
- `API_HOSTNAME`
- `CORVIS_POSTGRES_DSN_SECRET_NAME`

Do not store plaintext DSNs or generated runtime secrets as GitHub variables.

## Conditional future provider roots

Only add a provider credential when that integration is actually enabled and federation/provider lookup cannot replace it. Examples include `SUPABASE_ACCESS_TOKEN`, an upstream OIDC client secret, or a direct external AI/search/email provider API key.

For Supabase, derive the project name from the environment, keep the Singapore region in code, generate the database bootstrap password through the deployment path where supported, and write the runtime DSN to GCP Secret Manager. Do not pre-create unused GitHub secrets.

## Secrets that must not be entered manually into GitHub

Generate, derive, or collect these through deployment/runtime flows and store them in GCP Secret Manager instead:

- `CORVIS_POSTGRES_DSN`
- `CORVIS_TRUSTED_AUTH_PROXY_SECRET`
- `CORVIS_WEBHOOK_SIGNING_SECRET`
- `CORVIS_WORKER_SECRET`
- internal service-to-service tokens when workload identity cannot replace them
- Snowflake runtime OAuth/access material
- customer GP portal/data-room/source credentials, OAuth refresh tokens, passwords, and session secrets

Explicitly prohibited GitHub credentials include GCP service-account JSON keys, `GOOGLE_APPLICATION_CREDENTIALS` JSON, static GCP access tokens, plaintext database DSNs, and customer source credentials.

## One-time setup outside GitHub

1. Create/own the GCP projects and attach billing.
2. In each project, create the `corvis-deploy` service account.
3. Create the GitHub Workload Identity Pool/provider and authorize the repository/environment identity to impersonate `corvis-deploy`.
4. Create GitHub Environments `dev`, `uat`, and `prod` and set `GCP_PROJECT_ID` + `GCP_WIF_PROVIDER`.
5. Register/own the Cloudflare zone. When API edge deployment is enabled, set `CLOUDFLARE_ZONE_NAME`, `API_IMAGE`, the managed-WAF rollout flag if needed, and the scoped `CLOUDFLARE_API_TOKEN`; Terraform derives the origin IP and certificate-validation record.
6. Add `GCP_DIRECT_ORIGIN_PROBE_URLS` only when running production-like security acceptance and until those URLs can be derived from managed GCP resources.

## Production protections

For `prod`, require reviewed deployments once multiple operators exist, deploy only from approved refs, keep provider secrets environment-scoped, prevent untrusted PR code from receiving secrets, allow one infrastructure writer at a time, require plan-before-apply, and retain post-deploy acceptance evidence.

## Per-environment checklist

- [ ] GitHub Environment exists.
- [ ] `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER` are configured.
- [ ] `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` exists and is impersonable by the GitHub WIF identity.
- [ ] obsolete derived GitHub variables are removed.
- [ ] no custom GCP credential secret exists in GitHub.
- [ ] `API_IMAGE` is an immutable digest when a UAT/prod API runtime is activated.
- [ ] Cloudflare roots exist only where API edge deployment is enabled.
- [ ] Terraform plan succeeds using derived names, provider lookups, certificate validation and origin outputs.
- [ ] runtime secrets are in GCP Secret Manager, not GitHub.
- [ ] deployed workloads use workload identity/Secret Manager references.
- [ ] production-like acceptance tests pass before release.
