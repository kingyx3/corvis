# Runtime secret lifecycle

GitHub is the deployment control plane; GCP Secret Manager is the runtime secret store. Secret values must not be committed, persisted in Terraform state, emitted to GitHub outputs/artifacts, or copied into ordinary GitHub variables.

## Managed containers

Terraform owns the Secret Manager containers and baseline IAM needed by the runtime/control plane:

- `corvis-postgres-dsn-${environment}` — authoritative Supabase/Postgres runtime DSN.
- `corvis-control-loop-github-token-${environment}` (UAT/prod) — optional read-only GitHub token for the control-loop jobs. Terraform creates the empty container and grants the control-loop identity read access; the jobs reference it only after `CONTROL_LOOP_GITHUB_TOKEN_CONFIGURED=true` (a job referencing a secret with no version cannot start).
- `corvis-ai-provider-credentials-${environment}` (UAT/prod) — provider-neutral JSON map of model/gateway provider environment variables to secret values.
- `corvis-litellm-master-key-${environment}` (UAT/prod) — LiteLLM root/gateway credential when LiteLLM is active.
- `corvis-atlassian-skill-read-${environment}` (UAT/prod) — Confluence skill read credential/config for the extraction harness.
- `corvis-atlassian-skill-update-${environment}` (UAT/prod) — separate Confluence skill-update credential/config for the explicitly governed maintenance path.

Terraform owns the containers but not their values. The AI integration resources grant the deployment service account only `secretVersionAdder` on those four containers. They deliberately do **not** grant the Corvis API/worker service accounts provider or Atlassian secret access. Future extraction-harness/LiteLLM service accounts receive individual `secretAccessor` grants only for the secrets they actually require.

Cloud Run consumes the latest enabled Postgres version through its service identity. The DSN value is not a Terraform input. The real database credential never enters Terraform state or a long-lived GitHub secret.

The Postgres server CA bundle is **not** a secret. When the provider's certificates chain to a private root (Supabase), set the PEM bundle as the `CORVIS_POSTGRES_CA_CERT` GitHub Environment variable (default empty). The deploy workflow passes it to Terraform as `postgres_ca_cert` (a plain `CORVIS_POSTGRES_CA_CERT` env var on the API and worker services) and to the migration and security-acceptance steps. It narrows trust for Postgres TLS only; verification is never disabled. See `docs/architecture/DATA_PLATFORM.md`.

The API service also receives `CORVIS_BROWSER_ALLOWED_ORIGINS` (the public customer and admin origins derived from the environment's hostnames) for the CSRF Origin allow-list; it is configuration, not a secret.

The baseline production transport does **not** use a shared gateway/worker identity secret. API Gateway authenticates to Cloud Run with its dedicated Google service account, and Pub/Sub / Cloud Tasks / Cloud Scheduler authenticate to private worker endpoints with Google-signed OIDC tokens. A separate Corvis HMAC assertion secret is therefore not required for the normal OIDC path. If a future SAML or identity-broker deployment uses the optional signed Corvis assertion contract, its signing material is a separate explicitly activated provider/runtime secret and must not be confused with the baseline deployment contract.

## Lifecycle workflows

`.github/workflows/runtime-secrets.yml` uses GitHub OIDC -> GCP Workload Identity Federation. `Runtime secret readiness` verifies that the Terraform-managed Postgres secret container exists and has an enabled version. It reads version metadata only; it never accesses secret payloads.

The workflow deliberately does **not** invent, accept, rotate or print a Postgres DSN. DSN creation belongs to the controlled Supabase/Postgres activation path because the connection endpoint and database credential are provider-derived runtime material. That path must write the value directly to `corvis-postgres-dsn-${environment}` without routing plaintext through Terraform or repository configuration.

**Least-privilege runtime credential (#227).** Today this one DSN is both the application's runtime credential and the credential the deploy workflow applies migrations with, and it is an owner/service role. Migration 100 adds the least-privilege `corvis_runtime` group role. Moving the runtime onto it means (1) a *separate* migration credential first, because the runtime role has no DDL, then (2) a new enabled version of `corvis-postgres-dsn-${environment}` for a login role that is a member of `corvis_runtime`, written through the same controlled provider path, with the previous version kept for rollback. The ordered, per-environment plan (UAT then production) and the rollback are in [`RUNTIME_DATABASE_ROLE.md`](../security/RUNTIME_DATABASE_ROLE.md); no secret or Terraform wiring was changed by migration 100.

`.github/workflows/ai-integration-secrets.yml` is different by design: it is an explicit operator rotation path for protected UAT/prod GitHub Environment **secrets**. It accepts no plaintext `workflow_dispatch` inputs. Instead it reads whichever of the four approved AI integration secrets are configured, relies on GitHub's secret masking, validates JSON-shaped credential maps without printing them, and pipes each supplied value directly into a new Secret Manager version. It fails when Terraform has not created the canonical containers and refuses a no-op run when no provisioning secret is present.

The corresponding GitHub Environment secrets are provisioning inputs only:

- `CORVIS_AI_PROVIDER_CREDENTIALS_JSON`
- `CORVIS_LITELLM_MASTER_KEY`
- `CORVIS_ATLASSIAN_SKILL_READ_CREDENTIALS_JSON`
- `CORVIS_ATLASSIAN_SKILL_UPDATE_CREDENTIALS_JSON`

Once copied, deployed runtimes consume the GCP Secret Manager values through IAM. Do not mount the Atlassian update secret into ordinary extraction or into LiteLLM. See `docs/architecture/AI_MODEL_GATEWAY.md`.

## Readiness and failure behavior

A missing Terraform-managed Postgres container or missing enabled Postgres version fails its audit closed. The readiness workflow never creates parallel secret containers, changes runtime IAM, or reads the DSN value.

Terraform can create empty Secret Manager containers without requiring provider credentials. Normal UAT/prod deployment then refuses to continue until provider activation has inserted an enabled Postgres DSN version. AI extraction remains independently fail-closed while `CORVIS_EXTRACTION_ENDPOINT` is empty; model/provider and Atlassian secrets do not activate extraction by themselves.

The AI provisioning workflow similarly refuses to create substitute secret containers. This prevents spelling drift or ad-hoc names from becoming a second credential source. It adds versions only to the four Terraform-managed integration containers.

Security acceptance and the deployment migration step use the same canonical Postgres secret name before exercising live RLS tenant-isolation checks. This prevents deployment or acceptance from silently reading a differently named parallel secret.

## Operator sequence

1. Apply the reviewed GCP bootstrap/foundation so the baseline Secret Manager resources exist.
2. Activate the separate Supabase/Postgres environment and write its provider-derived DSN directly into `corvis-postgres-dsn-${environment}` through the controlled provider path.
3. Run `Runtime secret readiness`; the Postgres runtime secret must report an enabled version.
4. Apply the UAT/prod runtime Terraform so the AI integration secret containers exist.
5. When AI extraction is being activated or credentials rotated, configure the required protected GitHub Environment AI integration secrets and run **AI integration secret provisioning**. Leave the Atlassian update secret unset unless the governed skill-maintenance path is intentionally enabled.
6. Build/select the immutable Corvis release and run the normal Terraform deployment path, which applies versioned Postgres migrations using the managed DSN before runtime promotion.
7. Deploy the separately permissioned extraction-harness/LiteLLM runtime with least-privilege access to only its required integration secrets, then configure `CORVIS_EXTRACTION_ENDPOINT`.
8. Run production-like Security acceptance and retain sanitized evidence.

Never paste secret payloads into workflow inputs, issue/PR text, repository files, Terraform variables, CI logs, or ordinary GitHub environment variables.
