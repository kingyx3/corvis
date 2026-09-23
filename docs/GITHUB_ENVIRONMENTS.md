# GitHub Environments, variables and secrets

This is the canonical setup checklist for repository deployment configuration.

## Policy

Corvis uses GitHub Environments `dev`, `uat`, and `prod`.

Keep GitHub configuration to **external trust roots and genuine operator decisions only**. Anything deterministic from those roots, the selected environment, Terraform/provider lookups, deployed-resource outputs, or fixed architecture defaults must be derived in code instead of copied into another GitHub variable.

GitHub is the deployment/configuration control plane, not the long-term runtime secret store. Runtime secrets belong in GCP Secret Manager. Customer source credentials are tenant runtime secrets configured through the authenticated product, never GitHub deployment secrets.

After the one-time provider-side GCP trust anchor exists, operators use GitHub Actions rather than local `gcloud` or Terraform. See [`GCP_BOOTSTRAP.md`](GCP_BOOTSTRAP.md) and the `Bootstrap GCP foundation` workflow.

## Active GitHub variables

### Required in every environment

| Variable | Purpose | Why it remains a root |
| --- | --- | --- |
| `GCP_PROJECT_ID` | Target GCP project | Externally assigned/global identifier; cannot be safely inferred from `dev`/`uat`/`prod`. |
| `GCP_WIF_PROVIDER` | Full Workload Identity Provider resource name | Required before GitHub can authenticate to GCP; the project number inside the resource name is not available until trust is established. |

### Required before promoting a production-like runtime (`uat` / `prod`)

| Variable | Purpose | Why it remains a root |
| --- | --- | --- |
| `CORVIS_AUTH_ISSUER` | HTTPS OIDC issuer used to authenticate customer/API subjects | External identity-provider contract. Terraform deliberately refuses runtime activation without it. |
| `CORVIS_AUTH_AUDIENCE` | Audience/client identifier expected in OIDC access tokens | Provider/customer identity decision. Defaults to `corvis` in workflow code only when that is the actual configured audience. |
| `CORVIS_CONTROL_TENANT_ID` | Tenant that owns retained sanitized automated control evidence | Environment data/control decision; not a credential. Required only by Security acceptance evidence collection. |

`CORVIS_AUTH_JWKS_URL` is optional. Leave it unset for standards-compliant OIDC discovery. Set it only when the approved issuer requires an explicit HTTPS JWKS endpoint.

SAML may still be supported through a reviewed identity broker that emits the existing signed Corvis assertion contract. That broker and its signing material are conditional provider/runtime configuration, not baseline GitHub values. The default production path verifies OIDC bearer tokens directly and then re-resolves effective tenant membership, roles, rights and session state from Postgres.

### Cloudflare edge (`uat` / `prod` only)

| Variable | Purpose | Why it remains |
| --- | --- | --- |
| `CLOUDFLARE_ZONE_NAME` | Registered Corvis Cloudflare zone | External domain ownership. Prefer one repository-level variable if UAT and prod share the same root zone. |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | Enables plan-dependent Cloudflare/OWASP managed rulesets | Intentional rollout/capability decision, not a value that can be inferred safely. Defaults to `false`. |

`API_IMAGE` is not a human-managed GitHub Environment variable. `build-release.yml` publishes `git-<commit>` to the environment's Artifact Registry repository, and `terraform-deploy.yml` resolves the selected `release_sha` to an immutable digest before Terraform runs. A fully successful live Security acceptance run separately records the environment's exact deployed digest as its known-good rollback target.

When `CLOUDFLARE_ZONE_NAME` is configured, Terraform deployment must select either a built `release_sha` or `rollback_known_good=true`. Normal UAT/prod Terraform apply also requires one of those selections even if the edge is temporarily unpublished; the guarded decommission workflow is the only normal path that intentionally removes a runtime.

No extra GitHub variable is required for API Gateway, Cloud Run IAM checks, Cloudflare account lookup, worker URLs/audiences, Pub/Sub/Cloud Tasks/Scheduler identities, or direct-bypass probes. Terraform/workflows derive those values from GCP and Cloudflare through the existing WIF/provider roots.

No GitHub variable is required for the Postgres DSN secret name. The canonical Terraform-owned Secret Manager container is `corvis-postgres-dsn-${environment}`.

### Cost and alert routing (optional, `uat` / `prod`)

