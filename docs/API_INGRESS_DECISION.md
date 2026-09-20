# Public API ingress architecture decision

**Status:** implemented in repository; live UAT rollout/evidence pending  
**Decision date:** 2026-09-20  
**Implementation tracking:** #99

This document records the approved Corvis public API ingress architecture and its rollout state. The Terraform, Worker proxy and security-acceptance contract now implement the target design in the repository; this does **not** claim that provider-side UAT resources have already been applied or that live controls have already passed.

Business-level architecture and cost/security guardrails are owned in Confluence. This repository owns the executable implementation and acceptance evidence.

## Implemented design

```text
________________________________________________________________________________
|                           PUBLIC API PATH                                    |
|______________________________________________________________________________|
| Internet                                                                     |
|    |                                                                         |
|    v                                                                         |
| Cloudflare edge + Worker                                                     |
| DNS | TLS | DDoS/WAF | rate controls | bounded API proxy                    |
|    |                                                                         |
|    | Terraform-managed edge-only restricted API key                          |
|    v                                                                         |
| Google API Gateway                                                           |
|    |                                                                         |
|    | Google-signed identity for dedicated gateway service account            |
|    v                                                                         |
| Cloud Run                                                                    |
| IAM-private invocation | no allUsers invoker | scale-to-zero                 |
|    |                                                                         |
|    +------------------> Supabase Postgres                                     |
|    +------------------> GCS / Pub/Sub / Cloud Tasks                           |
|    +------------------> Cloud Run Jobs / workers                              |
|______________________________________________________________________________|
```

Cloudflare remains the public edge. Google API Gateway is the GCP public API ingress. Cloud Run is an IAM-protected backend invoked by a dedicated gateway service identity.

The old GCP External Application Load Balancer + Cloud Armor + Certificate Manager + origin-mTLS module has been removed from the baseline repository implementation. Those services may be reintroduced only when a documented network-layer, customer, regulatory, or service-capability requirement cannot be satisfied by the gateway design.

## Security boundaries

The architecture uses separate identities for separate purposes:

```text
________________________________________________________________________________
| CONTROL                         | PURPOSE                                     |
|_________________________________|_____________________________________________|
| Cloudflare Worker edge key      | prove approved edge traversal              |
| Application identity assertion  | identify customer/user and tenant rights   |
| API Gateway service account     | authorize gateway -> Cloud Run invocation  |
| Postgres RLS/application auth   | enforce tenant/data/action authorization    |
|_________________________________|_____________________________________________|
```

The edge credential is **not** customer authentication and must never be treated as proof of tenant membership, user identity, entitlement, or data rights.

Application authentication and authorization remain authoritative. Gateway-side JWT validation may be added later when the production issuer/JWKS/audience contract is stable, versioned, and covered by negative acceptance tests.

### Cloud Run invocation

Repository state:

- no `allUsers` `roles/run.invoker` grant exists in the public API path;
- `corvis-gateway-${environment}` receives `roles/run.invoker` for the API service;
- API Gateway uses that identity for backend authentication;
- Cloud Run uses `INGRESS_TRAFFIC_ALL` because API Gateway is not a Cloud Run internal-ingress source;
- direct unauthenticated requests to the default Cloud Run URL must fail IAM authorization.

The service is therefore network-reachable but not publicly invokable. Workload identity, not source-network location, is the backend authorization boundary.

### Gateway bypass resistance

The provider `gateway.dev` endpoint is public. Requests that bypass Cloudflare must fail a gateway control before the application backend is invoked.

Terraform creates a Google API key restricted to the generated Corvis managed API. The value remains sensitive in Terraform state and is passed directly into the Cloudflare Worker as a `secret_text` binding. It is not a copied GitHub Environment secret.

The Worker removes any caller-supplied `x-api-key`, injects its own restricted key, and only proxies the `/api/v1` surface. `workers.dev` and Worker preview URLs are disabled.

## Large document uploads

Ordinary source-report bodies do not traverse Cloudflare Worker -> API Gateway -> Cloud Run.

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
|      | 2. native GCS resumable-session authorization                         |
|      v                                                                       |
| Browser/client ================= direct upload ======================> GCS    |
|                                                                  |           |
|                                                                  v           |
|                                                     registration / queues     |
|______________________________________________________________________________|
```

This preserves the existing GCS source-of-truth model and avoids gateway request-size/streaming constraints and unnecessary edge/gateway processing of document bytes.

## Cost posture

This change removes fixed-cost edge infrastructure without weakening the intended authorization model:

- no baseline GCP external load-balancer fixed cost;
- no baseline Cloud Armor policy/rule fixed cost;
- Cloud Run remains scale-to-zero;
- API Gateway is usage-priced with low-volume free-tier economics subject to current provider pricing;
- Cloudflare Worker uses the smallest plan that satisfies traffic/security/support requirements.

Actual spend must be measured from provider billing after UAT/prod activation rather than treated as a permanent pricing promise.

## GitHub configuration policy

The implementation does not add deterministic provider identifiers as human-managed GitHub variables.

- Cloudflare account ID and zone ID come from the existing zone lookup;
- API Gateway IDs/hostnames come from Terraform/GCP outputs;
- the gateway service-account name is deterministic from project + environment;
- the edge-only gateway credential is generated through IaC and injected into the Worker secret binding;
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, gateway hostnames, gateway API keys, Cloud Run URLs, and service-account names must not become copied GitHub variables;
- only external trust roots and genuine operator decisions belong in GitHub Environments.

## Rollout state

The repository implementation is complete enough for CI/provider planning, but production-like operation is **not evidenced until UAT apply + live Security acceptance succeed**.

Issue #99 therefore remains open through rollout. A code merge is not equivalent to provider evidence.

## Live UAT acceptance contract

UAT must prove all of the following before this migration is considered operationally complete:

1. the custom UAT API hostname successfully traverses Cloudflare Worker -> API Gateway -> Cloud Run;
2. the response proves Worker traversal;
3. missing and invalid edge-only gateway credentials are rejected at the direct gateway endpoint;
4. direct unauthenticated Cloud Run requests fail IAM authorization;
5. Cloud Run has no `allUsers` invoker grant;
6. the dedicated gateway workload identity is the only normal public-path Cloud Run invoker;
7. application authentication, tenant isolation/RLS, CSRF/cache-safety, WAF and rate-limit acceptance still pass;
8. large source uploads continue directly to GCS;
9. Terraform state/plan contains no legacy external LB/Cloud Armor baseline after cutover;
10. GitHub environment configuration remains minimal and derived values remain derived;
11. sanitized evidence is retained for the accepted release SHA.

## Related documentation

- `ARCHITECTURE.md` — repository and provider topology.
- `INFRASTRUCTURE.md` — implementation source of truth.
- `SECURITY_ACCEPTANCE.md` — executable Worker/gateway/IAM/RLS acceptance contract.
- `GITHUB_ENVIRONMENTS.md` — minimal environment roots and derived values.
- Confluence: **Infrastructure & Deployment — Business Architecture & Guardrails** — approved business architecture and cost/security guardrails.
