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

- [`REVIEW_2026_09_30.md`](REVIEW_2026_09_30.md) — repository/Confluence review findings, fixes, validation scope and outstanding risks.

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — high-level map of how the repository layers, runtime dependencies, Terraform modules and GitHub Actions control plane fit together.
- [`MODULARITY.md`](MODULARITY.md) — module boundaries, dependency direction, failure isolation and the canonical customer-journey E2E contract.
- [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md) — Cloudflare + GCP + Supabase topology, IaC ownership, lifecycle and cost controls.
- [`CLOUDFLARE_SHARED_ZONE.md`](CLOUDFLARE_SHARED_ZONE.md) — one-domain UAT/prod hostname contract, shared-zone Terraform ownership, token separation, TLS/WAF/cache/rate-limit isolation and lifecycle controls.
- [`DATA_PLATFORM.md`](DATA_PLATFORM.md) — GCS/Postgres/Snowflake boundaries, RLS, migrations and optional downstream CDC.
- [`SOURCE_CONNECTORS.md`](SOURCE_CONNECTORS.md) — authorized GP portal/data-room connectors, customer credential setup, secure secret handling and automated acquisition.
- [`CONTROL_LOOP.md`](CONTROL_LOOP.md) — continuous business-build/documentation control loop: scanners, fingerprinting, health/watermark rules and what remains manual.
- [`QUALITY_BUDGETS.md`](QUALITY_BUDGETS.md) — accessibility, browser/responsive matrix and performance gates in `e2e/`.
- [`TESTING.md`](TESTING.md) — blocking coverage policy, changed-code 100% gate, whole-repo coverage ratchet, coverage-denominator integrity and escaped-defect prevention.
- [`API_CONVENTIONS.md`](API_CONVENTIONS.md) — `/api/v1` envelope, error codes, cursor pagination and idempotency conventions.
- [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md) — required GitHub Environments, variables/secrets, bootstrap exceptions and configuration propagation.
- [`GCP_PRE_BOOTSTRAP.md`](GCP_PRE_BOOTSTRAP.md) — one-time Cloud Shell trust-anchor setup for `corvis-deploy`, GitHub OIDC/WIF, exact UAT subject/ref restrictions, IAM verification and handoff to the first GitHub Actions bootstrap plan/apply.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — GitHub-centric deployment flow, environment promotion, secret propagation and rollback.
- [`ENTERPRISE_IMPLEMENTATION.md`](ENTERPRISE_IMPLEMENTATION.md) — current implementation status and open technical gaps.
- [`SOC1_READINESS.md`](SOC1_READINESS.md) — repository-side SOC 1 ICFR readiness boundary, technical evidence contract and remaining audit gates.
- [`SOC2_READINESS.md`](SOC2_READINESS.md) — repository-side SOC 2 readiness boundary, technical evidence contract and remaining audit gates.
- [`PRODUCTION_ACTIVATION.md`](PRODUCTION_ACTIVATION.md) — provider-side activation and evidence checks before production traffic.
- [`API_DEPRECATION.md`](API_DEPRECATION.md) — API compatibility and deprecation policy.
- [`API_INGRESS_DECISION.md`](API_INGRESS_DECISION.md) — public API ingress architecture decision.
- [`BUILD_ONCE_PROMOTION.md`](BUILD_ONCE_PROMOTION.md) — build-once cross-project release promotion.
- [`CLIENT_PORTFOLIO_ATTRIBUTION.md`](CLIENT_PORTFOLIO_ATTRIBUTION.md) — client portfolio attribution.
- [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) — the Corvis design system.
- [`ENTITY_IDENTITY_LIFECYCLE.md`](ENTITY_IDENTITY_LIFECYCLE.md) — economic entity identity and lifecycle.
- [`ENVIRONMENT_LIFECYCLE.md`](ENVIRONMENT_LIFECYCLE.md) — cloud environment lifecycle.
- [`GCP_BOOTSTRAP.md`](GCP_BOOTSTRAP.md) — GCP bootstrap from GitHub Actions.
- [`POSITION_FINANCIAL_STATEMENTS.md`](POSITION_FINANCIAL_STATEMENTS.md) — position financial statements and client analytics.
- [`ROLE_AND_ACTOR_TERMINOLOGY.md`](ROLE_AND_ACTOR_TERMINOLOGY.md) — role and actor terminology.
- [`RUNTIME_SECRETS.md`](RUNTIME_SECRETS.md) — runtime secret lifecycle.
- [`RUNTIME_SURFACES.md`](RUNTIME_SURFACES.md) — runtime surface isolation.
- [`SECTOR_TAXONOMY.md`](SECTOR_TAXONOMY.md) — sector taxonomy.
- [`SECURITY_ACCEPTANCE.md`](SECURITY_ACCEPTANCE.md) — security acceptance for edge, gateway and tenant isolation.
- [`SERVICE_IDENTITY_HARDENING.md`](SERVICE_IDENTITY_HARDENING.md) — service identity authorization and lifecycle.
- [`STAGE_WORKER_IDEMPOTENCY.md`](STAGE_WORKER_IDEMPOTENCY.md) — processing stage worker idempotency contract.
- [`tenant-self-service.md`](tenant-self-service.md) — customer tenant self-service.
- [`NOTIFICATIONS.md`](NOTIFICATIONS.md) — email notifications: categories, recipient addresses, outbox delivery and provider activation.
- [`../ops/RUNBOOK.md`](../ops/RUNBOOK.md) — incident/recovery operations.
- [`../ops/slos.yaml`](../ops/slos.yaml) — machine-readable SLO/RPO/RTO implementation targets.

## Environment names

The canonical deployment environments are:

- `dev` — developer/integration environment; disposable where practical.
- `uat` — production-like user acceptance / pre-production environment using synthetic or sanitized data.
- `prod` — production customer environment.

## Change discipline

Technical changes that affect a Confluence-owned business requirement must link the governing Confluence page or issue. Changes that are purely implementation detail may be completed entirely in GitHub.

Never copy credentials, customer data, confidential evidence or secret values into this public repository. Documentation may list **secret names and ownership**, never values.
- [Review workflows and personal preferences](REVIEW_WORKFLOWS_AND_PREFERENCES.md) — exception investigation, original documents, saved views, formatting and rollout.
