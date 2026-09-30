# GCP pre-bootstrap trust anchor runbook

This runbook is the **one-time provider-side setup that must exist before the first Corvis GitHub Actions GCP bootstrap can authenticate**. It is intentionally separate from [`GCP_BOOTSTRAP.md`](GCP_BOOTSTRAP.md): this document creates the initial Google Cloud trust anchor; after it succeeds, the checked-in GitHub Actions and Terraform own the normal Corvis infrastructure lifecycle.

For UAT, use this document once for the dedicated UAT GCP project. Repeat the same pattern for `dev` or `prod` with the matching GitHub Environment and GCP project.

## Why this step is outside GitHub Actions

A brand-new GitHub-hosted runner has no Google credential. GitHub OIDC can become a Google credential only after Google already has a Workload Identity Pool/provider that trusts the intended GitHub identity. Therefore the first pool/provider cannot securely create itself through the same keyless GitHub path.

Corvis does **not** solve that bootstrap dependency by storing a service-account JSON key in GitHub. Use Google Cloud Shell (or an equivalent organization-controlled administrator session) once, then use GitHub OIDC -> Workload Identity Federation thereafter.

The repository verifies this trust boundary before Terraform runs. The configured provider must:

- belong to the selected GCP project;
- map `google.subject` to `assertion.sub`;
- restrict admission to repository `kingyx3/corvis`;
- restrict admission to the selected GitHub Environment (`uat` in the example below);
- restrict admission to `refs/heads/main`;
- allow that GitHub identity to impersonate `corvis-deploy@<project-id>.iam.gserviceaccount.com` through `roles/iam.workloadIdentityUser`;
- have no user-managed key on `corvis-deploy`.

These rules mirror `.github/scripts/verify-gcp-trust-anchor.sh`. Do not loosen them to an organization-wide GitHub provider or all-branch trust merely to make authentication work.

## Target state for UAT

The example below assumes:

| Item | Value |
| --- | --- |
| GitHub repository | `kingyx3/corvis` |
| GitHub Environment | `uat` |
| Git ref allowed to deploy | `refs/heads/main` |
| GCP project | your dedicated billed UAT project |
| Region used by Corvis | `asia-southeast1` |
| Deploy service account | `corvis-deploy@<project-id>.iam.gserviceaccount.com` |
| WIF pool ID | `corvis-github` |
| WIF provider ID | `github-uat` |
| Expected GitHub OIDC subject | `repo:kingyx3/corvis:environment:uat` |

The final `GCP_WIF_PROVIDER` value will look like:

```text
projects/123456789012/locations/global/workloadIdentityPools/corvis-github/providers/github-uat
```

The number is the **GCP project number**, not the project ID.

## 1. Create/select the billed UAT GCP project

Create a dedicated UAT project in the Google Cloud console, attach the intended Cloud Billing account, and open **Cloud Shell** while that project is selected.

Do not continue until billing is enabled. The Corvis Terraform budget is created against the billing account later, and the initial foundation enables paid Google APIs even though the UAT design is aggressively scale-to-zero.

In Cloud Shell, set the project ID explicitly:

```bash
export PROJECT_ID="YOUR_UAT_PROJECT_ID"
export ENVIRONMENT="uat"
export REPOSITORY="kingyx3/corvis"
export POOL_ID="corvis-github"
export PROVIDER_ID="github-${ENVIRONMENT}"
export DEPLOY_SA="corvis-deploy@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "${PROJECT_ID}"

gcloud projects describe "${PROJECT_ID}" \
  --format='table(projectId,projectNumber,name)'

gcloud billing projects describe "${PROJECT_ID}" \
  --format='yaml(projectId,billingAccountName,billingEnabled)'
```

Expected result: `billingEnabled: true`.

## 2. Enable only the APIs needed to establish keyless trust

The normal Terraform bootstrap enables the broader Corvis API set. Before that can happen, the APIs used for GitHub OIDC federation, service-account impersonation and project inspection must already be available:

```bash
gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com \
  --project="${PROJECT_ID}"
```

This is part of the one-time trust anchor, not a substitute for the Terraform-managed API enablement performed later.

## 3. Create the keyless Corvis deploy service account

Create the service account only if it does not already exist:

```bash
if ! gcloud iam service-accounts describe "${DEPLOY_SA}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create corvis-deploy \
    --project="${PROJECT_ID}" \
    --display-name="Corvis GitHub deploy identity" \
    --description="Keyless deployment identity used only through GitHub Workload Identity Federation"
fi
```

Do **not** create a service-account key.

Confirm there are no user-managed keys:

```bash
gcloud iam service-accounts keys list \
  --iam-account="${DEPLOY_SA}" \
  --managed-by=user \
  --project="${PROJECT_ID}"
```

Expected result: no rows.

## 4. Give `corvis-deploy` the Terraform deployment permissions

The WIF binding controls **who may become** `corvis-deploy`; the service account still needs permissions to manage the resources represented by the checked-in Terraform roots.

Keep these grants scoped to the dedicated Corvis environment project. Do not grant `roles/owner` or `roles/editor` as a shortcut.

The current Corvis Terraform lifecycle uses the following practical predefined-role baseline:

```bash
PROJECT_ROLES=(
  roles/serviceusage.serviceUsageAdmin
  roles/resourcemanager.projectIamAdmin
  roles/iam.serviceAccountAdmin
  roles/iam.roleAdmin
  roles/storage.admin
  roles/cloudkms.admin
  roles/artifactregistry.admin
  roles/pubsub.admin
  roles/cloudtasks.admin
  roles/secretmanager.admin
  roles/run.admin
  roles/cloudscheduler.admin
  roles/monitoring.admin
  roles/logging.configWriter
  roles/apigateway.admin
  roles/servicemanagement.admin
  roles/serviceusage.apiKeysAdmin
)

for role in "${PROJECT_ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="${role}" \
    --condition=None \
    --quiet
done
```

This is intentionally a service-specific administrative bundle on a dedicated environment project rather than project Owner. If the checked-in Terraform resource set changes, the required permissions can also change; an under-permissioned identity must fail closed rather than be replaced with a static credential.

The current `gcp-foundation` module leaves the optional service-account-key organization-policy resources disabled by default. If those controls are enabled later, authorize the required Organization Policy operation through the organization's approved administration model rather than silently broadening the project deploy identity.

### Billing-budget permission

If `GCP_BILLING_ACCOUNT_ID` is configured, Terraform creates and manages the Corvis budget on that billing account. Grant the deploy identity **Billing Account Costs Manager** on the specific billing account so it can manage budgets without becoming a billing administrator:

```bash
export BILLING_ACCOUNT_ID="YOUR_BILLING_ACCOUNT_ID"

gcloud billing accounts add-iam-policy-binding "${BILLING_ACCOUNT_ID}" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="roles/billing.costsManager" \
  --quiet
```

If your organization centrally owns billing IAM and does not permit this grant, have the billing administrator perform this step. Without billing-budget access, leave `GCP_BILLING_ACCOUNT_ID` unset until that access is approved; do not grant broader project or billing credentials to GitHub as a workaround.

## 5. Create the Workload Identity Pool

Get the numeric project number first:

```bash
export PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" \
  --format='value(projectNumber)')"

echo "PROJECT_NUMBER=${PROJECT_NUMBER}"
```

Create the pool if absent:

```bash
if ! gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project="${PROJECT_ID}" \
    --location="global" \
    --display-name="Corvis GitHub Actions"
fi
```

Confirm its full resource name:

```bash
gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --format='value(name)'
```

Expected shape:

```text
projects/123456789012/locations/global/workloadIdentityPools/corvis-github
```

## 6. Create the UAT GitHub OIDC provider with exact admission restrictions

The provider is environment-specific. The condition below trusts only the exact GitHub Environment subject and `main` branch used by the UAT workflows.

```bash
export EXPECTED_SUBJECT="repo:${REPOSITORY}:environment:${ENVIRONMENT}"
export EXPECTED_REF="refs/heads/main"

if ! gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --project="${PROJECT_ID}" \
    --location="global" \
    --workload-identity-pool="${POOL_ID}" \
    --display-name="Corvis GitHub ${ENVIRONMENT}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.actor=assertion.actor,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.sub == '${EXPECTED_SUBJECT}' && assertion.ref == '${EXPECTED_REF}'"
fi
```

