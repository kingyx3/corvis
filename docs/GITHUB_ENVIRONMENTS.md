# GitHub Environments, variables and secrets

This is the canonical setup checklist for repository deployment configuration.

## Policy

Corvis uses three GitHub Environments: `dev`, `uat`, and `prod`.

Keep GitHub configuration as a **small set of external trust roots only**. Anything deterministic from those roots, the selected environment, Terraform outputs, provider lookups, or fixed architecture defaults must be derived in code instead of copied into another GitHub variable.

GitHub is the deployment/configuration control plane, not the long-term runtime secret store. Runtime secrets belong in GCP Secret Manager. Customer-provided GP portal, data-room, and source-repository credentials are tenant runtime secrets configured through the authenticated product, never GitHub deployment secrets.

## Current required GitHub Environment variables

The currently implemented GCP deployment requires exactly two custom variables per environment:

| Variable | Purpose | Why it remains a root |
| --- | --- | --- |
| `GCP_PROJECT_ID` | Target GCP project | Externally assigned/global identifier; cannot be safely inferred from the environment name. |
| `GCP_WIF_PROVIDER` | Full Workload Identity Provider resource name | One-time GCP trust-bootstrap output required before GitHub can authenticate to GCP. |

Do not add separate variables for values that can be derived from these roots.

## Values derived by the deployment workflow

The Terraform deploy workflow derives the following values automatically:

| Derived value | Derivation |
| --- | --- |
| GCP region | `asia-southeast1` |
| Deploy service account | `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` |
| Source/document bucket | `${GCP_PROJECT_ID}-documents` |
| Terraform state bucket | `${GCP_PROJECT_ID}-corvis-tf-state` |
| Terraform root | `infra/terraform/environments/${environment}` |
| Artifact Registry repository | Terraform module default `corvis` |
| Runtime API/worker service accounts | Terraform resources derived from project + environment |

The one-time GCP bootstrap must therefore create the deploy service account with account ID `corvis-deploy` and grant the configured Workload Identity Provider permission to impersonate it.

### GitHub variables that should not be maintained

Remove these from `dev`, `uat`, and `prod` if they were previously created:

- `GCP_REGION`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCS_SOURCE_BUCKET_NAME`
- `ARTIFACT_REGISTRY_REPOSITORY`

They are fixed or derived and should have one source of truth in code.

## Current required GitHub Environment secrets

**None.**

GCP deployment uses GitHub OIDC -> Workload Identity Federation and must not use a service-account JSON key. `GITHUB_TOKEN` is provided automatically by GitHub Actions and must not be created manually.

## Conditional provider roots

Only add provider-specific roots when the corresponding integration is actually implemented. Prefer Terraform/provider lookups and deterministic naming before adding another GitHub value.

### Cloudflare

Expected minimum roots when Cloudflare deployment is enabled:

- variable: `CLOUDFLARE_ZONE_NAME` -- registered Corvis root domain; hostnames should be derived from it and the environment;
- secret: `CLOUDFLARE_API_TOKEN` -- least-privilege deployment credential that cannot be derived.

Do not persist `CLOUDFLARE_ZONE_ID` or `CLOUDFLARE_ACCOUNT_ID` in GitHub when the provider/API can resolve them from the zone/account context. Add an ID only if the implemented provider path proves it cannot be looked up reliably.

Customer, admin, and API hostnames should be deterministic outputs of the DNS design rather than three independent GitHub variables.

### Supabase

Expected minimum roots when Supabase provisioning is enabled:

- secret: `SUPABASE_ACCESS_TOKEN` -- management credential that cannot be derived;
- variable: `SUPABASE_ORG_ID` -- keep only if the management API/provider cannot unambiguously resolve the intended organization from the authenticated account.

Derive the project name from `environment`; keep the Singapore region in code; generate/bootstrap the database password rather than asking a human to maintain a second copy in GitHub. Persist the runtime database secret in GCP Secret Manager and tightly restrict Terraform state if provisioning requires the bootstrap password to pass through Terraform.

### External identity, AI, search, observability, email, and anti-bot providers

Add a GitHub secret only when the enabled provider requires a non-federated static credential that cannot be generated or stored directly in the runtime secret store. Examples include a provider API key or upstream OIDC client secret.

Endpoints, audiences, service URLs, account IDs, resource IDs, and other non-secret values should come from deployment outputs, provider lookups, or fixed code defaults wherever possible.

## Secrets that must not be entered manually into GitHub

Generate, derive, or collect these through deployment/runtime flows and store them in GCP Secret Manager instead:

- `CORVIS_POSTGRES_DSN`
- `CORVIS_TRUSTED_AUTH_PROXY_SECRET`
- `CORVIS_WEBHOOK_SIGNING_SECRET`
- `CORVIS_WORKER_SECRET`
- internal service-to-service tokens when workload identity cannot replace them
- Snowflake runtime OAuth/access material
- customer GP portal/data-room/source credentials, OAuth refresh tokens, passwords, and session secrets

Prefer IAM/OIDC/service identity over static internal tokens.

## Credentials explicitly prohibited in GitHub

Do not add:

- `GCP_SERVICE_ACCOUNT_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS` containing JSON
- static GCP access tokens for CI
- AWS access key/secret key for the baseline application deployment
- plaintext database DSNs in repository variables
- customer source-portal credentials or session tokens

## Runtime configuration propagation

```text
GitHub Environment
  GCP_PROJECT_ID
  GCP_WIF_PROVIDER
        |
        v
