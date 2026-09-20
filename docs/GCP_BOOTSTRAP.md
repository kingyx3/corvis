# GCP bootstrap from GitHub Actions

Corvis is operated from GitHub Actions. No local `gcloud` is required for environment bootstrap, deployment, runtime-secret installation or acceptance execution.

## Trust boundary

A GitHub workflow cannot securely create its own first GCP trust relationship in a brand-new project: GCP must already know which GitHub identity it trusts before it will accept an OIDC token. Corvis does not work around that bootstrap paradox with a service-account JSON key, static access token or `GOOGLE_APPLICATION_CREDENTIALS` secret.

The only provider-side bootstrap exception is the initial trust anchor for each GCP project:

1. The GCP project exists and billing is attached.
2. `corvis-deploy@<project-id>.iam.gserviceaccount.com` exists.
3. A GitHub Workload Identity Pool/provider exists and is restricted to the `kingyx3/corvis` repository and the intended GitHub Environment subject.
4. That GitHub WIF identity may impersonate `corvis-deploy`, and `corvis-deploy` has the permissions required by the checked-in Terraform root.
5. The GitHub Environment contains `GCP_PROJECT_ID` and the provider's full resource name as `GCP_WIF_PROVIDER`.

This trust anchor can be established through the Google Cloud administrative UI or an organization-owned provisioning process. It must not be established by copying a long-lived Google credential into GitHub.

Everything after the trust anchor is repository-owned and runs in GitHub Actions.

## First environment run

From **GitHub -> Actions -> Bootstrap GCP foundation**:

1. Select `dev`, `uat` or `prod`.
2. Run `action=plan` first.
3. Review the Terraform plan in the workflow log.
4. Rerun from `main` with `action=apply`.

The workflow authenticates with GitHub OIDC/WIF and the derived `corvis-deploy` identity. It verifies that the selected WIF provider belongs to the selected project and fails if the deploy service account has any user-managed keys.

Bootstrap deliberately forces the API image and Cloudflare zone to empty values. This means the initial apply provisions the Terraform-owned GCP foundation without accidentally publishing an API or creating a public edge. The foundation includes the protected Terraform state bucket, enabled platform services, source storage, Artifact Registry, KMS, runtime service accounts, Pub/Sub/Tasks, Secret Manager resources and observability resources represented by the selected Terraform root.

The same remote Terraform state is used later by the normal deployment workflow, so bootstrap is a normal Terraform state transition rather than a parallel set of imperative resources.

## After bootstrap apply

Use GitHub Actions in this order:

1. **Runtime secrets** — install or rotate runtime secret versions through the repository workflow. Do not paste runtime secrets into ordinary GitHub variables.
2. **Build release image** — build the selected `main` commit into the environment's Artifact Registry and create GitHub build provenance.
3. **Terraform deploy** — run `plan`, then `apply`, passing the full built commit SHA as `release_sha`. The workflow resolves it to an immutable image digest.
4. **Security acceptance** — execute the production-like security checks. Only successful live acceptance may advance the known-good rollback pointer.

For UAT, complete the production-equivalent functional and isolation journey before production promotion. Production remains blocked by any external approval, provider, security-assessment or evidence gates tracked by the production-readiness plan.

## GitHub values

The bootstrap workflow consumes only the existing environment roots:

- `GCP_PROJECT_ID`
- `GCP_WIF_PROVIDER`

Cloudflare values are intentionally ignored during foundation bootstrap and are consumed only by the normal deployment path when the edge is activated.

No additional GCP credential secret is introduced.

## Failure behavior

Bootstrap is fail-closed:

- missing project/provider roots stop before authentication;
- a provider resource from another GCP project is rejected;
- a user-managed key on `corvis-deploy` blocks bootstrap;
- `apply` is allowed only from `main`;
- Terraform retains the normal state lock and validation behavior;
- runtime and Cloudflare remain disabled during the bootstrap apply.

If the workflow fails because the initial trust anchor is absent or under-permissioned, fix that provider-side trust configuration. Do not add a static Google credential to GitHub as a workaround.