If a provider with this ID already exists, **do not assume it is correct**. Inspect it in step 8. If its issuer, subject mapping or condition differs, correct the existing provider rather than creating an additional loosely scoped provider.

## 7. Allow only the exact UAT GitHub subject to impersonate `corvis-deploy`

Use the exact subject principal rather than granting the whole pool:

```bash
export WIF_SUBJECT_MEMBER="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/${EXPECTED_SUBJECT}"

gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SA}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${WIF_SUBJECT_MEMBER}"
```

This means a token from another repository, another GitHub Environment, or a non-`main` workflow cannot satisfy the Corvis provider/binding combination.

## 8. Verify the live trust anchor before touching GitHub settings

Inspect the provider:

```bash
gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" \
  --format='yaml(name,state,issuerUri,attributeMapping,attributeCondition)'
```

Confirm all of the following:

- `state` is `ACTIVE`;
- `issuerUri` is GitHub Actions' token issuer;
- `google.subject` maps to `assertion.sub`;
- the condition contains `repo:kingyx3/corvis:environment:uat`;
- the condition contains `refs/heads/main`.

Inspect the deploy-service-account binding:

```bash
gcloud iam service-accounts get-iam-policy "${DEPLOY_SA}" \
  --project="${PROJECT_ID}" \
  --flatten='bindings[].members' \
  --filter='bindings.role=roles/iam.workloadIdentityUser' \
  --format='table(bindings.role,bindings.members)'
```

The expected member is:

```text
principal://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/corvis-github/subject/repo:kingyx3/corvis:environment:uat
```

Recheck that no user-managed deploy keys exist:

```bash
gcloud iam service-accounts keys list \
  --iam-account="${DEPLOY_SA}" \
  --managed-by=user \
  --project="${PROJECT_ID}"
```

## 9. Capture the exact GitHub Environment values

Read the provider's full resource name:

```bash
export GCP_WIF_PROVIDER="$(gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" \
  --format='value(name)')"

printf 'GCP_PROJECT_ID=%s\n' "${PROJECT_ID}"
printf 'GCP_WIF_PROVIDER=%s\n' "${GCP_WIF_PROVIDER}"
printf 'GCP_BILLING_ACCOUNT_ID=%s\n' "${BILLING_ACCOUNT_ID:-<set-if-budget-access-is-enabled>}"
printf 'GCP_MONTHLY_BUDGET_USD=5\n'
```

Do not store these commands' output in the repository. The values are configuration, not source code.

## 10. Configure the GitHub `uat` Environment

In GitHub, open:

**Repository -> Settings -> Environments -> `uat` -> Environment variables**

Set:

| Variable | UAT value |
| --- | --- |
| `GCP_PROJECT_ID` | the dedicated UAT project ID |
| `GCP_WIF_PROVIDER` | the full provider resource name from step 9 |
| `GCP_BILLING_ACCOUNT_ID` | billing account ID when budget access is enabled |
| `GCP_MONTHLY_BUDGET_USD` | `5` |
| `MONITORING_NOTIFICATION_CHANNEL_IDS` | `[]` until channels are intentionally configured |

`GCP_MONTHLY_BUDGET_USD=5` is the explicit UAT setting. The checked-in workflows also default UAT to `5` so an accidentally missing variable does not raise the budget.

Do not add a Google service-account key, `GOOGLE_APPLICATION_CREDENTIALS`, or any other static GCP credential to GitHub.

See [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md) for the complete GitHub configuration contract. Runtime Postgres credentials belong in GCP Secret Manager after foundation bootstrap, not in GitHub.

## 11. Run the first keyless authentication test: bootstrap `plan`

In GitHub Actions, open **Bootstrap GCP foundation** and run it from `main` with:

```text
environment: uat
action: plan
allow_destroy: false
```

This is the first end-to-end proof that GitHub OIDC, the provider restriction, service-account impersonation and Terraform permissions are all usable.

The workflow itself additionally verifies that:

- `GCP_WIF_PROVIDER` belongs to `GCP_PROJECT_ID`;
- the provider is repository/environment/`main` scoped;
- the deploy identity has an accepted `roles/iam.workloadIdentityUser` binding;
- `corvis-deploy` has no user-managed keys;
- Terraform does not propose deletion/replacement of an existing runtime during bootstrap.

