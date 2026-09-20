# Corvis repository architecture

This document is the high-level technical map for how the code in this repository fits together. It describes the current physical repository, the dependency direction between code layers, the deployed provider topology, and the GitHub Actions control plane.

For business architecture, vendor/account ownership, procurement, and one-time external setup outside the repository, use Confluence. GitHub remains the source of truth for executable technical implementation.

## 1. Repository-wide code map

```text
____________________________________________________________________________________________________
|                                      CORVIS REPOSITORY                                             |
|__________________________________________________________________________________________________|
|                                                                                                    |
|  PRODUCT / HTTP ENTRY                                                                              |
|  ________________________________________________________________________________________________  |
|  | app/                 | components/           | features/                 | proxy.ts          |  |
|  | Next.js pages + APIs | shared UI components | product feature UI/state | request boundary  |  |
|  |______________________|_______________________|___________________________|___________________|  |
|                                      |                                                             |
|                                      v                                                             |
|  APPLICATION + SERVER COMPOSITION                                                                  |
|  ________________________________________________________________________________________________  |
|  | application/         | runtime/              | lib/server/                                   |  |
|  | use cases            | dependency wiring     | auth, config, repositories, processing,       |  |
|  |                      | + adapter selection   | evidence, flags, persistence helpers          |  |
|  |______________________|_______________________|_______________________________________________|  |
|                       |                         |                          |                       |
|             __________|_________________________|__________________________|________               |
|            v                           v                         v                    v              |
|  DOMAIN CONTRACTS             PROVIDER ADAPTERS           ASYNC / CONTROL       DATA CONTRACTS     |
|  _______________________       _______________________     __________________    __________________  |
|  | core/                |       | adapters/            |     | control-loop/  |    | db/           |  |
|  | typed domain ports,  |       | HTTP/GCS/demo/etc.   |     | scanners,      |    | migrations,   |  |
|  | workspace/delivery   |       | provider boundaries  |     | fingerprints,  |    | RLS, DB       |  |
|  | contracts            |       |                     |     | health checks  |    | contracts     |  |
|  |______________________|       |_____________________|     |_______________|    |_______________|  |
|            |                           |                         |                    |              |
|            |___________________________|_________________________|____________________|              |
|                                                |                                                   |
|                                                v                                                   |
|  EXTERNAL RUNTIME DEPENDENCIES                                                                      |
|  ________________________________________________________________________________________________  |
|  | GCP Cloud Run / Jobs | GCS | Pub/Sub / Tasks / Scheduler | Secret Manager / KMS | Postgres |  |
|  | Cloudflare edge      | Artifact Registry | Logging / Monitoring / Trace          | optional Snowflake |
|  |______________________________________________________________________________________________|  |
|                                                                                                    |
|  DELIVERY / OPERATIONS / CONTRACTS                                                                  |
|  ________________________________________________________________________________________________  |
|  | infra/terraform/ | .github/workflows/ | openapi/ | ops/ | e2e/ | scripts/ | docs/          |  |
|  | IaC              | CI/CD + governance | API spec | SRE  | E2E  | tooling  | technical docs |  |
|  |__________________|_____________________|__________|______|______|__________|________________|  |
|__________________________________________________________________________________________________|
```

The intended dependency direction is inward: UI and API routes call application/server services; those services depend on domain contracts; concrete provider behavior lives behind adapters. Provider SDKs, SQL details, and cloud-specific behavior should not become product/domain contracts.

## 2. Main directory responsibilities

