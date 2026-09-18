# GitHub Environments, variables and secrets

This is the canonical setup checklist for repository deployment configuration.

## Policy

Corvis uses three GitHub Environments:

- `dev`
- `uat`
- `prod`

**Human-entered technical deployment configuration should be entered in GitHub once, then propagated by GitHub Actions as far as provider APIs/IaC allow.** Do not maintain the same value manually in GitHub, GCP, Cloudflare and Supabase.

GitHub is the deployment/configuration control plane, but it is **not** the long-term runtime secret store. GitHub Actions should copy or generate runtime secrets into GCP Secret Manager and deploy Cloud Run/Jobs using Secret Manager references.

Customer-provided GP portal, data-room or source-repository credentials are a separate class of **tenant runtime secret**. Customers configure/authorize them through the authenticated Corvis product, not through GitHub; the runtime writes the secret material directly to managed secret storage. See [`SOURCE_CONNECTORS.md`](SOURCE_CONNECTORS.md).

Use environment-scoped variables/secrets rather than repository-wide secrets whenever the value differs by environment. Production secrets must not be reused in `dev` or `uat`.

## Required GitHub Environment variables

Configure the following non-secret values in each GitHub Environment.

| Variable | Example / purpose | Source |
| --- | --- | --- |
| `GCP_PROJECT_ID` | `corvis-dev`, `corvis-uat`, `corvis-prod` | GCP project chosen for the environment |
| `GCP_REGION` | `asia-southeast1` | Fixed Singapore runtime region unless architecture changes |
| `GCP_WIF_PROVIDER` | Workload Identity Provider resource name | One-time GCP bootstrap output |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | Deploy service-account email | One-time GCP bootstrap output |
| `GCS_SOURCE_BUCKET_NAME` | Globally unique source bucket name | Chosen naming convention / Terraform input |
| `ARTIFACT_REGISTRY_REPOSITORY` | Usually `corvis` | Terraform input |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Cloudflare account |
| `CLOUDFLARE_ZONE_ID` | Zone ID for Corvis domain | Cloudflare zone |
| `CLOUDFLARE_ZONE_NAME` | e.g. `example.com` | Registered domain / Cloudflare zone |
| `CUSTOMER_HOSTNAME` | e.g. `app.example.com` | Environment DNS design |
| `ADMIN_HOSTNAME` | e.g. `admin.example.com` | Environment DNS design |
| `API_HOSTNAME` | e.g. `api.example.com` | Environment DNS design |
| `SUPABASE_ORG_ID` | Supabase organization ID | Supabase organization |
| `SUPABASE_PROJECT_NAME` | e.g. `corvis-dev` | Terraform/provider input |
| `SUPABASE_REGION` | `ap-southeast-1` | Singapore Supabase region |
| `CORVIS_AUTH_ISSUER` | Production IdP/Identity Platform issuer URL | Identity design |
| `CORVIS_AUTH_AUDIENCE` | e.g. `corvis` | Identity design |

### Optional variables

Set these only when the relevant adapter cannot derive them from deployed resources:

| Variable | When needed |
| --- | --- |
| `CORVIS_SEARCH_ENDPOINT` | External/specialist permissioned search service is enabled. Prefer a deployed internal service URL output where possible. |
| `CORVIS_AI_ENDPOINT` | AI answer/extraction service is external or separately deployed. Prefer deployment output where possible. |
| `CORVIS_OBSERVABILITY_ENDPOINT` | External telemetry collector is used instead of direct GCP telemetry. |
| `CORVIS_DATA_LIFECYCLE_ENDPOINT` | Separate lifecycle executor service is deployed. |
| `CORVIS_EXPORT_DELIVERY_ENDPOINT` | Separate export renderer/delivery service is deployed. |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile is enabled for a public surface. |

Do **not** manually maintain `CORVIS_UPLOAD_ALLOWED_ORIGINS` if it can be deterministically generated from `CUSTOMER_HOSTNAME` and `ADMIN_HOSTNAME` by the deployment workflow.

## Required GitHub Environment secrets

Keep the human-entered secret set intentionally small.

| Secret | Purpose | Notes |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Terraform/provider access to DNS/WAF/rules/TLS configuration | Use a least-privilege token. Prefer a distinct prod token. |
| `SUPABASE_ACCESS_TOKEN` | Terraform/Supabase management API access | Environment scoped where practical; never expose to runtime application containers. |
| `SUPABASE_DB_PASSWORD` | Database project/bootstrap password | Deployment uses it to construct/store the runtime Postgres DSN securely. Do not place the resulting DSN in Git. |

### Conditional external-provider secrets

Add only when the integration is enabled and cannot use federation/workload identity:

- `AUTH_IDP_CLIENT_SECRET` — only for an upstream OIDC provider that requires a client secret during Identity Platform configuration.
- `AI_PROVIDER_API_KEY` — only when a direct external model provider/API requires a static key.
- `SEARCH_PROVIDER_API_KEY` — only when a specialist external search provider is activated.
- `OBSERVABILITY_PROVIDER_TOKEN` — only when an external observability vendor is activated.
- `EMAIL_PROVIDER_API_KEY` — when transactional email is enabled through the approved provider.
- `TURNSTILE_SECRET_KEY` — when Turnstile server-side validation is enabled.
- any future provider credential must be documented here before production use.

## Secrets that must NOT be entered manually into GitHub

