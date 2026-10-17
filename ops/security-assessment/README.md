# Independent production security assessment pack

This directory prepares Corvis for the independent production-like UAT security assessment tracked by issue #80. It is intentionally safe for a public repository and must not contain credentials, private assessor reports, customer data, exploit payloads against third parties, or confidential infrastructure exports.

## In-scope production-equivalent boundaries

The assessor should test the deployed UAT configuration that mirrors production: Cloudflare DNS/TLS/WAF/Workers; the customer, admin and public API hostnames; Google API Gateway identities and API keys; IAM-private Cloud Run API/customer/admin/worker services; the scheduled control-loop Cloud Run Job; authentication/session lifecycle; tenant authorization and Postgres RLS; upload and immutable GCS source lineage; Pub/Sub and Cloud Tasks service identity; source connections; webhooks and exports; review/recovery/correction controls; and any enabled Ask Corvis retrieval/evidence boundary. Components added since the first scope pack are also in scope:

- the AI runtime: the extractor service (`services/extractor`), the LiteLLM gateway (`services/litellm-gateway`) and `infra/terraform/modules/ai-runtime`, including its budget enforcement and outbound reachability;
- SCIM v2 provisioning (`/api/v1/scim/v2`), its bearer credential handling and tenant binding;
- the internal service endpoints `/api/internal/budget-guard`, `/api/internal/delivery` and `/api/internal/processing-stage`, which must be reachable only by their intended service identities;
- machine identities: service accounts and API keys (`docs/features/SERVICE_ACCOUNTS.md`), which carry one workspace and one role and no implicit data access;
- the separate runtime and migration database credentials (`docs/security/RUNTIME_DATABASE_ROLE.md`): the application must connect as a member of `corvis_runtime`, never as the owner or migration login;
- the shared Cloudflare zone model with first-level UAT hostnames such as `api-uat`, `app-uat` and `admin-uat` (`docs/operations/CLOUDFLARE_SHARED_ZONE.md`), where production and UAT share a zone but must not share hostnames, origins or credentials.

Source review is useful but does not substitute for testing the deployed production-equivalent configuration.

## Test identities and data

Use dedicated sanitized UAT tenants only. At minimum provision two ordinary tenants; per tenant an Organization Admin (`tenant_admin`), a workspace-level analyst and a review analyst; a Corvis operator identity separate from both tenants; a service account per tenant with a granted and an ungranted data scope; and the production-equivalent service identities. Give each tenant its own funds, documents, exports, webhooks and source connections so object-reference (IDOR) tests can name a real object that belongs to the other tenant. `sanitized-test-corpus.json` lists the identities and per-tenant objects. The corpus must contain synthetic documents and deterministic expected outputs; no customer data or production credentials may be copied into the assessment environment.

## Required negative tests

The assessment must cover cross-tenant read/write attempts, privilege escalation, session revocation, direct origin/gateway bypass attempts, customer/admin runtime surface isolation, unauthorized worker invocation, RLS bypass attempts, upload authorization/content controls, webhook signing/replay behavior, export authorization and expiry, secret exposure in errors/logs, and mutation/recovery endpoints that require `admin:manage`. Added for the components above: cross-tenant SCIM provisioning and deprovisioning, unauthenticated or wrongly authenticated calls to the internal service endpoints, AI gateway budget exhaustion and unexpected outbound access, a service account reading beyond its granted data scope or escalating its role, use of the application login for owner or migration actions, and UAT/production hostname or credential confusion in the shared Cloudflare zone.

This pack is source-derived preparation; the exact deployed targets must still be reconciled with the assessor before testing.

## Evidence handling

Only sanitized scope, status, remediation references and non-sensitive proof belong in this public repository. Full reports, screenshots containing identifiers, exploit traces, credentials, provider exports and customer-like data must be retained in an access-controlled evidence repository referenced by the enterprise control process.

## Launch disposition

Every finding requires an owner and disposition. Any finding judged launch-blocking by the independent assessor or Corvis risk owner must be remediated and objectively retested before production approval. A completed source scan or this preparation pack is not an independent assessment and must never be represented as certification or attestation.