| Path | Responsibility |
| --- | --- |
| `app/` | Next.js application shell, customer-facing pages, and HTTP/API route handlers. |
| `components/` | Reusable presentation components shared across product surfaces. |
| `features/` | Feature-oriented UI/state for documents, review, delivery, research, and overview workflows. |
| `application/` | Application use cases that coordinate domain ports without owning provider-specific implementation. |
| `core/` | Stable domain contracts and typed ports for workspace, delivery, enterprise rules, and module boundaries. |
| `runtime/` | Runtime composition: selects/wires concrete implementations for domain ports. |
| `adapters/` | Provider-specific implementations such as HTTP delivery, GCS resumable upload, workspace access, and demo/test adapters. |
| `lib/server/` | Server-side authorization, configuration, persistence/orchestration helpers, control evidence, feature flags, and backend service implementation. |
| `control-loop/` | Automated repository/business-control scanning, fingerprints, watermarks, and health/control-loop logic. |
| `db/` | Reviewed database migrations and Postgres-side security/data contracts, including RLS-related implementation. |
| `openapi/` | Public/controlled API contracts. |
| `infra/terraform/` | Executable infrastructure code for provider resources and environment roots. |
| `.github/workflows/` | CI, build/release, Terraform deployment, GCP bootstrap, runtime-secret propagation, security acceptance, and governance automation. |
| `ops/` | Runtime operations, SLOs, recovery and incident runbooks. |
| `e2e/` | Cross-module browser/customer-journey acceptance and quality tests. |
| `scripts/` | Operator/developer utilities and implementation checks. |
| `docs/` | Technical architecture, deployment, security, data-platform and production-activation documentation. |

## 3. Customer request and data flow

```text
____________________________________________________________________________________________________
|                                  CUSTOMER / OPERATOR REQUEST                                       |
|__________________________________________________________________________________________________|
| Browser / API client                                                                               |
|        |                                                                                           |
|        v                                                                                           |
| Cloudflare public edge                                                                             |
| DNS | TLS | proxy | DDoS/WAF/rate controls                                                        |
|        |                                                                                           |
|        v                                                                                           |
| GCP external HTTPS load balancer                                                                   |
|        |                                                                                           |
|        v                                                                                           |
| Cloud Run: Next.js customer/admin/API runtime                                                      |
|        |                                                                                           |
|        |----> authorization + request validation        [app/api + lib/server]                      |
|        |----> application/domain service composition    [application + runtime + core]              |
|        |----> provider adapter                          [adapters + lib/server]                      |
|        |                                                                                           |
|        |______________________________     ______________________________                           |
|                                       |   |                                                         |
|                                       v   v                                                         |
|                              Supabase Postgres Singapore                                            |
|                              operational + canonical + serving state                                |
|                                                                                                    |
|        |-------------------------------> GCS Singapore                                              |
|        |                                 immutable source / replay artifacts                         |
|        |                                                                                           |
|        |-------------------------------> Pub/Sub / Cloud Tasks / Scheduler                          |
|                                          durable async processing / retries                         |
|                                                   |                                                |
|                                                   v                                                |
|                                          Cloud Run Jobs / workers                                   |
|                                                   |                                                |
|                                                   |----> Postgres                                   |
|                                                   |----> GCS                                        |
|                                                   |----> approved AI/OCR/source providers          |
|                                                                                                    |
| Postgres ---- optional approved downstream replication ----> Snowflake analytics / secure sharing    |
|__________________________________________________________________________________________________|
```

Important boundaries:

- Postgres is the authoritative structured write path; Snowflake is downstream only when explicitly activated.
- GCS is the immutable source/replay artifact store; large uploads go browser-to-GCS rather than through the application body path.
- Async processing uses queues/jobs so extraction, connector, export, and other long-running work can fail/retry independently of synchronous customer requests.
- Customer source-portal credentials are runtime tenant secrets stored via the application into managed secret storage; they are not GitHub deployment secrets.

## 4. Infrastructure modules and deployed topology

```text
____________________________________________________________________________________________________
|                               TERRAFORM ENVIRONMENT ROOT                                            |
|                    infra/terraform/environments/{dev|uat|prod}                                     |
|__________________________________________________________________________________________________|
|                         |                         |                         |                        |
|                         v                         v                         v                        |
|  _____________________________   _____________________________   ________________________________   |
|  | gcp-foundation            |   | cloud-run-runtime         |   | gcp-serverless-origin       |   |
|  | project services, IAM,    |   | runtime services/jobs,    |   | shared HTTPS load balancer, |   |
|  | buckets, registry, etc.   |   | identities, secrets refs  |   | origin/cert integration     |   |
|  |___________________________|   |___________________________|   |______________________________|   |
|                         |                         |                         |                        |
|                         |_________________________|_________________________|                        |
|                                                   |                                              |
|                                                   v                                              |
|                                      _____________________________                                 |
|                                      | gcp-observability        |                                 |
|                                      | alerts, dashboard,       |                                 |
|                                      | optional billing budget  |                                 |
|                                      |__________________________|                                 |
|                                                   |                                              |
|                                                   v                                              |
|                                      GCP Singapore application plane                              |
|                                                                                                  |
|  _____________________________                 |                                                   |
|  | cloudflare-edge           |_________________|                                                   |
|  | DNS, proxy, edge policy   |       hardened public path                                         |
|  |___________________________|                                                                   |
|__________________________________________________________________________________________________|
```