| Variable | Purpose | Why it remains a root |
| --- | --- | --- |
| `GCP_BILLING_ACCOUNT_ID` | Billing account (`XXXXXX-XXXXXX-XXXXXX`) that receives the Terraform-managed monthly budget | Externally owned billing relationship; not derivable from the project through the deploy identity. Unset disables budget creation. |
| `MONITORING_NOTIFICATION_CHANNEL_IDS` | Existing Cloud Monitoring notification channels attached to SLO alerts and the budget, as an HCL/JSON list of full resource names, e.g. `["projects/<project>/notificationChannels/123"]` | Channels (email/pager/chat) are created once outside Terraform. Unset defaults to `[]` (alerts are created without routing). |

Bootstrap, Terraform deploy and decommission all pass these as `TF_VAR_billing_account_id` / `TF_VAR_monitoring_notification_channel_ids`, so every workflow plans the same budget/alert routing. When `GCP_BILLING_ACCOUNT_ID` is set, `corvis-deploy` additionally needs budget permissions **on the billing account** (for example `roles/billing.costsManager`, which includes `billing.budgets.*`); project-level roles are not sufficient.

## Active GitHub secrets

| Secret | Scope | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `uat` / `prod` when edge deployment is enabled | Least-privilege deployment credential for Cloudflare DNS/Worker/zone/rules configuration. |
| `RELEASE_GOVERNANCE_TOKEN` | Environment secret in `dev`, `uat` and `prod` | Read-only use by the `Verify effective release governance` step of `build-release.yml` and `terraform-deploy.yml` (apply) to prove `main` rulesets are active and non-bypassable. |

### `RELEASE_GOVERNANCE_TOKEN`

The release governance verifier (`.github/scripts/release-governance.mjs`) treats a ruleset as enforcing only when GitHub returns an explicit, empty `bypass_actors` list. GitHub returns `bypass_actors` from `GET /repos/{owner}/{repo}/rulesets/{id}` only to callers with write access to that ruleset (repository admin), and the workflow `GITHUB_TOKEN` can never be granted that. Without a dedicated token every UAT build and every Terraform apply fails with `Release governance token lacks ruleset admin visibility`.

Create one of:

- a **fine-grained personal access token** scoped to only `kingyx3/corvis`, with repository permissions **Administration: Read and write** (required for GitHub to include `bypass_actors`), **Contents: Read** (compare release SHA against `main`), **Checks: Read** (exact-commit check runs) and the implicit **Metadata: Read**; or
- a **GitHub App** installed only on `kingyx3/corvis` with the same repository permissions, minting a short-lived installation token.

If an organization-level ruleset ever applies to `main`, the token owner/App also needs organization **Administration** read and write so the parent ruleset's bypass list is visible. The workflows use the token only for the read-only GET calls in that single step; no other step receives it. Store it as an **environment secret** in each of `dev`, `uat` and `prod` (not a repository secret) so it is released only to jobs bound to a protected, main-only GitHub Environment. Set an expiry and rotate it; an expired token fails closed with `Release governance read failed (401)`.

There are **no custom GCP credential secrets**. GCP CI/CD uses GitHub OIDC -> Workload Identity Federation. `GITHUB_TOKEN` is supplied automatically by GitHub Actions and must not be created manually.

The API Gateway edge API key is also **not** a manually entered GitHub secret. Terraform creates a key restricted to the Corvis managed API and passes it as a sensitive value into the Cloudflare Worker `secret_text` binding. Protected Terraform state is therefore security-sensitive and must remain access-controlled.

The Postgres DSN is not duplicated into GitHub. Provider activation writes it directly into the Terraform-owned Secret Manager container. Deployment migrations, runtime workloads and Security acceptance all read that same managed value through WIF/IAM.

## Values derived automatically

The build, deployment and acceptance workflows derive these instead of storing them in GitHub:

