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

Documents are grouped by kind. Add a new document to the folder that matches its purpose and list it here.

### Architecture and contracts (`architecture/`)

- [`AI_MODEL_GATEWAY.md`](./architecture/AI_MODEL_GATEWAY.md) — AI model gateway and extraction harness boundaries.
- [`API_CONVENTIONS.md`](./architecture/API_CONVENTIONS.md) — `/api/v1` envelope, error codes, cursor pagination and idempotency conventions.
- [`API_DEPRECATION.md`](./architecture/API_DEPRECATION.md) — API compatibility and deprecation policy.
- [`API_INGRESS_DECISION.md`](./architecture/API_INGRESS_DECISION.md) — public API ingress architecture decision.
- [`ARCHITECTURE.md`](./architecture/ARCHITECTURE.md) — high-level map of how the repository layers, runtime dependencies, Terraform modules and GitHub Actions control plane fit together.
- [`DATABASE_PORTABILITY.md`](./architecture/DATABASE_PORTABILITY.md) — PostgreSQL as the dialect/correctness boundary and provider portability rules.
- [`DATA_PLATFORM.md`](./architecture/DATA_PLATFORM.md) — GCS/Postgres/Snowflake boundaries, RLS, migrations and optional downstream CDC.
- [`DESIGN_SYSTEM.md`](./architecture/DESIGN_SYSTEM.md) — the Corvis design system.
- [`ENTITY_IDENTITY_LIFECYCLE.md`](./architecture/ENTITY_IDENTITY_LIFECYCLE.md) — economic entity identity and lifecycle.
- [`MODULARITY.md`](./architecture/MODULARITY.md) — module boundaries, dependency direction, failure isolation and the canonical customer-journey E2E contract.
- [`ROLE_AND_ACTOR_TERMINOLOGY.md`](./architecture/ROLE_AND_ACTOR_TERMINOLOGY.md) — role and actor terminology.
- [`RUNTIME_SURFACES.md`](./architecture/RUNTIME_SURFACES.md) — runtime surface isolation.
- [`SECTOR_TAXONOMY.md`](./architecture/SECTOR_TAXONOMY.md) — sector taxonomy.
- [`STAGE_WORKER_IDEMPOTENCY.md`](./architecture/STAGE_WORKER_IDEMPOTENCY.md) — processing stage worker idempotency contract.

### Product capabilities (`features/`)