If authentication fails, fix the trust anchor. **Do not** create a static service-account key to get past the error.

## 12. Review, then run bootstrap `apply`

After the `plan` succeeds and its changes are expected, rerun **Bootstrap GCP foundation** from `main` with:

```text
environment: uat
action: apply
allow_destroy: false
```

The bootstrap workflow then creates/hardens the Terraform-state bucket and applies the checked-in UAT foundation. The runtime image and Cloudflare edge remain disabled during this foundation bootstrap, so the first apply does not accidentally expose a public application.

For the rest of the lifecycle, continue with [`GCP_BOOTSTRAP.md`](GCP_BOOTSTRAP.md) and [`ENVIRONMENT_LIFECYCLE.md`](ENVIRONMENT_LIFECYCLE.md).

## Troubleshooting

### `GCP_WIF_PROVIDER must be the full ... resource name`

Use the provider **name**, not its console display name and not the pool name:

```bash
gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" \
  --format='value(name)'
```

### Provider belongs to a different project

The numeric project number embedded in `GCP_WIF_PROVIDER` must resolve to the same project as `GCP_PROJECT_ID`. Recreate/correct the GitHub Environment variable rather than pointing UAT at another environment's provider.

### GitHub authentication returns `unauthorized_client` / attribute-condition failure

Check that the workflow job uses GitHub Environment `uat`, runs from `main`, and the provider condition is exactly scoped to the expected subject/ref. A pull-request ref or a job that does not bind the `uat` Environment should not be able to authenticate through this provider.

### `iam.serviceAccounts.getAccessToken` / impersonation denied

Recheck the exact `roles/iam.workloadIdentityUser` member on `corvis-deploy`. The member must use the numeric project number and the pool ID, and its subject must be `repo:kingyx3/corvis:environment:uat`.

### Terraform reaches Google but receives 403 permission errors

The WIF trust is working; the deploy identity lacks an infrastructure permission. Compare the failing resource with the current checked-in Terraform modules and the project-role baseline in step 4. Add only the missing service-specific permission/role at the narrowest practical scope. Do not grant Owner to GitHub.

### Budget creation fails while the rest of Terraform is authorized

Budget IAM lives on the **billing account**, not merely the project. Confirm `roles/billing.costsManager` for `corvis-deploy` on the configured billing account, or temporarily leave `GCP_BILLING_ACCOUNT_ID` unset until the billing administrator grants the budget permission.

### Newly created provider/binding still fails immediately

Google IAM/WIF changes can require a short propagation interval. Re-run the bootstrap `plan` after confirming the provider and service-account policy are correct; do not alter the trust scope merely because the first request occurred before propagation completed.

## Completion checklist

Before considering pre-bootstrap complete:

- [ ] Dedicated UAT GCP project exists and billing is enabled.
- [ ] Initial IAM/STS APIs are enabled.
- [ ] `corvis-deploy@<project-id>.iam.gserviceaccount.com` exists.
- [ ] `corvis-deploy` has no user-managed keys.
- [ ] Deployment permissions are scoped to the dedicated environment project rather than Owner/Editor.
- [ ] Billing budget permission is scoped to the intended billing account when `GCP_BILLING_ACCOUNT_ID` is used.
- [ ] WIF pool exists.
- [ ] UAT OIDC provider is ACTIVE.
- [ ] Provider subject is exactly `repo:kingyx3/corvis:environment:uat`.
- [ ] Provider ref is exactly `refs/heads/main`.
- [ ] Exact UAT subject has `roles/iam.workloadIdentityUser` on `corvis-deploy`.
- [ ] GitHub `uat` Environment contains `GCP_PROJECT_ID` and the full `GCP_WIF_PROVIDER` resource name.
- [ ] GitHub `uat` sets `GCP_MONTHLY_BUDGET_USD=5` (with the code fallback also remaining `5`).
- [ ] No static Google credential exists in GitHub.
- [ ] **Bootstrap GCP foundation** `plan` succeeds from `main`.
- [ ] Reviewed **Bootstrap GCP foundation** `apply` succeeds with `allow_destroy=false`.