| Derived value | Derivation |
| --- | --- |
| GCP region | `asia-southeast1` |
| Deploy service account | `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` |
| Source/document bucket | `${GCP_PROJECT_ID}-documents` |
| Terraform state bucket | `${GCP_PROJECT_ID}-corvis-tf-state` |
| Terraform root | `infra/terraform/environments/${environment}` |
| Artifact Registry repository | Terraform module default `corvis` |
| API image repository | `asia-southeast1-docker.pkg.dev/${GCP_PROJECT_ID}/corvis/api` |
| Release image tag | `git-${full_commit_sha}` produced only by the release build workflow |
| Runtime API/worker image | Artifact Registry resolution of the selected release tag to the same `image@sha256:<digest>` |
| Known-good rollback image | Versioned `gs://${GCP_PROJECT_ID}-corvis-tf-state/releases/${environment}/known-good.json`, advanced only after live acceptance passes |
| Cloudflare zone/account IDs | Provider lookup by `CLOUDFLARE_ZONE_NAME` using `CLOUDFLARE_API_TOKEN` |
| Production API / customer / admin hostnames | `api.${zone}` / `app.${zone}` / `admin.${zone}` |
| UAT API / customer / admin hostnames | `api-uat.${zone}` / `app-uat.${zone}` / `admin-uat.${zone}` (single-level labels so Cloudflare Universal SSL on Free/Pro covers them; `*.uat.${zone}` would not be) |
| API Gateway IDs/default hostname | Terraform names/provider output from project + environment |
| Gateway service account | `corvis-gateway-${environment}@${GCP_PROJECT_ID}.iam.gserviceaccount.com` |
| Gateway edge API key | Terraform-generated Google API key restricted to the generated Corvis managed API and injected into the Worker secret binding |
| API Cloud Run URL | Provider output; used only behind API Gateway and for negative IAM acceptance |
| Worker Cloud Run URL | Provider output; used only by managed Pub/Sub/Cloud Tasks/Scheduler transport and negative IAM acceptance |
| Worker OIDC audience | `https://corvis-worker-${environment}.internal` and configured as a Cloud Run custom audience |
| Worker service account | `corvis-worker-${environment}@${GCP_PROJECT_ID}.iam.gserviceaccount.com` |
| Processing topic / queue / subscription / scheduler | Terraform names derived from project + environment |
| Postgres DSN secret name | `corvis-postgres-dsn-${environment}` |

Cloud Run service URLs, image digests, runtime endpoints and future customer/admin origin addresses must flow from provider/build outputs rather than becoming GitHub variables.

## GitHub values to remove or avoid creating

Remove these if they already exist; they are fixed, derived, provider-resolvable, or belong in managed runtime/provider state:

