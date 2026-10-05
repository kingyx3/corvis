# Corvis repository architecture

This document is the high-level technical map for how the code in this repository fits together. It describes the physical repository, dependency direction, deployed provider topology, and GitHub Actions control plane.

For business architecture, vendor/account ownership, procurement, and one-time external setup outside the repository, use Confluence. GitHub remains the source of truth for executable technical implementation.

## 1. Repository-wide code map

```text
____________________________________________________________________________________________________
|                                      CORVIS REPOSITORY                                             |
|__________________________________________________________________________________________________|
|                                                                                                    |
|  PRODUCT / HTTP ENTRY                  src/                                                        |
|  ________________________________________________________________________________________________  |
|  | app/                     | proxy.ts                  | modules/<module>/ui/   | shared/ui/    |  |
|  | Next.js pages + APIs     | request boundary          | feature views + state  | design system |  |
|  |__________________________|___________________________|________________________|_______________|  |
|                                      |                                                             |
|                                      v                                                             |
|  SERVER + COMPOSITION                                                                              |
|  ________________________________________________________________________________________________  |
|  | modules/<module>/server/ | composition/              | platform/                           |  |
|  | use cases, repositories, | dependency wiring         | http, database, gcp, config,        |  |
|  | HTTP helpers, workers    | + adapter selection       | telemetry (cross-cutting)           |  |
|  |__________________________|___________________________|_____________________________________|  |
|                       |                         |                          |                       |
|             __________|_________________________|__________________________|________               |
|            v                           v                         v                    v              |
|  DOMAIN CONTRACTS             PROVIDER ADAPTERS           ASYNC / CONTROL       DATA CONTRACTS     |
|  _______________________       _______________________     __________________    __________________  |
|  | modules/*/domain/    |       | modules/*/adapters/  |     | services/      |    | db/postgres/  |  |
|  | shared/domain/       |       | HTTP/GCS/demo/etc.   |     | control-loop/  |    | migrations,   |  |
|  | typed ports + rules  |       | provider boundaries  |     | scanners, health|   | RLS, DB tests |  |
|  |______________________|       |_____________________|     |_______________|    |_______________|  |
|            |                           |                         |                    |              |
|            |___________________________|_________________________|____________________|              |
|                                                |                                                   |
|                                                v                                                   |
|  EXTERNAL RUNTIME DEPENDENCIES                                                                     |
|  ________________________________________________________________________________________________  |
|  | Cloudflare Worker | GCP API Gateway | Cloud Run / Jobs | GCS | Pub/Sub / Tasks / Scheduler |  |
|  | Secret Manager / KMS | Artifact Registry | Logging / Monitoring / Trace | Postgres | Snowflake* |
|  |______________________________________________________________________________________________|  |
|                                                                                                    |
|  DELIVERY / OPERATIONS / CONTRACTS                                                                 |
|  ________________________________________________________________________________________________  |
|  | infra/terraform/ | .github/workflows/ | openapi/ | ops/ | services/ | tools/ | e2e/ | docs/   |  |
|  | IaC              | CI/CD + governance | API spec | SRE  | deployables | tooling | E2E | docs   |  |
|  |__________________|____________________|__________|______|_____________|_________|_____|________|  |
|__________________________________________________________________________________________________|
```

`*` Snowflake is optional downstream analytics/secure sharing only after an explicit activation decision.

The intended dependency direction is inward: UI and API routes call application/server services; those services depend on domain contracts; concrete provider behavior lives behind adapters. Provider SDKs, SQL details, and cloud-specific behavior should not become product/domain contracts.

## 2. Repository layout and directory responsibilities

