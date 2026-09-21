# Runtime secret lifecycle

GitHub is the deployment control plane; GCP Secret Manager is the runtime secret store. Secret values must not be committed, persisted in Terraform state, emitted to GitHub outputs/artifacts, or copied into GitHub variables.

## Managed containers

Terraform owns the Secret Manager container and workload IAM bindings needed by the baseline runtime:

- `corvis-postgres-dsn-${environment}` — authoritative Supabase/Postgres runtime DSN.

Cloud Run consumes the latest enabled version through its service identity. The DSN value is not a Terraform input.

The baseline production transport does **not** use a shared gateway/worker identity secret. API Gateway authenticates to Cloud Run with its dedicated Google service account, and Pub/Sub / Cloud Tasks / Cloud Scheduler authenticate to private worker endpoints with Google-signed OIDC tokens. A separate Corvis HMAC assertion secret is therefore not required for the normal OIDC path. If a future SAML or identity-broker deployment uses the optional signed Corvis assertion contract, its signing material is a separate explicitly activated provider/runtime secret and must not be confused with the baseline deployment contract.

## Lifecycle workflow

`.github/workflows/runtime-secrets.yml` uses GitHub OIDC → GCP Workload Identity Federation. `Runtime secret readiness` verifies that the Terraform-managed Postgres secret container exists and has an enabled version. It reads version metadata only; it never accesses secret payloads.

The workflow deliberately does **not** invent, accept, rotate or print a Postgres DSN. DSN creation belongs to the controlled Supabase/Postgres activation path because the connection endpoint and database credential are provider-derived runtime material. That path must write the value directly to `corvis-postgres-dsn-${environment}` without routing plaintext through Terraform or repository configuration.

## Readiness and failure behavior

A missing Terraform-managed container or missing enabled version fails the audit closed. The workflow never creates parallel secret containers, changes runtime IAM, or reads the secret value.

Terraform can create the empty Secret Manager container during bootstrap without requiring a database credential. Normal UAT/prod deployment then refuses to continue until provider activation has inserted an enabled DSN version. This keeps infrastructure bootstrap reproducible while preserving the rule that the real database credential never enters Terraform state or a long-lived GitHub secret.

Security acceptance and the deployment migration step use the same canonical Postgres secret name before exercising live RLS tenant-isolation checks. This prevents deployment or acceptance from silently reading a differently named parallel secret.

## Operator sequence

1. Apply the reviewed GCP bootstrap/foundation so the Secret Manager container and least-privilege workload bindings exist.
2. Activate the separate Supabase/Postgres environment and write its provider-derived DSN directly into `corvis-postgres-dsn-${environment}` through the controlled provider path.
3. Run `Runtime secret readiness`; the Postgres runtime secret must report an enabled version.
4. Build/select the immutable release and run the normal Terraform deployment path, which applies versioned Postgres migrations using that managed DSN before runtime promotion.
5. Run production-like Security acceptance and retain sanitized evidence.

Never paste secret payloads into workflow inputs, issue/PR text, repository files, Terraform variables, CI logs, or ordinary GitHub environment variables.
