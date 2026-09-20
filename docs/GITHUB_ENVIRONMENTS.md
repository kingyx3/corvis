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

### Cloudflare edge (`uat` / `prod` only)

| Variable | Purpose | Why it remains |
| --- | --- | --- |
| `CLOUDFLARE_ZONE_NAME` | Registered Corvis Cloudflare zone | External domain ownership. Prefer one repository-level variable if UAT and prod share the same root zone. |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | Enables plan-dependent Cloudflare/OWASP managed rulesets | Intentional rollout/capability decision, not a value that can be inferred safely. Defaults to `false`. |

`API_IMAGE` is not a human-managed GitHub Environment variable. `build-release.yml` publishes `git-<commit>` to the environment's Artifact Registry repository, and `terraform-deploy.yml` resolves the selected `release_sha` to an immutable digest before Terraform runs. A fully successful live Security acceptance run separately records the environment's exact deployed digest as its known-good rollback target.

When `CLOUDFLARE_ZONE_NAME` is configured, Terraform deployment must select either a built `release_sha` or `rollback_known_good=true`. The edge remains fail-closed if no immutable API image is selected.

No extra GitHub variable is required for API Gateway, Cloud Run IAM checks, Cloudflare account lookup, or direct-bypass probes. Terraform/workflows derive those values from GCP and Cloudflare through the existing WIF/provider roots.

No GitHub variable is required for the Postgres DSN secret name. Security acceptance derives the contract `corvis-${environment}-postgres-dsn`.

## Active GitHub secrets

| Secret | Scope | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `uat` / `prod` when edge deployment is enabled | Least-privilege deployment credential for Cloudflare DNS/Worker/zone/rules configuration. |

There are **no custom GCP credential secrets**. GCP CI/CD uses GitHub OIDC -> Workload Identity Federation. `GITHUB_TOKEN` is supplied automatically by GitHub Actions and must not be created manually.

The API Gateway edge API key is also **not** a manually entered GitHub secret. Terraform creates a key restricted to the Corvis managed API and passes it as a sensitive value into the Cloudflare Worker `secret_text` binding. The protected Terraform state is therefore security-sensitive and must remain access-controlled.

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
| Runtime API image | Artifact Registry resolution of the selected release tag to `image@sha256:<digest>` |
| Known-good rollback image | Versioned `gs://${GCP_PROJECT_ID}-corvis-tf-state/releases/${environment}/known-good.json`, advanced only after both live Security acceptance jobs pass |
| Cloudflare zone ID | Provider lookup by `CLOUDFLARE_ZONE_NAME` using `CLOUDFLARE_API_TOKEN` |
| Cloudflare account ID | Derived from the selected Cloudflare zone lookup |
| Production API hostname | `api.${zone}` |
| UAT API hostname | `api.uat.${zone}` |
| API Gateway API/config/gateway IDs | Terraform names derived from project + environment |
| API Gateway default hostname | `google_api_gateway_gateway` provider output; used only as Worker upstream and security-acceptance probe target |
| Gateway service account | `corvis-gateway-${environment}@${GCP_PROJECT_ID}.iam.gserviceaccount.com` |
| Gateway edge API key | Terraform-generated Google API key restricted to the generated Corvis managed API and injected into the Worker secret binding |
| Cloud Run URL | GCP provider/runtime output; queried directly for negative IAM acceptance only |
| Postgres DSN secret name | `corvis-${environment}-postgres-dsn` |
| API/worker service-account names | Terraform resources derived from project + environment |

Cloud Run service URLs, image digests, runtime endpoints and future customer/admin origin addresses must likewise flow from provider/build outputs rather than becoming GitHub variables.

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
- `CUSTOMER_HOSTNAME`
- `ADMIN_HOSTNAME`
- `API_HOSTNAME`
- `CORVIS_POSTGRES_DSN_SECRET_NAME`

Do not store plaintext DSNs, gateway API keys, generated runtime secrets, or provider-derived identifiers as ordinary GitHub variables.

## Conditional future provider roots

Only add a provider credential when that integration is actually enabled and federation/provider lookup cannot replace it. Examples include `SUPABASE_ACCESS_TOKEN`, an upstream OIDC client secret, or a direct external AI/search/email provider API key.