```text
src/                      application code (Next.js `src` folder; the `@/` alias resolves here)
  app/                    routing only: pages and route handlers, kept thin
  proxy.ts                per-request security boundary (CSP nonce); instrumentation-client.ts
  modules/<module>/       one directory per bounded module (see MODULARITY.md)
    domain/               pure contracts, ports and rules; no I/O, no React
    server/               use cases, repositories, HTTP helpers, workers and sweeps (server only)
    adapters/             provider- or demo-specific implementations of the module's ports
    ui/                   React views and client state for the module
    application/          client-side use cases, where a module has one
  platform/               cross-cutting server infrastructure: config/, http/, database/, data/, gcp/, observability/, runtime/, demo/
  shared/                 shared kernel: domain/ (enterprise, contracts, workspace), lib/ (client-safe helpers), ui/ (design system)
  composition/            the one place that selects and wires concrete adapters for the ports
  test-support/           helpers shared by unit tests (alias loader, OpenAPI support, fixtures)
services/                 code that runs outside the web app, each with its own Dockerfile
  control-loop/  extractor/  litellm-gateway/
tools/                    repository tooling
  ci/                     scripts called from GitHub Actions workflows
  dev/                    developer and operator utilities
  repo-checks/            tests that assert repository-wide policy (workflows, Terraform, docs, boundaries)
  convex-conformance/     isolated upstream database-semantics oracle
db/postgres/              migrations (immutable once applied), RLS/security acceptance SQL and DB tests
infra/terraform/          modules, environments and the shared Cloudflare root
openapi/                  the public API contract, compatibility baseline and route classification
ops/                      runbooks, SLOs, control catalogues and UAT/security assessment plans
e2e/                      Playwright customer-journey, accessibility and performance suites
docs/                     technical documentation, grouped by kind (see docs/README.md)
```

| Path | Responsibility |
| --- | --- |
| `src/app/` | Next.js application shell, customer-facing pages, and HTTP/API route handlers. |
| `src/modules/*/domain/` | Stable domain contracts and typed ports for each module. |
| `src/modules/*/server/` | Server-side use cases, persistence/orchestration helpers, control evidence, feature flags, and backend service implementation. |
| `src/modules/*/adapters/` | Provider-specific implementations such as HTTP delivery, GCS resumable upload, workspace access, and demo/test adapters. |
| `src/modules/*/ui/` | Feature-oriented UI/state for documents, review, delivery, research, and overview workflows. |
| `src/platform/` | Cross-cutting server infrastructure: configuration, HTTP helpers and request context, Postgres access, the demo/Postgres data platform, GCP clients, telemetry and readiness, and runtime-surface selection. |
| `src/shared/` | Shared domain vocabulary, client-safe helpers and reusable presentation components. |
| `src/composition/` | Runtime composition: selects/wires concrete implementations for domain ports. |
| `services/` | Deployable units that run outside the web app: the control loop, the extractor and the LiteLLM gateway. |
| `tools/` | CI scripts, developer utilities and repository-policy tests. |
| `db/` | Reviewed database migrations and Postgres-side security/data contracts, including RLS-related implementation. |
| `openapi/` | Public/controlled API contracts. |
| `infra/terraform/` | Executable infrastructure code for provider resources and environment roots. |
| `.github/workflows/` | CI, build/release, Terraform deployment, GCP bootstrap, runtime-secret propagation, security acceptance, and governance automation. |
| `ops/` | Runtime operations, SLOs, recovery and incident runbooks. |
| `e2e/` | Cross-module browser/customer-journey acceptance and quality tests. |
| `docs/` | Technical architecture, deployment, security, data-platform and production-activation documentation. |

### Where new code goes

- A new capability belongs in the module that owns its data and rules. Add `domain/` first (types, ports, validation), then `server/`, `adapters/` and `ui/` as needed. Create a new module only for a new bounded context.
- Code needed by several modules and unrelated to any one capability goes in `src/platform/` (server) or `src/shared/` (client-safe). If only two modules need it, keep it in the owning module and import it through that module's public files.
- Each module and area has a README (`src/modules/README.md`, `services/README.md`, `tools/README.md`); `tools/repo-checks/repository-layout.test.ts` fails if the layout drifts from this document.
- Tests sit next to the code they test as `*.test.ts`. Tests that read workflows, Terraform, docs or the source tree to assert repository policy go in `tools/repo-checks/`.
- Route handlers in `src/app/api/` stay thin: authenticate, validate, call a module's `server/` function, shape the response.
- Database migrations in `db/postgres/migrations/` are never edited once merged; the runner refuses checksum drift.

## 3. Customer request and data flow

