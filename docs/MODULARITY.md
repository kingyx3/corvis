# Production modularity and failure-isolation standard

This document is the technical source of truth for Corvis module boundaries and failure isolation. Confluence owns the business/product outcomes and readiness gates; GitHub owns the implementation boundaries, interfaces, tests and deployment mechanics.

## Goal

A defect, provider outage, slow dependency or in-progress debug session in one Corvis capability must not unnecessarily take down unrelated customer workflows.

Corvis therefore follows a **bounded modular-monolith first, independently deployable where justified** model:

- modules expose narrow typed ports;
- UI features consume module-specific ports rather than provider SDKs;
- API routes are thin authorization/validation adapters;
- persistence/provider code sits behind module repositories/adapters;
- asynchronous cross-module work uses durable events/jobs rather than long synchronous call chains;
- each module owns its failure, retry, health and observability behavior;
- a module may be split into an independent Cloud Run service/job without changing the product contract.

## Primary bounded modules

| Module | Owns | Must not own |
| --- | --- | --- |
| Source acquisition | customer uploads, approved source connectors, source identity/acquisition lineage | extraction semantics, canonical facts, customer delivery |
| Document registry | immutable document/artifact metadata and quarantine/release state | AI extraction logic |
| Processing/orchestration | durable stage progression, retries, idempotency, dead-letter/replay | provider-specific business semantics |
| Extraction | document interpretation and candidate extraction under the governed extraction contract | publication decisions |
| Review/quality | human/deterministic review decisions, exceptions and correction workflow | source acquisition transport |
| Canonical data | governed observations, identities, reconciliation/consolidation and history | UI state |
| Publication | fund-period snapshot gate/state/versioning | raw extraction |
| Serving/workspace | tenant-safe read models for customer UI/API | canonical writes |
| Research | permissioned semantic/retrieval orchestration and citations | authorization policy definition |
| Delivery | exports, webhooks and optional downstream shares | canonical truth |
| Identity/entitlements | authenticated identity, RBAC/resource rights and tenant/workspace boundaries | feature implementation |
| Admin/control | flags, readiness, lifecycle/control evidence | customer analytical data semantics |

## Dependency rules

1. Domain contracts in `core/` must not import provider adapters.
2. Feature/UI code in `features/` depends on typed ports/runtime composition, not direct provider SDKs or SQL.
3. Application use cases depend on ports, not concrete adapters.
4. Provider adapters may depend inward on contracts; core/application code must not depend outward on provider implementations.
5. Cross-module writes are never hidden side effects. Use an explicit use case or durable event/job.
6. No application dual writes between Postgres and optional Snowflake.
7. Customer-visible reads use serving/read contracts; they do not query provider-specific canonical tables directly from UI code.
8. Source connectors feed the standard document-ingestion contract instead of creating a parallel extraction path.

## Failure isolation

### Customer UI

Initial workspace loading is **partial-success tolerant**. Documents, fund-period snapshots and observations load independently. If one read module fails:

- successful modules remain usable;
- the shell shows a scoped degraded-state notice;
- the failed feature shows its own error/empty state where appropriate;
- retrying/debugging that module must not blank the whole workspace.

Critical commands (upload, review, publish, export) fail locally and must not corrupt another module's state.

### Server/runtime

Each module must define:

- explicit timeout/cancellation behavior for external calls;
- bounded retries only for retry-safe operations;
- idempotency keys/inbox/outbox semantics for durable work;
- dead-letter/replay behavior where asynchronous;
- module-scoped health/readiness signals;
- structured logs/metrics/traces including tenant-safe correlation IDs;
- a feature flag/kill switch when safe degradation is possible.

A non-critical module being unavailable must not make the entire application fail readiness. Production readiness should distinguish **required core dependencies** from **optional/degradable capabilities**.

## Debugging rule

Do not temporarily bypass authorization, RLS, tenant scoping, lineage, idempotency or publication gates to debug another module. Use dependency injection, demo/test adapters, feature flags, isolated UAT fixtures and module-local observability instead.

## Testing pyramid

Every module should have:

1. contract/unit tests for pure behavior;
2. adapter tests for provider boundaries;
3. module integration tests against production-equivalent dependencies where practical;
4. negative tenant/security tests;
5. customer-journey E2E tests only for the cross-module seams that matter to users.

E2E tests must include degradation scenarios proving that an unrelated module failure does not destroy the rest of the customer journey.

## Canonical customer journey

The minimum customer-facing journey that must remain continuously executable is:

```text
customer signs in
  → uploads/authorizes a source document
  → sees source registered and processing status
  → processing produces governed structured observations
  → required review/quality gates are visible
  → a fund-period snapshot becomes publishable/published
  → customer can browse structured data with source lineage
  → customer can request a structured export/API delivery
```

The demo test harness may simulate processing, but production/UAT acceptance must exercise the real module boundaries and provider integrations.

## Deployment evolution

Keep a module in the main API/runtime while it is operationally simpler and its blast radius is acceptably bounded. Split it into an independent Cloud Run service/job when one or more of these are true:

- materially different scaling profile;
- materially different security/credential boundary;
- long-running or failure-prone processing;
- independent release cadence is valuable;
- provider dependencies make isolation materially safer;
- its incidents repeatedly affect unrelated capabilities.

Extraction workers, portal/browser connector workers, export rendering and other asynchronous processing are natural candidates for independent jobs/services. Splitting services without a demonstrated isolation/scaling reason is not a goal by itself.

## Review checklist

For each material change ask:

- Which module owns this behavior?
- Is the interface narrower than the provider implementation?
- What happens if this dependency is slow or unavailable?
- Can another module continue serving customers?
- Is retry/idempotency explicit?
- Are tenant/right boundaries enforced at the module boundary?
- Can the module be tested with a fake adapter without weakening production controls?
- Does the change introduce a hidden synchronous dependency or shared mutable state?
- Is module-specific telemetry sufficient to debug it without changing unrelated code?