For Supabase, derive the project name from the environment, keep the Singapore region in code, generate the database bootstrap password through the deployment path where supported, and write the runtime DSN to GCP Secret Manager. Do not pre-create unused GitHub secrets.

## Secrets that must not be entered manually into GitHub

Generate, derive, or collect these through deployment/runtime flows and store them in their intended managed stores instead:

- `CORVIS_POSTGRES_DSN`
- `CORVIS_TRUSTED_AUTH_PROXY_SECRET`
- `CORVIS_WORKER_SECRET`
- API Gateway edge API keys
- internal service-to-service tokens when workload identity cannot replace them
- Snowflake runtime OAuth/access material
- customer GP portal/data-room/source credentials, OAuth refresh tokens, passwords, and session secrets

Explicitly prohibited GitHub credentials include GCP service-account JSON keys, `GOOGLE_APPLICATION_CREDENTIALS` JSON, static GCP access tokens, plaintext database DSNs, and customer source credentials.

## One-time setup outside GitHub

There is one unavoidable trust-bootstrap exception. A workflow cannot grant itself first access to an otherwise untrusted GCP project without introducing a static bootstrap credential, which Corvis prohibits.

1. Create/own the GCP projects and attach billing.
2. In each project, create the `corvis-deploy` service account.
3. Create the GitHub Workload Identity Pool/provider, restrict it to `kingyx3/corvis` and the intended environment identity, and authorize it to impersonate `corvis-deploy`.
4. Give `corvis-deploy` the permissions required by the checked-in Terraform root, including creation/configuration of the serverless platform, API Gateway/API Keys, IAM bindings/service identities and enabled project services. Keep this as a deployment identity, not a runtime identity.
5. Create GitHub Environments `dev`, `uat`, and `prod` and set `GCP_PROJECT_ID` + `GCP_WIF_PROVIDER`.
6. From GitHub Actions, run **Bootstrap GCP foundation** with `plan`, then `apply`. From this point onward the GCP environment lifecycle is operated from GitHub Actions.
7. Register/own the Cloudflare zone. When API edge deployment is enabled, set `CLOUDFLARE_ZONE_NAME`, the managed-WAF rollout flag if needed, and the scoped `CLOUDFLARE_API_TOKEN`. The token must include the Worker permissions required by the checked-in Cloudflare Terraform resources. Build the selected main commit into that environment's Artifact Registry before normal deployment.

Do not run local `gcloud` or Terraform for routine Corvis environment management. Do not create a temporary Google credential secret to avoid the initial WIF trust step.

## Production protections

For `prod`, require reviewed deployments once multiple operators exist, deploy only from approved refs, keep provider secrets environment-scoped, prevent untrusted PR code from receiving secrets, allow one infrastructure writer at a time, require plan-before-apply, and retain post-deploy acceptance evidence.

## Per-environment checklist

- [ ] GitHub Environment exists.
- [ ] `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER` are configured.
- [ ] `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` exists and is impersonable by the GitHub WIF identity.
- [ ] the deploy identity has the Terraform permissions required by the current checked-in root, including API Gateway/API Keys/service-account IAM configuration.
- [ ] `Bootstrap GCP foundation` plan succeeds, then apply succeeds from `main`.
- [ ] obsolete derived GitHub variables, including `API_IMAGE` and old origin-IP values, are removed.
- [ ] no custom GCP credential secret exists in GitHub.
- [ ] the selected release commit has been built and attested in the target environment Artifact Registry.
- [ ] deployment resolves the release tag to an immutable digest before Terraform plan/apply.
- [ ] Cloudflare roots exist only where API edge deployment is enabled.
- [ ] Terraform plan succeeds using derived Cloudflare account/zone lookup, API Gateway resources, Worker secret binding and gateway-only Cloud Run IAM.
- [ ] runtime secrets are in GCP Secret Manager, not GitHub.
- [ ] deployed workloads use workload identity/Secret Manager references.
- [ ] live security acceptance proves Worker traversal, invalid/missing gateway-key rejection, direct Cloud Run IAM rejection and gateway-only invoker policy before the known-good rollback pointer is advanced.