Terraform and SQL migrations are the reproducible implementation sources. Manual provider-console changes are break-glass/bootstrap exceptions and should be reconciled back into code.

## 5. GitHub Actions control plane

```text
____________________________________________________________________________________________________
|                                  REVIEWED GITHUB CHANGE                                             |
|__________________________________________________________________________________________________|
| pull request                                                                                       |
|    |                                                                                               |
|    v                                                                                               |
| ci.yml + CodeQL + Terraform validation + leak/security checks                                      |
|    |                                                                                               |
|    v                                                                                               |
| merge to main                                                                                      |
|    |                                                                                               |
|    |----> build-release.yml ------> immutable image in Artifact Registry                           |
|    |                                                                                               |
|    |----> terraform-deploy.yml ---> OIDC/WIF ---> GCP + Cloudflare Terraform apply                |
|    |                                      |                                                        |
|    |                                      |----> database/runtime configuration                    |
|    |                                      |----> Cloud Run / Jobs                                  |
|    |                                      |----> Secret Manager references                         |
|    |                                                                                               |
|    |----> security-acceptance.yml -> live post-deploy checks + evidence                            |
|    |                                                                                               |
|    |----> control-loop.yml --------> repository/control health evidence                            |
|    |                                                                                               |
|    |----> runtime-secrets.yml -----> approved runtime-secret propagation/rotation                  |
|__________________________________________________________________________________________________|
```

GitHub Environments `dev`, `uat`, and `prod` contain only external trust roots and true operator decisions. Deterministic values are derived in workflows/Terraform. GCP authentication uses GitHub OIDC to Workload Identity Federation rather than stored service-account keys.

## 6. What is intentionally outside the repository

The repository contains the code and reproducible configuration, but it cannot bootstrap ownership or first trust for every external provider. The business-owned setup checklist is maintained in Confluence, especially **Infrastructure & Deployment — Business Architecture & Guardrails** and **Company Operations — Finance, People, Insurance & Vendor Governance**.

The external boundary includes, at minimum:

- legal/company ownership, billing identity, bank/payment method and procurement approval;
- registered domain ownership and Cloudflare account/zone ownership;
- Google Workspace / company identities and recovery controls;
- GCP organization/projects, billing attachment, and the initial GitHub OIDC/WIF trust anchor;
- GitHub repository/environment ownership and entering the minimal environment roots documented in `GITHUB_ENVIRONMENTS.md`;
- Supabase organization/project ownership, billing, region choice, and first management/bootstrap credential where required;
- third-party vendor contracts/DPA/data-use approvals and provider account ownership;
- production AI/OCR/email/source-provider accounts only when activated;
- Snowflake account only after its explicit activation gate;
- insurance, e-signature, CRM/support, and other business SaaS setup outside executable product code.

After those ownership/trust roots exist, provider configuration should flow from reviewed GitHub code wherever the provider supports API/IaC management.

## 7. Related technical documents

- [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md) — provider topology and IaC principles.
- [`MODULARITY.md`](MODULARITY.md) — module boundaries and failure isolation.
- [`DATA_PLATFORM.md`](DATA_PLATFORM.md) — structured data and downstream analytics boundaries.
- [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md) — minimal environment variables/secrets and one-time bootstrap exceptions.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — deployment, promotion and rollback flow.
- [`PRODUCTION_ACTIVATION.md`](PRODUCTION_ACTIVATION.md) — provider-side evidence required before production traffic.
- [`ENTERPRISE_IMPLEMENTATION.md`](ENTERPRISE_IMPLEMENTATION.md) — implemented vs remaining technical gaps.
