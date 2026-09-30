# GCP cost control and UAT hibernation

Corvis UAT is designed to stay recoverable while keeping idle and historical GCP costs low. The cost controls in this repository never disable project billing and never delete the UAT project when a budget threshold is crossed.

## UAT monthly budget

Set the `uat` GitHub Environment variable:

```text
GCP_MONTHLY_BUDGET_USD=5
```

`gcp-bootstrap.yml` and `terraform-deploy.yml` map it to `TF_VAR_monthly_budget_amount_usd`. The UAT Terraform variable also defaults to `5`, so a missing GitHub variable cannot silently raise the UAT budget. `GCP_BILLING_ACCOUNT_ID` must be configured for Terraform to create the Cloud Billing budget.

The project-scoped alerts-only budget uses actual current spend thresholds of 50%, 75%, 85%, and 100%. Cloud Billing budget data is delayed, so this is a guardrail rather than a mathematical guarantee that final invoiced spend stops at exactly $5.

## Non-destructive 85% hibernation

The observability module attaches the UAT budget to `corvis-budget-updates-uat`. When a budget update reaches 85%, Pub/Sub invokes the IAM-private, scale-to-zero `corvis-cost-guard-uat` Cloud Run service with a Google-signed OIDC token.

The guard verifies the token, budget name and threshold before pausing only automated consumption:

- `corvis-delivery-uat` Cloud Scheduler job;
- daily, weekly and monthly control-loop Scheduler jobs; and
- the `processing-uat` Cloud Tasks queue.

It does **not** disable billing, delete Cloud Run services, delete data, destroy Terraform state, revoke secrets, or delete the project. Cloud Run UAT services already have `min_instance_count=0`, so they do not keep warm instances while idle. Existing public traffic can still invoke UAT until the environment is deliberately idled or a native Cloud Run spend cap is enforced.

Use the **UAT GCP cost control** workflow with `action=status` to inspect the hibernation state. To restore scheduled/queued work, run it with `action=resume` and the exact confirmation `RESUME uat`.

## Cloud Run native spend cap

Google Cloud Billing Spend Caps are a Preview provider feature. When available on the billing account, create a separate **Cloud Run** spend-cap budget for the UAT project at approximately `$4` (or another value below the project-wide `$5` budget). A Cloud Run spend cap pauses Cloud Run service/job usage without deleting resources or data and uses faster estimated-cost enforcement than ordinary billing reports.

Spend-cap creation/lifting is currently a provider-side billing-console operation rather than part of the checked-in Terraform contract. Treat it as a one-time external UAT bootstrap control and retain evidence of the configured project, service and amount. Do not replace the project-wide `$5` budget with the Cloud Run-only cap: the project budget also covers storage, registry, KMS, Pub/Sub/Tasks and other GCP services.

Reference: https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps

## Artifact Registry retention

The `corvis` Docker repository uses cleanup policies:

- untagged versions are deleted after 3 days in non-prod and 7 days in prod;
- old `git-*` tagged builds are deleted after 14 days in non-prod and 90 days in prod;
- the five most recent non-prod versions (ten in prod) are always retained; and
- `active-*` and `known-good-*` tags are always retained.

Terraform deploy moves `active-<environment>` to the deployed immutable digests. The daily UAT cost-hygiene workflow also reasserts `active-uat` and `known-good-uat` from the live runtime and accepted rollback manifest before Artifact Registry cleanup can remove low-value history.

## Secret Manager retention

Secret Manager charges for active versions, including both enabled and disabled versions. The UAT cost-hygiene workflow is intentionally narrow: it can manage versions only for:

- `corvis-postgres-dsn-uat`; and
- `corvis-control-loop-github-token-uat`.

For each secret it retains the two newest non-destroyed versions. Older enabled versions are disabled first. Older disabled versions are destroyed only after they are at least 14 days old, providing a recovery/cooling-off interval before irreversible destruction.

Source-connector credential secrets are not swept by this job because each credential is a separate tenant-scoped secret and revocation already deletes the secret through the application path.

## Storage and other low-cost defaults

The source bucket keeps retained source evidence, but lifecycle rules bound transient and noncurrent storage. Abandoned/quarantined uploads, intermediates/exports, and noncurrent session/object versions age out automatically. Terraform-state noncurrent versions are also lifecycle-managed by the bootstrap contract.

KMS historical key versions are **not** pruned merely to save a few cents: retained objects encrypted under historical key versions may still require those versions for decryption. KMS cleanup is therefore tied to verified data deletion/decommission, not a generic cost janitor.

GitHub Actions migration evidence is retained for 30 days in UAT and 90 days in prod; security/control evidence keeps its existing compliance-oriented retention rather than being deleted solely for storage savings.

## Operational order

1. Configure `GCP_BILLING_ACCOUNT_ID` and UAT `GCP_MONTHLY_BUDGET_USD=5`.
2. Bootstrap/apply the UAT Terraform root.
3. If the billing account exposes Preview Spend Caps, add the Cloud Run-only cap below the project budget (recommended approximately `$4`).
4. Deploy UAT normally. The cost guard scales to zero until a budget notification invokes it.
5. Let the daily **UAT GCP cost hygiene** workflow protect active/known-good images and prune excess operational secret versions.
6. If the 85% guard hibernates UAT, investigate cost drivers before manually resuming automation.

Because billing reports and budget notifications can lag, neither the alerts-only project budget nor the automated guard guarantees an exact final invoice ceiling. The combination is intentionally layered: a small project-wide budget, early non-destructive automation pause, optional provider-native Cloud Run cap, scale-to-zero runtimes, and aggressive-but-recoverable retention policies.
