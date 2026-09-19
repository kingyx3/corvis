# Security acceptance: edge, origin and tenant isolation

This document owns the executable technical security-acceptance contract for the Corvis public edge and Postgres tenant-isolation boundary. Business/security-control requirements and readiness decisions remain in Confluence.

## Edge policy as code

`infra/terraform/modules/cloudflare-edge` manages the baseline public-edge controls for production-like environments:

- proxied DNS for each currently provisioned public Corvis surface pointing at the Terraform-managed GCP external HTTPS load balancer;
- Full (strict) origin TLS, TLS 1.3 and HTTP-to-HTTPS redirect settings;
- zone-level custom WAF rules that block non-standard ports and unsafe TRACE/CONNECT methods;
- per-IP API rate limiting;
- deterministic WAF/rate-limit probe rules used only to prove enforcement in UAT;
- cache bypass for dynamic Corvis traffic;
- caching only for immutable `/_next/static/` assets when a customer/admin web surface is provisioned;
- optional Cloudflare Managed + OWASP managed rulesets when the selected Cloudflare plan supports them.

Cloudflare DDoS managed protection is provider-managed and remains enabled independently of these custom rules.

The current production-like edge publishes the API hostname only. Customer/admin hostnames remain absent until their independent runtime boundaries are provisioned; they must not be pointed at the API service merely to make DNS appear complete.

The Cloudflare zone ID is resolved by the provider from `CLOUDFLARE_ZONE_NAME`; do not store a duplicate zone ID in GitHub. The API hostname is deterministic: prod uses `api.<zone>` and UAT uses `api.uat.<zone>`.

## Deployment inputs

The normal GitHub Environment inputs remain documented in `GITHUB_ENVIRONMENTS.md`. Security acceptance additionally consumes these operational values:

| Name | Purpose | Ownership |
| --- | --- | --- |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | `true` only when the zone plan supports the Cloudflare/OWASP managed rulesets | Explicit rollout/capability decision; baseline custom WAF still applies when false |
| `GCP_DIRECT_ORIGIN_PROBE_URLS` | Semicolon-separated exact direct-origin URLs used only by the security acceptance probe | Temporary deployment output until those URLs can be derived from managed GCP resources |

The load-balancer IPv4 address is Terraform-owned and wired directly into proxied Cloudflare DNS. It is not a human-managed GitHub input.

The Postgres DSN itself remains a runtime secret in GCP Secret Manager. Its secret name is deterministic: `corvis-${environment}-postgres-dsn`, so GitHub does not carry a separate secret-name variable.

`CLOUDFLARE_API_TOKEN` remains an environment-scoped deployment secret. It is read by the Cloudflare Terraform provider and must never be copied into runtime services.

The Postgres acceptance job authenticates to GCP with the same GitHub OIDC/WIF trust used by deployment, derives the `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` service-account email, reads the runtime DSN from Secret Manager for the duration of the job, masks it immediately and never uploads or logs it.

## GCP origin requirement

Cloudflare is not an origin security boundary unless bypassing it is blocked. The API is therefore deployed behind the GCP global external Application Load Balancer with a serverless NEG targeting Cloud Run, while Cloud Run ingress remains restricted to **internal and Cloud Load Balancers**. Direct internet traffic to the default `run.app` route must not reach the application.

The load-balancer backend is additionally protected by Cloud Armor. Terraform resolves Cloudflare's current IPv4 and IPv6 proxy ranges from the Cloudflare provider at plan/apply time, allows those ranges, and applies a default `403` deny to every other source. Do not replace this with a manually maintained GitHub CIDR list or a broad internet allow rule.

Cloud Run permits unauthenticated invocation at its IAM transport layer because the external Application Load Balancer does not present an end-user Cloud Run identity. That does **not** replace Corvis authentication or authorization: the Cloud Run ingress restriction blocks direct public service ingress, Cloud Armor restricts the load-balancer backend to Cloudflare, and server-side Corvis identity/tenant/RLS/data-right controls still execute independently on every protected application request.

The API origin certificate is managed by Google Certificate Manager with DNS authorization. The authorization record is published unproxied in Cloudflare while the application API record remains proxied.

Do not weaken Cloud Run ingress, Cloud Armor, RLS, authorization or application authentication to restore availability. A missing/invalid edge or origin dependency must fail closed.

Cloudflare-to-origin mTLS remains a separate Confluence launch gate until implemented and evidenced. Cloud Armor source restriction materially reduces bypass exposure but does not satisfy the mTLS gate by itself.

## Executable UAT evidence

Run **Security acceptance** from GitHub Actions against `uat` after the Cloudflare/GCP public path and Supabase/Postgres data plane are deployed. The workflow runs two independent jobs so one failure cannot hide the other.

### Edge/origin job

`.github/scripts/security-acceptance.mjs` fails unless it proves:

1. each configured public HTTPS endpoint traverses Cloudflare;
2. HSTS and `nosniff` are present on public application responses;
3. API responses are `no-store` and are not observed as shared-cache hits;
4. plain HTTP redirects to HTTPS;
5. cross-site state-changing API traffic is rejected;
6. the deterministic custom-WAF probe is blocked;
7. the deterministic rate-limit probe crosses its threshold and is blocked;
8. every configured direct-origin probe is unreachable or returns an origin-denial status.

TLS certificate validation is performed by the Node HTTPS client itself; an invalid/untrusted certificate fails the run before a response is accepted.

### Postgres RLS job

`db/postgres/security_acceptance.sql` connects using the runtime DSN retrieved from GCP Secret Manager and performs a transaction-scoped two-tenant test against the live database. It:

1. creates synthetic tenant A and tenant B identities, workspaces and memberships;
2. creates representative rows in feature flags, control evidence, source documents and export jobs;
3. temporarily grants the Supabase `authenticated` role SQL privileges **inside the transaction only** so the test exercises RLS independently of long-term application grants;
4. sets the Supabase JWT subject for tenant A and proves unfiltered reads expose only tenant A rows;
5. proves an authenticated control-state mutation is denied despite the temporary SQL privilege;
6. repeats the read-isolation checks as tenant B;
7. rolls back the entire transaction, including synthetic data and temporary grants.

The probe therefore validates actual Postgres policy behavior rather than merely matching migration text. It intentionally does not alter persistent customer data, grants or memberships.

## Evidence handling

The workflow uploads separate sanitized JSON artifacts for edge/origin and Postgres RLS acceptance. Evidence records only check identifiers, environment, timestamps and pass/fail state. It does not contain provider tokens, database connection strings, application credentials, request authorization, customer data or source documents.

A passing source-code CI run is not provider evidence. For a material security release, retain the successful UAT acceptance artifacts together with the release SHA/deployment evidence and reference them from the enterprise control-evidence process (#14).

Issue #8 remains active until production-like UAT proves both the Cloudflare/origin checks and live Postgres RLS isolation against deployed provider resources.
