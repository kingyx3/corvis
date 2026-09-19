# Security acceptance: edge, origin and tenant isolation

This document owns the executable technical security-acceptance contract for the Corvis public edge and Postgres tenant-isolation boundary. Business/security-control requirements and readiness decisions remain in Confluence.

## Edge and origin policy as code

`infra/terraform/modules/cloudflare-edge` manages public-edge controls for production-like environments. `infra/terraform/modules/gcp-serverless-origin` owns the API origin bridge and enforces a second independent boundary:

- Cloudflare proxied DNS, Full (strict) TLS, custom WAF, API rate limiting and dynamic-cache bypass;
- GCP external managed HTTPS load balancer with a Cloud Run serverless NEG;
- Cloud Run ingress restricted to internal and Cloud Load Balancing;
- Cloud Armor attached to the API backend with current Cloudflare proxy IPv4 ranges derived from the Cloudflare provider;
- a default-deny Cloud Armor rule returning 403 for direct load-balancer traffic that does not come from Cloudflare;
- load-balancer request logging enabled for origin-security evidence;
- Google-managed origin certificate lifecycle through Certificate Manager DNS authorization.

Cloudflare remains separate from application authentication and tenant authorization. Passing the edge does not grant an application identity, workspace membership, entitlement or data right.

## Deployment inputs

The normal GitHub Environment inputs remain documented in `GITHUB_ENVIRONMENTS.md`. Direct-origin probe URLs and origin IPs are not human-managed inputs. Security acceptance authenticates to GCP through GitHub OIDC/WIF and derives:

- `corvis-api-origin-${environment}` global IPv4;
- `corvis-api-${environment}` Cloud Run service URL;
- the deterministic API hostname from `CLOUDFLARE_ZONE_NAME` and environment.

The Postgres DSN remains a runtime secret in GCP Secret Manager. Its secret name is deterministic: `corvis-${environment}-postgres-dsn`.

## GCP origin requirement

Cloudflare is not an origin security boundary unless bypassing it is blocked. Public API traffic therefore follows Cloudflare → GCP external Application Load Balancer → serverless NEG → Cloud Run. Two independent negative controls are required:

1. a correct-SNI request sent directly to the managed load-balancer IPv4 must be denied by Cloud Armor with 403;
2. a request sent directly to the default Cloud Run URL must be denied by Cloud Run ingress controls (403/404).

The load-balancer probe deliberately uses the normal API hostname for TLS/SNI while overriding DNS to the origin address. This proves origin-bypass denial rather than merely succeeding because an IP-address TLS certificate does not match.

Cloudflare-to-origin mTLS remains a separate launch gate until the approved certificate/trust bootstrap is configured and exercised in UAT. Do not treat the Cloud Armor allowlist as completion of that distinct control.

## Executable UAT evidence

Run **Security acceptance** from GitHub Actions against `uat` after the API edge/origin and Supabase/Postgres data plane are deployed. The workflow runs independent edge/origin and Postgres-RLS jobs.

### Edge/origin job

`.github/scripts/security-acceptance.mjs` fails unless the activated API boundary proves:

1. HTTPS traffic traverses Cloudflare;
2. HSTS and `nosniff` are present;
3. API responses are `no-store` and are not observed as shared-cache hits;
4. HTTP redirects to HTTPS;
5. cross-site state-changing API traffic is rejected;
6. the deterministic custom-WAF probe is blocked;
7. the deterministic rate-limit probe crosses its threshold and is blocked;
8. the direct load-balancer request is rejected by Cloud Armor with 403;
9. the direct Cloud Run request is rejected by the ingress boundary.

Customer/admin edge checks are recorded as skipped until those distinct runtimes are activated; their absence is not evidence that those surfaces are production-ready.

### Postgres RLS job

`db/postgres/security_acceptance.sql` connects using the runtime DSN retrieved from GCP Secret Manager and performs a transaction-scoped two-tenant test against the live database. It proves tenant-isolated reads and denied authenticated control mutations using actual RLS, then rolls back synthetic data and temporary grants.

## Evidence handling

The workflow uploads separate sanitized JSON artifacts for edge/origin and Postgres RLS acceptance. Evidence records only check identifiers, environment, timestamps and pass/fail/skip state. It does not contain provider tokens, database connection strings, application credentials, request authorization, customer data or source documents.

A passing source-code CI run is not provider evidence. For a material security release, retain the successful UAT acceptance artifacts together with the release SHA/deployment evidence and reference them from the enterprise control-evidence process (#14).

Issue #8 remains active until production-like UAT proves the applicable Cloudflare/origin checks, mTLS launch gate and live Postgres RLS isolation against deployed provider resources.
