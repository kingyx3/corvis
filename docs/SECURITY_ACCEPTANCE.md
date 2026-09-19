# Security acceptance: edge, origin and tenant isolation

This document owns the executable technical security-acceptance contract for the Corvis public edge and Postgres tenant-isolation boundary. Business/security-control requirements and readiness decisions remain in Confluence.

## Edge and origin policy as code

`infra/terraform/modules/cloudflare-edge` manages public-edge controls for production-like environments. `infra/terraform/modules/gcp-serverless-origin` owns the API origin bridge and enforces independent origin controls:

- Cloudflare proxied DNS, Full (strict) TLS, Authenticated Origin Pulls, custom WAF, API rate limiting and dynamic-cache bypass;
- GCP external managed HTTPS load balancer with a Cloud Run serverless NEG;
- Cloud Run ingress restricted to internal and Cloud Load Balancing;
- Cloud Armor attached to the API backend with current Cloudflare proxy ranges derived from the Cloudflare provider;
- a default-deny Cloud Armor rule for direct load-balancer traffic that does not come from Cloudflare;
- load-balancer request logging enabled for origin-security evidence;
- Google-managed origin certificate lifecycle through Certificate Manager DNS authorization;
- a Certificate Manager TrustConfig containing Cloudflare's published Authenticated Origin Pull client CA;
- a global Network Security ServerTlsPolicy attached to the HTTPS proxy with `REJECT_INVALID`, so missing or invalid client certificates fail during TLS before any HTTP request reaches the backend.

Cloudflare remains separate from application authentication and tenant authorization. Passing the edge or mTLS boundary does not grant an application identity, workspace membership, entitlement or data right.

## Authenticated Origin Pull trust model

Corvis initially uses Cloudflare **global Authenticated Origin Pulls**. Cloudflare presents its published Origin Pull client certificate for proxied HTTPS requests, and the GCP frontend validates that certificate against the version-controlled public CA trust anchor in `infra/terraform/modules/gcp-serverless-origin/cloudflare-authenticated-origin-pull-ca.pem`.

That public CA material is not a runtime secret or private key. It must nevertheless be treated as a versioned external trust dependency: monitor the upstream certificate lifecycle and replace the pinned trust anchor through a reviewed Terraform change before expiry or provider rotation. Never commit a Cloudflare client private key.

Global AOP proves that a connection originated from the Cloudflare network, not from a Corvis-exclusive Cloudflare client certificate. Cloud Armor's provider-derived Cloudflare source allowlist remains an independent control. If Confluence later requires account-exclusive client identity, migrate deliberately to Cloudflare zone-level or per-hostname AOP with an approved private-PKI bootstrap rather than silently changing this trust model.

## Deployment inputs

The normal GitHub Environment inputs remain documented in `GITHUB_ENVIRONMENTS.md`. Direct-origin probe URLs, origin IPs and mTLS private material are not human-managed GitHub inputs. Security acceptance authenticates to GCP through GitHub OIDC/WIF and derives:

- `corvis-api-origin-${environment}` global IPv4;
- `corvis-api-${environment}` Cloud Run service URL;
- the deterministic API hostname from `CLOUDFLARE_ZONE_NAME` and environment.

The Postgres DSN remains a runtime secret in GCP Secret Manager. Its secret name is deterministic: `corvis-${environment}-postgres-dsn`.

## GCP origin requirement

Public API traffic follows Cloudflare → client-authenticated TLS → GCP external Application Load Balancer → serverless NEG → Cloud Run. Three independent negative controls are required:

1. a correct-SNI TLS request sent directly to the managed load-balancer IPv4 **without a Cloudflare client certificate** must fail the TLS handshake before an HTTP response is produced;
2. Cloud Armor must remain configured to allow only provider-derived Cloudflare proxy ranges and default-deny other backend sources;
3. a request sent directly to the default Cloud Run URL must be denied by Cloud Run ingress controls (403/404).

The direct load-balancer probe deliberately uses the normal API hostname for TLS/SNI while overriding DNS to the origin address. This proves client-certificate rejection rather than merely succeeding because an IP-address certificate does not match.

Do not weaken Authenticated Origin Pulls, the GCP ServerTlsPolicy, Cloud Armor, Cloud Run ingress, RLS or application authorization to recover availability. A missing/invalid origin-security dependency must fail closed.

## Executable UAT evidence

Run **Security acceptance** from GitHub Actions against `uat` after the API edge/origin and Supabase/Postgres data plane are deployed. The workflow runs independent edge/origin and Postgres-RLS jobs.

### Edge/origin job

`.github/scripts/security-acceptance.mjs` fails unless the activated API boundary proves:

1. HTTPS API traffic successfully traverses Cloudflare, demonstrating that Cloudflare can complete the client-authenticated origin handshake;
2. HSTS and `nosniff` are present;
3. API responses are `no-store` and are not observed as shared-cache hits;
4. HTTP redirects to HTTPS;
5. cross-site state-changing API traffic is rejected;
6. the deterministic custom-WAF probe is blocked;
7. the deterministic rate-limit probe crosses its threshold and is blocked;
8. a direct load-balancer TLS connection without a client certificate is rejected before HTTP (`curl` non-zero with HTTP status `000`);
9. the direct Cloud Run request is rejected by the ingress boundary.

Customer/admin edge checks are recorded as skipped until those distinct runtimes are activated; their absence is not evidence that those surfaces are production-ready.

### Postgres RLS job

`db/postgres/security_acceptance.sql` connects using the runtime DSN retrieved from GCP Secret Manager and performs a transaction-scoped two-tenant test against the live database. It proves tenant-isolated reads and denied authenticated control mutations using actual RLS, then rolls back synthetic data and temporary grants.

## Evidence handling

The workflow uploads separate sanitized JSON artifacts for edge/origin and Postgres RLS acceptance. Evidence records only check identifiers, environment, timestamps and pass/fail/skip state. It does not contain provider tokens, database connection strings, application credentials, request authorization, customer data or source documents.

A passing source-code CI run is not provider evidence. For a material security release, retain the successful UAT acceptance artifacts together with the release SHA/deployment evidence and reference them from the enterprise control-evidence process (#14).

Issue #8 remains active until production-like UAT proves the applicable Cloudflare/origin checks, mTLS launch gate and live Postgres RLS isolation against deployed provider resources.