- `API_IMAGE`
- `GCP_REGION`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCS_SOURCE_BUCKET_NAME`
- `ARTIFACT_REGISTRY_REPOSITORY`
- `GCP_ORIGIN_IPV4_ADDRESS`
- `GCP_DIRECT_ORIGIN_PROBE_URLS`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `API_GATEWAY_HOSTNAME`
- `API_GATEWAY_API_KEY`
- `API_HOSTNAME`
- `CORVIS_POSTGRES_DSN_SECRET_NAME`
- `CORVIS_PROCESSING_WORKER_URL`
- `CORVIS_PROCESSING_WORKER_AUDIENCE`
- `CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT`

Do not store plaintext DSNs, gateway API keys, generated runtime secrets, or provider-derived identifiers as ordinary GitHub variables.

## Conditional future provider roots

Only add a provider credential when that integration is actually enabled and federation/provider lookup cannot replace it. Examples include `SUPABASE_ACCESS_TOKEN`, an OIDC/SAML broker client secret, or a direct external AI/search/email provider API key.

For Supabase, derive the project name from the environment, keep the Singapore region in code, generate the database bootstrap password through the provider path where supported, and write the runtime DSN directly to GCP Secret Manager. Do not pre-create unused GitHub secrets.

## Secrets that must not be entered manually into GitHub

Generate, derive, or collect these through deployment/runtime flows and store them in their intended managed stores instead:

- `CORVIS_POSTGRES_DSN`
- optional identity-broker signing material such as `CORVIS_TRUSTED_AUTH_PROXY_SECRET` if the SAML/broker path is activated
- API Gateway edge API keys
- internal service-to-service credentials when Google workload identity cannot replace them
- Snowflake runtime OAuth/access material
- customer GP portal/data-room/source credentials, OAuth refresh tokens, passwords, and session secrets

`CORVIS_WORKER_SECRET` is not a production secret. It remains only as a local/non-production compatibility path; GCP production worker calls use Google-signed OIDC.

Explicitly prohibited GitHub credentials include GCP service-account JSON keys, `GOOGLE_APPLICATION_CREDENTIALS` JSON, static GCP access tokens, plaintext database DSNs, and customer source credentials.

## One-time setup outside GitHub

There is one unavoidable trust-bootstrap exception. A workflow cannot grant itself first access to an otherwise untrusted GCP project without introducing a static bootstrap credential, which Corvis prohibits.

1. Create/own the GCP projects and attach billing.
2. In each project, create the `corvis-deploy` service account.
3. Create the GitHub Workload Identity Pool/provider, restrict it to `kingyx3/corvis` and the intended environment identity, and authorize it to impersonate `corvis-deploy`.
4. Give `corvis-deploy` the permissions required by the checked-in Terraform root, including creation/configuration of Cloud Run, Cloud Scheduler, Pub/Sub, Cloud Tasks, API Gateway/API Keys, Secret Manager IAM, service identities and enabled project services. Keep this as a deployment identity, not a runtime identity.
5. Create GitHub Environments `dev`, `uat`, and `prod` and set `GCP_PROJECT_ID` + `GCP_WIF_PROVIDER`.
6. From GitHub Actions, run **Bootstrap GCP foundation** with `plan`, then `apply`. From this point onward the GCP environment lifecycle is operated from GitHub Actions.
7. Before a production-like runtime promotion, activate the separate environment Supabase/Postgres project, write its TLS-verified DSN directly into `corvis-postgres-dsn-${environment}`, and configure `CORVIS_AUTH_ISSUER`/`CORVIS_AUTH_AUDIENCE` (plus optional `CORVIS_AUTH_JWKS_URL`).
8. Register/own the Cloudflare zone. When API edge deployment is enabled, set `CLOUDFLARE_ZONE_NAME`, the managed-WAF rollout flag if needed, and the scoped `CLOUDFLARE_API_TOKEN`. Build the selected main commit into that environment's Artifact Registry before normal deployment.

Do not run local `gcloud` or Terraform for routine Corvis environment management. Do not create a temporary Google credential secret to avoid the initial WIF trust step.

## Promotion sequence

Normal production-like promotion is intentionally one GitHub-owned path:

1. **Build release image** from reviewed `main` and retain provenance.
2. **Runtime secret readiness** confirms the Terraform-owned Postgres secret has an enabled provider-written version without reading it.
3. **Terraform deploy / plan** resolves the immutable release and produces the exact plan.
4. On apply, the workflow reads the DSN through WIF, applies only pending checksum-verified Postgres migrations and uploads sanitized migration evidence.
5. The exact reviewed Terraform plan is applied, creating/updating API + worker runtimes and their managed transports.
6. Public API health must pass through Cloudflare -> Worker -> API Gateway -> Cloud Run.
7. **Security acceptance** proves edge/origin/worker IAM and live Postgres RLS boundaries. Only a fully passing run advances the known-good rollback pointer.

Normal deploy never doubles as decommission. `gcp-decommission.yml` exclusively owns idle/full lifecycle transitions.

## Production protections

For `prod`, require reviewed deployments once multiple operators exist, deploy only from approved refs, keep provider secrets environment-scoped, prevent untrusted PR code from receiving secrets, allow one infrastructure writer at a time, require plan-before-apply, and retain post-deploy acceptance evidence. While Corvis has one maintainer, the non-bypassable PR + strict required-check policy is the enforceable release gate; when another operator is added, enable required approval + last-push approval without changing the release verifier.

## Per-environment checklist

- [ ] GitHub Environment exists.
- [ ] `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER` are configured.
- [ ] `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` exists and is impersonable by the GitHub WIF identity.
- [ ] the deploy identity has the Terraform permissions required by the current checked-in root, including API Gateway/API Keys, Cloud Scheduler/Pub/Sub/Cloud Tasks and service-account IAM configuration.
- [ ] `Bootstrap GCP foundation` plan succeeds, then apply succeeds from `main`.
- [ ] obsolete derived GitHub variables and old origin/gateway secrets are absent.
- [ ] no custom GCP credential secret exists in GitHub.
- [ ] `RELEASE_GOVERNANCE_TOKEN` environment secret is set (Administration read/write, Contents read, Checks read, this repository only) and unexpired.
- [ ] the separate environment Postgres provider is activated and `corvis-postgres-dsn-${environment}` has an enabled version.
- [ ] `CORVIS_AUTH_ISSUER` / `CORVIS_AUTH_AUDIENCE` match the approved environment IdP.
- [ ] the selected release commit has been built and attested in the target environment Artifact Registry.
- [ ] deployment resolves the release tag to an immutable digest and applies migrations before the exact Terraform plan.
- [ ] Cloudflare roots exist only where public edge deployment is enabled.
- [ ] deployed API/worker workloads use keyless service identities and Secret Manager references.
- [ ] Pub/Sub push, Cloud Tasks retry and Cloud Scheduler dispatch target the private worker with the dedicated Google OIDC identity/audience.
- [ ] live security acceptance proves Worker traversal, invalid/missing gateway-key rejection, direct API/worker Cloud Run IAM rejection, exact invoker policies and live Postgres RLS before the known-good rollback pointer is advanced.
