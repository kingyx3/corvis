# GCP bootstrap from GitHub Actions

Corvis is operated from GitHub Actions. No local `gcloud` is required for environment bootstrap, deployment, runtime-secret installation or acceptance execution.

## Trust boundary

A GitHub workflow cannot securely create its own first GCP trust relationship in a brand-new project: GCP must already know which GitHub identity it trusts before it will accept an OIDC token. Corvis does not work around that bootstrap paradox with a service-account JSON key, static access token or `GOOGLE_APPLICATION_CREDENTIALS` secret.

The only provider-side bootstrap exception is the initial trust anchor for each GCP project:

1. The GCP project exists and billing is attached.
2. `corvis-deploy@<project-id>.iam.gserviceaccount.com` exists.
3. A GitHub Workload Identity Pool/provider exists and is restricted to the `kingyx3/corvis` repository and the intended GitHub Environment subject.
4. That GitHub WIF identity may impersonate `corvis-deploy`.
5. `corvis-deploy` has the permissions required by the checked-in Terraform root. The current root manages project services, API Gateway/API Keys, Cloud Run, service accounts/IAM bindings, GCS/KMS/queues/secrets/observability and the provider resources already documented in `INFRASTRUCTURE.md`.
6. The GitHub Environment contains `GCP_PROJECT_ID` and the provider's full resource name as `GCP_WIF_PROVIDER`.

This trust anchor can be established through the Google Cloud administrative UI or an organization-owned provisioning process. It must not be established by copying a long-lived Google credential into GitHub.

Everything after the trust anchor is repository-owned and runs in GitHub Actions.

## First environment run

From **GitHub -> Actions -> Bootstrap GCP foundation**:

1. Select `dev`, `uat` or `prod`.
2. Run `action=plan` first.
3. Review the Terraform plan in the workflow log.
4. Rerun from `main` with `action=apply`.

The workflow authenticates with GitHub OIDC/WIF and the derived `corvis-deploy` identity. It verifies that the selected WIF provider belongs to the selected project and fails if the deploy service account has any user-managed keys.

Bootstrap deliberately forces the API image and Cloudflare zone to empty values. This means the initial apply provisions the Terraform-owned GCP foundation without accidentally publishing an API or creating a public edge. The foundation enables the managed services required by the checked-in architecture, including API Gateway/API Keys/service management, and provisions the protected Terraform state bucket, source storage, Artifact Registry, KMS, runtime service accounts, Pub/Sub/Tasks, Secret Manager resources and observability resources represented by the selected Terraform root.

The public API Gateway, restricted edge key, Cloudflare Worker and gateway-only Cloud Run invoker binding are created later by the normal deployment path when both an immutable API image and `CLOUDFLARE_ZONE_NAME` are configured.

The same remote Terraform state is used later by the normal deployment workflow, so bootstrap is a normal Terraform state transition rather than a parallel set of imperative resources.

## After bootstrap apply

Use GitHub Actions in this order:

1. **Runtime secrets** — install or rotate runtime secret versions through the repository workflow. Do not paste runtime secrets into ordinary GitHub variables.
2. **Build release image** — build the selected `main` commit into the environment's Artifact Registry and create GitHub build provenance.
3. **Terraform deploy** — run `plan`, then `apply`, passing the full built commit SHA as `release_sha`. The workflow resolves it to an immutable image digest and, when the edge is enabled, provisions/updates Cloud Run, API Gateway and the Cloudflare Worker path from Terraform.
4. **Security acceptance** — execute the production-like Worker/gateway/Cloud Run IAM and Postgres RLS checks. Only successful live acceptance may advance the known-good rollback pointer.

For UAT, complete the production-equivalent functional and isolation journey before production promotion. Production remains blocked by any external approval, provider, security-assessment or evidence gates tracked by the production-readiness plan.

## GitHub values

The bootstrap workflow consumes only the existing environment roots:

- `GCP_PROJECT_ID`
- `GCP_WIF_PROVIDER`

Cloudflare values are intentionally ignored during foundation bootstrap and are consumed only by the normal deployment path when the edge is activated.

API Gateway resource names, the gateway service account, gateway hostname and edge API key are derived/generated later by Terraform. No additional GCP credential or gateway-key secret is introduced in GitHub.

## Failure behavior

Bootstrap and deployment are fail-closed:

- missing project/provider roots stop before authentication;
- a provider resource from another GCP project is rejected;
- a user-managed key on `corvis-deploy` blocks bootstrap;
- `apply` is allowed only from `main`;
- Terraform retains the normal state lock and validation behavior;
- runtime and Cloudflare remain disabled during the bootstrap apply;
- an under-permissioned deploy identity fails Terraform rather than causing a static credential workaround;
- public API deployment requires an immutable release image;
- direct Cloud Run invocation is not recovered by granting `allUsers` invoker.

If the workflow fails because the initial trust anchor is absent or under-permissioned, correct that provider-side trust/authorization configuration. Do not add a static Google credential to GitHub as a workaround.
