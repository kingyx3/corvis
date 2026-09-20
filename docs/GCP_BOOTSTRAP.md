# GCP bootstrap from GitHub Actions

Corvis is operated from GitHub Actions. No local `gcloud` is required for environment bootstrap, deployment, runtime-secret installation, decommissioning or acceptance execution. See [`ENVIRONMENT_LIFECYCLE.md`](ENVIRONMENT_LIFECYCLE.md) for the complete provision/idle/full-teardown model.

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

Bootstrap is the **only** workflow that may create the remote Terraform backend. It creates or hardens `${GCP_PROJECT_ID}-corvis-tf-state` with uniform bucket-level access, public-access prevention and object versioning. Soft delete is disabled because state recovery is provided by versioning; noncurrent versions are automatically deleted after 30 days or once more than 20 newer versions exist.

Bootstrap deliberately forces the API image and Cloudflare zone to empty values. This means the initial apply provisions the Terraform-owned GCP foundation without accidentally publishing an API or creating a public edge. The foundation enables the managed services required by the checked-in architecture, including API Gateway/API Keys/service management, and provisions source storage, Artifact Registry, KMS, runtime service accounts, Pub/Sub/Tasks, Secret Manager resources and observability resources represented by the selected Terraform root.

The public API Gateway, restricted edge key, Cloudflare Worker and gateway-only Cloud Run invoker binding are created later by the normal deployment path when both an immutable API image and `CLOUDFLARE_ZONE_NAME` are configured.

The same remote Terraform state is used later by the normal deployment workflow, so bootstrap is a normal Terraform state transition rather than a parallel set of imperative resources. Normal `Terraform deploy` only accepts an existing backend; it never recreates a missing state bucket.

## Re-bootstrap after full decommission

Full decommission deletes the Terraform-managed environment and the remote state bucket but intentionally retains the minimum provider trust anchors: the project, GitHub WIF trust, `corvis-deploy`, and the KMS key/key-ring with rotation removed and enabled versions disabled.

Running **Bootstrap GCP foundation** again recreates the protected state bucket, automatically imports those retained KMS resources into the new state, re-enables the primary key version when necessary, and then recreates the foundation. No local Terraform import or `gcloud` recovery procedure is required.

This re-adoption step is why normal deployment must fail when the state bucket is absent: bootstrap owns the safe transition from no state back to managed state.

## After bootstrap apply

Use GitHub Actions in this order:

1. **Runtime secrets** — install or rotate runtime secret versions through the repository workflow. Do not paste runtime secrets into ordinary GitHub variables.
2. **Build release image** — build the selected `main` commit into the environment's Artifact Registry and create GitHub build provenance.
3. **Terraform deploy** — run `plan`, then `apply`, passing the full built commit SHA as `release_sha`. The workflow resolves it to an immutable image digest and, when the edge is enabled, provisions/updates Cloud Run, API Gateway and the Cloudflare Worker path from Terraform.
4. **Security acceptance** — execute the production-like Worker/gateway/Cloud Run IAM and Postgres RLS checks. Only successful live acceptance may advance the known-good rollback pointer.

For UAT, complete the production-equivalent functional and isolation journey before production promotion. Production remains blocked by any external approval, provider, security-assessment or evidence gates tracked by the production-readiness plan.

## When an environment is not in use

Use **Decommission GCP environment** rather than ad hoc console deletion.

- `mode=idle` removes Cloud Run and the public edge while retaining durable data, queues, identities, secrets, Artifact Registry and Terraform state. Apply requires the exact confirmation `IDLE <environment>`.
- `mode=full` deletes Terraform-managed data/resources and then the remote state bucket last. Apply requires the exact confirmation `DECOMMISSION <environment> DELETE DATA AND STATE`.

Both apply modes are `main`-only and use the selected GitHub Environment. Full mode is destructive and deletes source data, images, runtime secrets and known-good rollback state; use idle mode when data must be retained.

## GitHub values

The bootstrap workflow consumes only the existing environment roots:

- `GCP_PROJECT_ID`
- `GCP_WIF_PROVIDER`

Cloudflare values are intentionally ignored during foundation bootstrap and are consumed only by the normal deployment path when the edge is activated.

API Gateway resource names, the gateway service account, gateway hostname and edge API key are derived/generated later by Terraform. No additional GCP credential or gateway-key secret is introduced in GitHub. The lifecycle workflows introduce no new human-managed variable or secret.

## Failure behavior

Bootstrap, deployment and decommissioning are fail-closed:

- missing project/provider roots stop before authentication;
- a provider resource from another GCP project is rejected;
- a user-managed key on `corvis-deploy` blocks bootstrap;
- normal deployment stops if bootstrap-owned Terraform state is missing;
- `apply` is allowed only from `main`;
- Terraform retains the normal state lock and validation behavior;
- runtime and Cloudflare remain disabled during the bootstrap apply;
- an under-permissioned deploy identity fails Terraform rather than causing a static credential workaround;
- public API deployment requires an immutable release image;
- direct Cloud Run invocation is not recovered by granting `allUsers` invoker;
- idle/full decommission apply requires an exact typed confirmation;
- full decommission refuses to delete the state bucket until Terraform reports no remaining managed resources.

If the workflow fails because the initial trust anchor is absent or under-permissioned, correct that provider-side trust/authorization configuration. Do not add a static Google credential to GitHub as a workaround.