```text
____________________________________________________________________________________________________
|                                  CUSTOMER / OPERATOR REQUEST                                       |
|__________________________________________________________________________________________________|
| Browser / API client                                                                               |
|        |                                                                                           |
|        v                                                                                           |
| Cloudflare public edge                                                                             |
| DNS | TLS | DDoS/WAF/rate controls | Worker                                                       |
|        |                                                                                           |
|        | Worker overwrites x-api-key with edge-only secret                                         |
|        v                                                                                           |
| Google API Gateway                                                                                 |
|        |                                                                                           |
|        | dedicated gateway service-account identity                                                |
|        v                                                                                           |
| Cloud Run: API runtime                                                                             |
| IAM: gateway service account only | no allUsers invoker | scale-to-zero                           |
|        |                                                                                           |
|        |----> signed application identity + authorization       [src/app/api + modules/*/server]             |
|        |----> application/domain service composition            [modules/*/server + composition + domain] |
|        |----> provider adapter                                  [modules/*/adapters + platform]             |
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
| Postgres ---- optional approved downstream replication ----> Snowflake analytics / secure sharing   |
|__________________________________________________________________________________________________|
```

Important boundaries:

- the Cloudflare edge key proves approved edge traversal only; it is not customer/user authentication;
- Cloud Run is network-reachable because API Gateway is not a Cloud Run internal-ingress source, but direct unauthenticated invocation is blocked by IAM;
- application authentication/authorization and Postgres RLS remain independent of the edge/gateway controls;
- Postgres is the authoritative structured write path; Snowflake is downstream only when explicitly activated;
- GCS is the immutable source/replay artifact store; large uploads go browser-to-GCS rather than through Worker/API Gateway/Cloud Run request bodies;
- async processing uses queues/jobs so extraction, connector, export, and other long-running work can fail/retry independently of synchronous customer requests;
- customer source-portal credentials are runtime tenant secrets stored via the application into managed secret storage; they are not GitHub deployment secrets.

### Tenant invitations

Tenant/workspace provisioning creates its first organization-admin invitation in the same database transaction as the tenant, workspace and audit receipt. Tenant administrators can issue additional workspace invitations from Access administration. Invitation records keep only a SHA-256 token digest, role, normalized email and expiry; the raw link is returned once and placed in the URL fragment so browsers do not send it in the request URL or referrer. Acceptance requires both that token and an authenticated OIDC/SAML identity with an explicit verified-email claim matching the invited address. A Postgres function locks and consumes the invitation while linking the immutable auth subject, creating the membership and appending the audit event atomically. After the invitation commits it is also emailed to the invited address (the link is never persisted), with the manual copy-link fallback kept; see [`NOTIFICATIONS.md`](../features/NOTIFICATIONS.md). Until an email provider is activated, delivery reports `not_configured`.

### Workspace selection

The sidebar lists only the workspaces returned by the authenticated `my-workspaces` endpoint. Selecting one persists its tenant/workspace identifiers as untrusted request selectors and performs a full reload so no component state, search result, modal or request from the previous workspace survives. Every API call sends the selected context and the server independently re-resolves active membership, roles and entitlements from Postgres; appearing in the switcher never grants access by itself.

### Browser response security headers and CSP

`src/proxy.ts` and `next.config.ts` set the response security headers for every route (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and `Strict-Transport-Security` in production). Content-Security-Policy is generated per-request in `src/proxy.ts` (`src/platform/http/content-security-policy.ts`), not as a static header, because `script-src` carries a fresh nonce on every response:

