# Runtime secret lifecycle

GitHub is the deployment control plane; GCP Secret Manager is the runtime secret store. Secret values must not be committed, persisted in Terraform state, emitted to GitHub outputs/artifacts, or copied into GitHub variables.

## Managed containers

Terraform owns the regional Secret Manager containers and workload IAM bindings. The current API contract derives these names from the Terraform module:

- `corvis-postgres-dsn-${environment}` — authoritative Postgres runtime DSN.
- `corvis-gateway-identity-${environment}` — trusted gateway identity secret.

Cloud Run consumes `latest` enabled versions through its service identity. Secret values are not Terraform inputs.

## Lifecycle workflow

`.github/workflows/runtime-secrets.yml` uses GitHub OIDC → GCP Workload Identity Federation. It has two explicit actions:

- `audit` verifies that both Terraform-managed containers exist and each has an enabled version. It reads version metadata only; it never accesses secret payloads.
- `rotate-gateway-identity` generates a new high-entropy value on the ephemeral GitHub runner with restrictive file permissions and writes it directly to Secret Manager. The value is never printed or exposed as an output/artifact.

Mutation is allowed only when the workflow runs from `main`. GitHub Environment protection therefore remains the approval boundary for `prod`.

The workflow deliberately does **not** invent or accept a Postgres DSN. DSN creation belongs to the controlled Supabase/Postgres activation path because the connection endpoint and database credential are provider-derived runtime material. That path must write the value directly to `corvis-postgres-dsn-${environment}` without routing plaintext through Terraform or repository configuration.

## Readiness and failure behavior

A missing Terraform-managed container or missing enabled version fails the audit closed. Secret rotation never creates parallel secret containers, changes IAM, or reads existing values. A failed rotation leaves prior enabled versions intact, allowing rollback at the Secret Manager version layer.

Security acceptance uses the same Terraform-derived Postgres secret name before exercising live RLS tenant-isolation checks. This prevents acceptance from silently reading a differently named parallel secret.

## Operator sequence

1. Apply the reviewed Terraform foundation so the secret containers and least-privilege workload bindings exist.
2. Provision the Postgres DSN through the controlled provider activation path.
3. Run `Runtime secret readiness` with `rotate-gateway-identity` when the gateway secret needs an initial value or rotation.
4. Run `Runtime secret readiness` with `audit`; both runtime secrets must report an enabled version.
5. Deploy the immutable release and run production-like Security acceptance.

Never paste secret payloads into workflow inputs, issue/PR text, repository files, Terraform variables, or CI logs.
