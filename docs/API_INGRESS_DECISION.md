# Public API ingress architecture decision

**Status:** approved target architecture; migration not yet complete  
**Decision date:** 2026-09-20  
**Implementation tracking:** #99

This document records the approved technical direction for Corvis public API ingress. It deliberately distinguishes the **target architecture** from the **currently deployed/implemented Terraform** so documentation does not claim controls that have not yet been proven in UAT.

Business-level architecture and cost/security guardrails are owned in Confluence. This repository owns the executable implementation and acceptance evidence.

## Decision

Replace the fixed-cost Cloudflare -> GCP External Application Load Balancer + Cloud Armor -> Cloud Run API origin path with a usage-priced identity-based path:

```text
________________________________________________________________________________
|                           PUBLIC API TARGET                                  |
|______________________________________________________________________________|
| Internet                                                                     |
|    |                                                                         |
|    v                                                                         |
| Cloudflare edge + Worker                                                     |
| DNS | TLS | DDoS/WAF | rate controls | bounded API proxy                    |
|    |                                                                         |
|    | edge-only gateway credential + customer request authorization           |
|    v                                                                         |
| Google API Gateway                                                           |
|    |                                                                         |
|    | Google-signed identity for dedicated gateway service account            |
|    v                                                                         |
| Cloud Run                                                                    |
| IAM-private | no allUsers invoker | scale-to-zero                            |
|    |                                                                         |
|    +------------------> Supabase Postgres                                     |
|    +------------------> GCS / Pub/Sub / Cloud Tasks                           |
|    +------------------> Cloud Run Jobs / workers                              |
|______________________________________________________________________________|
```

Cloudflare remains the public edge. Google API Gateway becomes the GCP public API ingress. Cloud Run becomes an IAM-protected backend invoked by a dedicated gateway service identity.

A GCP External Application Load Balancer and Cloud Armor are no longer baseline requirements merely to front Cloud Run. They may be reintroduced only when a documented network-layer, customer, regulatory, or service-capability requirement cannot be satisfied by the gateway design.

## Security boundaries

The architecture uses separate identities for separate purposes:

```text
________________________________________________________________________________
| CONTROL                         | PURPOSE                                     |
|_________________________________|_____________________________________________|
| Cloudflare Worker/edge secret   | prove request traversed the approved edge  |
| Application user/session/JWT    | identify customer/user and tenant rights   |
| API Gateway service account     | authorize gateway -> Cloud Run invocation  |
| Postgres RLS/application auth   | enforce tenant/data/action authorization    |
|_________________________________|_____________________________________________|
```

The edge credential is **not** customer authentication and must never be treated as proof of tenant membership, user identity, entitlement, or data rights.

Application authentication and authorization remain authoritative during the migration. Gateway-side JWT validation may be added later when the production issuer/JWKS/audience contract is stable, versioned, and covered by negative acceptance tests.

### Cloud Run invocation

Target state:

- no `allUsers` `roles/run.invoker` grant;
- one dedicated API Gateway runtime service account receives `roles/run.invoker` for the API service;
- direct unauthenticated requests to the default Cloud Run URL fail IAM authorization;
- workload identity replaces network-location trust as the backend invocation boundary.

### Gateway bypass resistance

The Google API Gateway endpoint is provider-public. Requests that bypass Cloudflare must therefore fail a gateway control before the application backend is invoked. The migration will use an edge-only gateway credential managed through IaC and injected into the Cloudflare Worker as a secret binding.

This control supplements rather than replaces user authentication. Security acceptance must prove missing/invalid edge credentials are rejected and that direct Cloud Run invocation is rejected independently.

## Large document uploads

Ordinary source-report bodies must not traverse Cloudflare Worker -> API Gateway -> Cloud Run.

```text
________________________________________________________________________________
|                         SOURCE DOCUMENT UPLOAD                               |
|______________________________________________________________________________|
| Browser/client                                                               |
|      |                                                                       |
|      | 1. authenticated upload-init request                                  |
|      v                                                                       |
| Corvis API                                                                   |
|      |                                                                       |
|      | 2. bounded signed/resumable upload authorization                      |
|      v                                                                       |
| Browser/client ================= direct upload ======================> GCS    |
|                                                                  |           |
|                                                                  v           |
|                                                     registration / queues     |
|______________________________________________________________________________|
```

This preserves the existing GCS source-of-truth model, avoids gateway request-size/streaming constraints, and avoids paying edge/gateway processing for large document bytes.

## Cost posture

The purpose of this change is not to weaken controls for cost. It removes infrastructure whose main value can be replaced by a stronger workload-identity boundary for the current Corvis API use case.

Expected baseline fixed-cost changes after migration:

- remove always-on GCP external load-balancer fixed cost;
- remove baseline Cloud Armor policy/rule fixed cost;
- retain Cloud Run scale-to-zero;
- use API Gateway on usage-priced/free-tier economics at early volume;
- use Cloudflare Worker on the smallest plan that satisfies traffic/security/support requirements.

Actual spend must be measured from provider billing after UAT/prod activation rather than treated as a permanent pricing promise.

## GitHub configuration policy

The migration must not add deterministic provider identifiers as human-managed GitHub variables.

In particular:

- derive the Cloudflare account ID from the existing zone lookup;
- derive API Gateway IDs/hostnames from Terraform outputs;
- generate/manage the edge-only gateway credential through IaC and Worker secret bindings;
- do not add `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, gateway hostnames, Cloud Run URLs, or service-account names as copied GitHub variables;
- keep only external trust roots and genuine operator decisions in GitHub Environments.

## Migration state

The current repository Terraform still implements the previous production-like origin path:

```text
Cloudflare
    |
    v
GCP External Application Load Balancer
    |
Cloud Armor / origin TLS controls
    |
    v
Cloud Run
```

That remains the **current implementation** until #99 is complete and UAT acceptance passes. Existing security-acceptance documentation/tests that refer to load-balancer IPs, Cloud Armor, Certificate Manager, or Authenticated Origin Pulls describe the current implementation, not the approved target.

Do not delete the old path before the replacement path is deployed and proved fail-closed in UAT.

## Migration acceptance contract

Issue #99 owns implementation. The migration is complete only when UAT proves all of the following:

1. the custom UAT API hostname successfully traverses Cloudflare Worker -> API Gateway -> Cloud Run;
2. missing/invalid edge-only gateway credentials are rejected without reaching the backend;
3. direct unauthenticated Cloud Run requests fail IAM authorization;
4. Cloud Run has no `allUsers` invoker grant;
5. the intended gateway workload identity is the only normal public-path Cloud Run invoker;
6. application authentication, tenant isolation/RLS, CSRF/cache-safety, WAF and rate-limit acceptance still pass;
7. large source uploads continue directly to GCS;
8. Terraform no longer contains the old external LB/Cloud Armor baseline after cutover;
9. GitHub environment configuration remains minimal and derived values remain derived;
10. sanitized evidence is retained for the accepted release SHA.

## Related documentation

- `ARCHITECTURE.md` — current repository/deployed architecture map.
- `INFRASTRUCTURE.md` — current infrastructure implementation source of truth.
- `SECURITY_ACCEPTANCE.md` — executable acceptance contract for the currently implemented boundary; update as #99 lands.
- `GITHUB_ENVIRONMENTS.md` — minimal environment roots; update derived-value tables as #99 lands.
- Confluence: **Infrastructure & Deployment — Business Architecture & Guardrails** — approved business architecture and cost/security guardrails.
