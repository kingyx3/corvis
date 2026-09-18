# Corvis technical documentation

GitHub is the source of truth for **technical architecture and implementation**: cloud topology, infrastructure as code, environment configuration, deployment mechanics, runtime adapters, database migrations, operational runbooks and code-level interfaces.

Confluence remains the source of truth for **business architecture and governance**: product/business capabilities, semantic requirements, customer rights, operating model, commercial decisions, risk/control requirements and production-readiness gates.

## Authority rule

When the same subject appears in both systems:

- **Confluence defines why / what / required outcome.**
- **GitHub defines how it is technically implemented.**
- GitHub implementation must satisfy the Confluence requirement; it must not silently redefine business semantics, customer rights, control claims or commercial commitments.
- Provider settings, Terraform layout, environment variables, secret names, deployment commands, runbooks and implementation-specific thresholds belong here, not in Confluence.

## Technical documents

- [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md) — Cloudflare + GCP + Supabase topology, IaC ownership, lifecycle and cost controls.
- [`DATA_PLATFORM.md`](DATA_PLATFORM.md) — GCS/Postgres/Snowflake boundaries, RLS, migrations and optional downstream CDC.
- [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md) — required GitHub Environments, variables/secrets, bootstrap exceptions and configuration propagation.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — GitHub-centric deployment flow, environment promotion, secret propagation and rollback.
- [`ENTERPRISE_IMPLEMENTATION.md`](ENTERPRISE_IMPLEMENTATION.md) — current implementation status and open technical gaps.
- [`PRODUCTION_ACTIVATION.md`](PRODUCTION_ACTIVATION.md) — provider-side activation and evidence checks before production traffic.
- [`../ops/RUNBOOK.md`](../ops/RUNBOOK.md) — incident/recovery operations.
- [`../ops/slos.yaml`](../ops/slos.yaml) — machine-readable SLO/RPO/RTO implementation targets.

## Environment names

The canonical deployment environments are:

- `dev` — developer/integration environment; disposable where practical.
- `uat` — production-like user acceptance / pre-production environment using synthetic or sanitized data.
- `prod` — production customer environment.

`staging` is deprecated as an environment name. Existing references should migrate to `uat` when touched.

## Change discipline

Technical changes that affect a Confluence-owned business requirement must link the governing Confluence page or issue. Changes that are purely implementation detail may be completed entirely in GitHub.

Never copy credentials, customer data, confidential evidence or secret values into this public repository. Documentation may list **secret names and ownership**, never values.