The following should be generated, derived or collected through the runtime product flow and stored in GCP Secret Manager, not manually maintained in multiple systems:

- `CORVIS_POSTGRES_DSN` — derive from the environment Supabase project/connection information plus the approved database password; write to Secret Manager.
- `CORVIS_TRUSTED_AUTH_PROXY_SECRET` — generate/rotate automatically if the compatibility gateway remains in use; retire when direct token verification replaces it.
- `CORVIS_WEBHOOK_SIGNING_SECRET` — generate/rotate automatically.
- `CORVIS_WORKER_SECRET` — generate/rotate automatically if static worker authentication remains required; prefer service identity where possible.
- internal service-to-service tokens — prefer IAM/OIDC/service identity; generate in Secret Manager only when a static token is unavoidable.
- **customer GP portal/data-room/source credentials, OAuth refresh tokens, passwords or session secrets** — collect/authorize through the authenticated customer portal and store directly as tenant-scoped runtime secrets; never copy them into GitHub.

GitHub Actions should not print these values and should not pass them as Terraform outputs or normal logs.

## Credentials that are explicitly prohibited

Do not add these secrets:

- `GCP_SERVICE_ACCOUNT_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS` containing JSON
- static GCP access tokens for CI
- AWS access key/secret key for the baseline architecture
- plaintext database DSNs in repository variables
- customer source-portal credentials or session tokens

GCP CI/CD uses GitHub OIDC → Workload Identity Federation. `GITHUB_TOKEN` is supplied automatically by GitHub Actions and must not be manually stored.

## Runtime configuration propagation

Expected flow:

```text
Human
  ↓ one-time deployment values
GitHub Environment vars/secrets: dev | uat | prod
  ↓ reviewed workflow
GitHub Actions
  ├─ OIDC → GCP Workload Identity Federation
  ├─ Terraform → Cloudflare / GCP / Supabase
  ├─ SQL migrations → Postgres
  ├─ deployment/runtime secrets → GCP Secret Manager
  ├─ derived URLs/IDs → deployment configuration
  └─ Cloud Run/Jobs → Secret Manager references + non-secret env vars

Customer administrator
  ↓ source authorization / credential setup in Corvis
Corvis runtime
  ├─ connection metadata → Postgres
  └─ source credential/token material → GCP Secret Manager
```

Provider management tokens such as `CLOUDFLARE_API_TOKEN` and `SUPABASE_ACCESS_TOKEN` are deployment credentials only. Do not copy them into Cloud Run.

## Derived runtime values

The deployment pipeline should derive these where possible instead of asking a human to set them:

- `CORVIS_OBJECT_STORE_BUCKET` ← `GCS_SOURCE_BUCKET_NAME` / Terraform output.
- `CORVIS_UPLOAD_ALLOWED_ORIGINS` ← customer/admin HTTPS hostnames.
- `CORVIS_POSTGRES_DSN` ← Supabase project connection output + database secret, then stored in Secret Manager.
- Cloud Run service URLs / internal adapter endpoints ← Terraform/deployment outputs.
- Artifact image URLs/digests ← build output.
- Cloudflare origin target ← GCP load-balancer/origin output.

Defaults such as `CORVIS_GCS_CHUNK_SIZE_BYTES=8388608` and malware metadata names should stay in code/config defaults unless an environment needs an explicit override.

## One-time setup outside GitHub

These are the deliberate exceptions to “configure it in GitHub and cascade it” because trust/account ownership must exist first:

1. Create/own the GCP organization/projects or bootstrap project and attach billing.
2. Create the initial GCP Workload Identity Pool/provider + deploy service account and authorize this GitHub repository/environment identity.
3. Register/own the domain and Cloudflare account/zone; create the first scoped Cloudflare API token.
4. Create/own the Supabase organization, attach billing where required and create the first management token.
5. Create GitHub Environments `dev`, `uat`, `prod` and enter the variables/secrets listed above.
6. Create/own any external provider account where account/billing/contract ownership cannot be bootstrapped safely by API.

After those trust roots exist, normal infrastructure/settings changes should be GitHub-driven. Customer source credentials remain intentionally customer/runtime-driven rather than GitHub-driven.

## Production protections

Recommended `prod` GitHub Environment rules:

- required reviewer/approval for deploy jobs once multiple operators exist;
- deployments only from the protected default branch or approved release refs;
- environment-scoped secrets only;
- no pull-request code from untrusted forks receives production secrets;
- deployment concurrency of one writer per environment;
- plan/preview before apply;
- database migration and infrastructure apply order is explicit;
- post-deploy acceptance tests must pass before the release is marked healthy.

`dev` may be highly automated. `uat` should mirror production topology and security while using synthetic/sanitized data. `prod` should require the strongest controls.

## Checklist

For each of `dev`, `uat`, `prod`:

- [ ] GitHub Environment exists.
- [ ] required variables are configured.
- [ ] required provider secrets are configured.
- [ ] GCP OIDC/WIF login works without a service-account key.
- [ ] Terraform can plan provider infrastructure from GitHub.
- [ ] Postgres migrations can be applied from GitHub.
- [ ] runtime secrets are present in GCP Secret Manager without plaintext in logs/state where avoidable.
- [ ] Cloud Run/Jobs use Secret Manager/workload identity rather than GitHub secrets directly at runtime.
- [ ] deployment acceptance tests pass.