GitHub Actions
  |- derive region, service-account email, bucket names and Terraform root
  |- OIDC -> GCP Workload Identity Federation
  |- Terraform -> GCP and enabled external providers
  |- provider/resource lookups -> IDs and URLs
  |- generated runtime secrets -> GCP Secret Manager
  `- Cloud Run/Jobs -> Secret Manager references + derived non-secret config

Customer administrator
        |
        v
Corvis runtime
  |- connection metadata -> Postgres
  `- source credential/token material -> GCP Secret Manager
```

## Derived runtime values

The deployment pipeline should derive rather than manually configure:

- `CORVIS_OBJECT_STORE_BUCKET` from the Terraform source-bucket output;
- `CORVIS_UPLOAD_ALLOWED_ORIGINS` from customer/admin HTTPS hostnames;
- `CORVIS_POSTGRES_DSN` from provisioned database connection information plus the generated database secret, then write it to Secret Manager;
- Cloud Run service URLs and internal adapter endpoints from deployment outputs;
- image URLs/digests from build output;
- Cloudflare origin targets from deployed GCP origin/load-balancer outputs;
- Snowflake non-secret database/warehouse names from the environment-specific analytics convention when Snowflake is activated.

Defaults such as `CORVIS_GCS_CHUNK_SIZE_BYTES=8388608` stay in code unless an environment genuinely needs an override.

## One-time setup outside GitHub

1. Create/own the GCP projects and attach billing.
2. In each project, create the `corvis-deploy` service account.
3. Create the GitHub Workload Identity Pool/provider and authorize the repository/environment identity to impersonate `corvis-deploy`.
4. Create GitHub Environments `dev`, `uat`, and `prod`.
5. Set only `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER` in each environment.
6. Register/own the domain and any external provider accounts only when those integrations are being activated.
7. Add the minimum conditional provider roots described above; do not pre-create unused secrets.

## Production protections

Recommended `prod` rules:

- required reviewer/approval once multiple operators exist;
- deployments only from the protected default branch or approved release refs;
- no pull-request code from untrusted forks receives provider secrets;
- one infrastructure writer per environment;
- plan before apply;
- explicit migration/infrastructure ordering;
- post-deploy acceptance checks before a release is considered healthy.

## Checklist

For each environment:

- [ ] GitHub Environment exists.
- [ ] `GCP_PROJECT_ID` is configured.
- [ ] `GCP_WIF_PROVIDER` is configured.
- [ ] `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` exists and is impersonable by the GitHub WIF identity.
- [ ] obsolete derived GitHub variables are removed.
- [ ] no custom GCP credential secret exists in GitHub.
- [ ] Terraform plan succeeds using derived names.
- [ ] runtime secrets are in GCP Secret Manager, not GitHub.
- [ ] deployed workloads use workload identity/Secret Manager references.
- [ ] acceptance tests pass.