- [`CLIENT_PORTFOLIO_ATTRIBUTION.md`](./features/CLIENT_PORTFOLIO_ATTRIBUTION.md) — client portfolio attribution.
- [`NOTIFICATIONS.md`](./features/NOTIFICATIONS.md) — email notifications: categories, recipient addresses, outbox delivery and provider activation.
- [`POSITION_FINANCIAL_STATEMENTS.md`](./features/POSITION_FINANCIAL_STATEMENTS.md) — position financial statements and client analytics.
- [`SERVICE_ACCOUNTS.md`](./features/SERVICE_ACCOUNTS.md) — customer self-service service accounts and API credentials (F6): design, assumptions and the shipped credential-verification mechanism (#350).
- [`SOURCE_CONNECTORS.md`](./features/SOURCE_CONNECTORS.md) — authorized GP portal/data-room connectors, customer credential setup, secure secret handling and automated acquisition.
- [`SUPPORT.md`](./features/SUPPORT.md) — in-app help and support: Help menu, Contact support context (no financial data), error-state entry points and the `NEXT_PUBLIC_CORVIS_*` support/docs/status/release-notes configuration.
- [`TENANT_SELF_SERVICE.md`](./features/TENANT_SELF_SERVICE.md) — customer tenant self-service.

### Infrastructure, deployment and operations (`operations/`)

- [`BUILD_ONCE_PROMOTION.md`](./operations/BUILD_ONCE_PROMOTION.md) — build-once cross-project release promotion.
- [`CLOUDFLARE_SHARED_ZONE.md`](./operations/CLOUDFLARE_SHARED_ZONE.md) — one-domain UAT/prod hostname contract, shared-zone Terraform ownership, token separation, TLS/WAF/cache/rate-limit isolation and lifecycle controls.
- [`CONTROL_LOOP.md`](./operations/CONTROL_LOOP.md) — continuous business-build/documentation control loop: scanners, fingerprinting, health/watermark rules and what remains manual.
- [`DEPLOYMENT.md`](./operations/DEPLOYMENT.md) — GitHub-centric deployment flow, environment promotion, secret propagation and rollback.
- [`ENTERPRISE_IMPLEMENTATION.md`](./operations/ENTERPRISE_IMPLEMENTATION.md) — current implementation status and open technical gaps.
- [`ENVIRONMENT_LIFECYCLE.md`](./operations/ENVIRONMENT_LIFECYCLE.md) — cloud environment lifecycle.
- [`GCP_BOOTSTRAP.md`](./operations/GCP_BOOTSTRAP.md) — GCP bootstrap from GitHub Actions.
- [`GCP_COST_CONTROL.md`](./operations/GCP_COST_CONTROL.md) — GCP cost control and UAT hibernation.
- [`GCP_PRE_BOOTSTRAP.md`](./operations/GCP_PRE_BOOTSTRAP.md) — one-time Cloud Shell trust-anchor setup for `corvis-deploy`, GitHub OIDC/WIF, exact UAT subject/ref restrictions, IAM verification and handoff to the first GitHub Actions bootstrap plan/apply.
- [`GITHUB_ENVIRONMENTS.md`](./operations/GITHUB_ENVIRONMENTS.md) — required GitHub Environments, variables/secrets, bootstrap exceptions and configuration propagation.
- [`INFRASTRUCTURE.md`](./operations/INFRASTRUCTURE.md) — Cloudflare + GCP + Supabase topology, IaC ownership, lifecycle and cost controls.
- [`PRODUCTION_ACTIVATION.md`](./operations/PRODUCTION_ACTIVATION.md) — provider-side activation and evidence checks before production traffic.
- [`RELEASE_GOVERNANCE.md`](./operations/RELEASE_GOVERNANCE.md) — Release governance trust boundary and GitHub App credential.
- [`RUNTIME_SECRETS.md`](./operations/RUNTIME_SECRETS.md) — runtime secret lifecycle.

### Security and compliance (`security/`)

- [`RUNTIME_DATABASE_ROLE.md`](./security/RUNTIME_DATABASE_ROLE.md) — the least-privilege `corvis_runtime` database role: grants, RLS, `PUBLIC` revocation, guard rails for future migrations and the per-environment rollout/rollback plan.
- [`SECURITY_ACCEPTANCE.md`](./security/SECURITY_ACCEPTANCE.md) — security acceptance for edge, gateway and tenant isolation.
- [`SERVICE_IDENTITY_HARDENING.md`](./security/SERVICE_IDENTITY_HARDENING.md) — service identity authorization and lifecycle.
- [`SOC1_READINESS.md`](./security/SOC1_READINESS.md) — repository-side SOC 1 ICFR readiness boundary, technical evidence contract and remaining audit gates.
- [`SOC2_READINESS.md`](./security/SOC2_READINESS.md) — repository-side SOC 2 readiness boundary, technical evidence contract and remaining audit gates.

### Engineering practice (`engineering/`)

- [`CONVEX_CONFORMANCE.md`](./engineering/CONVEX_CONFORMANCE.md) — Convex upstream conformance oracle used in CI.
- [`QUALITY_BUDGETS.md`](./engineering/QUALITY_BUDGETS.md) — accessibility, browser/responsive matrix and performance gates in `e2e/`.
- [`TESTING.md`](./engineering/TESTING.md) — blocking coverage policy, changed-code 100% gate, whole-repo coverage ratchet, coverage-denominator integrity and escaped-defect prevention.

### Point-in-time reviews (`reviews/`)

- [Review workflows and personal preferences](./reviews/REVIEW_WORKFLOWS_AND_PREFERENCES.md) — exception investigation, original documents, saved views, formatting and rollout.
- [`REPO_STRUCTURE_REVIEW.md`](./reviews/REPO_STRUCTURE_REVIEW.md) — repository directory-structure review: a historical record of the pre-restructure layout, the gaps it found and the migration plan that #363 then carried out in full.
- [`REVIEW_2026_09_30.md`](./reviews/REVIEW_2026_09_30.md) — repository/Confluence review findings, fixes, validation scope and outstanding risks.
- [`REVIEW_2026_10_06.md`](./reviews/REVIEW_2026_10_06.md) — service credential and scorecard fixes, documentation reconciliation and remaining activation gates.

### Operational runbooks (`ops/`)

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