- `script-src 'self' 'nonce-<random>' 'strict-dynamic'` — no `unsafe-inline`; the framework runtime, page bundles and RSC flight-data scripts all receive the matching `nonce` attribute automatically (verified in production output — see `e2e/content-security-policy.spec.ts`, run via `npm run test:e2e:csp` against a real `npm run build`/`npm run start`, and required in CI's `e2e` job). This closes the constraint tracked in issue #159: production Next.js 16.3.5 App Router output supports hydration-safe nonces.
- `style-src 'self' 'unsafe-inline'` stays as-is: inline `style="..."` attributes (used throughout for computed widths/colors) cannot carry a nonce, so this is an accepted, unrelated tradeoff — only `script-src` dropped `unsafe-inline`.
- the nonce requires dynamic rendering; `src/app/layout.tsx` calls `connection()` so every route renders per-request (consistent with `src/proxy.ts` already sending `cache-control: no-store` on every response — nothing here was cacheable before this change either).

## 4. Infrastructure modules and deployed topology

```text
____________________________________________________________________________________________________
|                               TERRAFORM ENVIRONMENT ROOT                                            |
|                    infra/terraform/environments/{dev|uat|prod}                                     |
|__________________________________________________________________________________________________|
|                                                                                                    |
|  _____________________________   _____________________________   ________________________________   |
|  | gcp-foundation            |   | cloud-run-runtime         |   | gcp-api-gateway            |   |
|  | services, IAM, buckets,   |-->| API runtime, identities, |-->| gateway, edge API key,      |   |
|  | registry, queues, KMS     |   | runtime secret refs      |   | gateway SA + invoker IAM   |   |
|  |___________________________|   |___________________________|   |______________________________|   |
|                                                                 |                                  |
|                                                                 v                                  |
|                                                 ______________________________                      |
|                                                 | cloudflare-edge             |                      |
|                                                 | Worker, route, DNS, WAF,   |                      |
|                                                 | rate limit, cache bypass    |                      |
|                                                 |____________________________|                      |
|                                                                                                    |
|  _____________________________                                                                     |
|  | gcp-observability        |                                                                      |
|  | alerts, dashboard,       |                                                                      |
|  | optional billing budget  |                                                                      |
|  |__________________________|                                                                      |
|__________________________________________________________________________________________________|
```

The former `gcp-serverless-origin` module and its external load balancer, Cloud Armor, Certificate Manager and origin-mTLS resources are no longer part of the baseline code.

Terraform and SQL migrations are the reproducible implementation sources. Manual provider-console changes are break-glass/bootstrap exceptions and should be reconciled back into code.

## 5. GitHub Actions control plane

```text
____________________________________________________________________________________________________
|                                  REVIEWED GITHUB CHANGE                                             |
|__________________________________________________________________________________________________|
| pull request                                                                                       |
|    |                                                                                               |
|    v                                                                                               |
| CI + CodeQL + Terraform validation + leak/security checks                                          |
|    |                                                                                               |
|    v                                                                                               |
| merge to main                                                                                      |
|    |                                                                                               |
|    |----> build-release.yml ------> immutable image in Artifact Registry                           |
|    |                                                                                               |
|    |----> terraform-deploy.yml ---> OIDC/WIF ---> GCP + Cloudflare Terraform apply                |
|    |                                      |                                                        |
|    |                                      |----> Cloud Run / Jobs                                  |
|    |                                      |----> API Gateway + restricted edge key                 |
|    |                                      |----> Cloudflare Worker / route / edge policy           |
|    |                                      |----> Secret Manager references                         |
|    |                                                                                               |
|    |----> security-acceptance.yml -> live Worker/gateway/IAM/RLS checks + evidence                |
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

- [`API_INGRESS_DECISION.md`](./API_INGRESS_DECISION.md) — ingress architecture decision and rollout state.
- [`INFRASTRUCTURE.md`](../operations/INFRASTRUCTURE.md) — provider topology and IaC principles.
- [`SECURITY_ACCEPTANCE.md`](../security/SECURITY_ACCEPTANCE.md) — live Worker/gateway/IAM/RLS acceptance contract.
- [`MODULARITY.md`](./MODULARITY.md) — module boundaries and failure isolation.
- [`DATA_PLATFORM.md`](./DATA_PLATFORM.md) — structured data and downstream analytics boundaries.
- [`GITHUB_ENVIRONMENTS.md`](../operations/GITHUB_ENVIRONMENTS.md) — minimal environment variables/secrets and one-time bootstrap exceptions.
- [`DEPLOYMENT.md`](../operations/DEPLOYMENT.md) — deployment, promotion and rollback flow.
- [`PRODUCTION_ACTIVATION.md`](../operations/PRODUCTION_ACTIVATION.md) — provider-side evidence required before production traffic.
- [`ENTERPRISE_IMPLEMENTATION.md`](../operations/ENTERPRISE_IMPLEMENTATION.md) — implemented vs remaining technical gaps.
