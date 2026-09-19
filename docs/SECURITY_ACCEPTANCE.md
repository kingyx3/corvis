# Security acceptance and edge/origin verification

This document owns the executable technical security-acceptance contract for the Corvis public edge. Business/security-control requirements and readiness decisions remain in Confluence.

## Edge policy as code

`infra/terraform/modules/cloudflare-edge` manages the baseline public-edge controls for production-like environments:

- proxied customer/admin/API DNS records pointing at the GCP external HTTPS load balancer;
- Full (strict) origin TLS, TLS 1.3 and HTTP-to-HTTPS redirect settings;
- zone-level custom WAF rules that block non-standard ports and unsafe TRACE/CONNECT methods;
- per-IP API rate limiting;
- deterministic WAF/rate-limit probe rules used only to prove enforcement in UAT;
- cache bypass for dynamic customer/admin/API traffic;
- caching only for immutable `/_next/static/` assets;
- optional Cloudflare Managed + OWASP managed rulesets when the selected Cloudflare plan supports them.

Cloudflare DDoS managed protection is provider-managed and remains enabled independently of these custom rules.

`uat` and `prod` instantiate the module only when the complete edge tuple is available. Supplying only some edge inputs fails Terraform planning rather than applying a partially secured edge.

## Deployment inputs

The normal GitHub Environment inputs remain documented in `GITHUB_ENVIRONMENTS.md`. The edge path additionally consumes these derived/operational values:

| Name | Purpose | Ownership |
| --- | --- | --- |
| `GCP_ORIGIN_IPV4_ADDRESS` | External HTTPS load-balancer address used by proxied Cloudflare A records | Derived from the GCP load-balancer deployment; do not hand-copy if deployment output can publish it |
| `CLOUDFLARE_MANAGED_WAF_ENABLED` | `true` only when the zone plan supports the Cloudflare/OWASP managed rulesets | Environment rollout control; baseline custom WAF still applies when false |
| `GCP_DIRECT_ORIGIN_PROBE_URLS` | Semicolon-separated exact direct-origin URLs used only by the security acceptance probe | Derived from public Cloud Run/LB deployment outputs; never contains credentials |

`CLOUDFLARE_API_TOKEN` remains an environment-scoped deployment secret. It is read by the Cloudflare Terraform provider and must never be copied into runtime services.

## GCP origin requirement

Cloudflare is not an origin security boundary unless bypassing it is blocked. Public Cloud Run services must therefore be deployed behind the GCP external Application Load Balancer with Cloud Run ingress restricted to **internal and Cloud Load Balancers**. Direct internet traffic to a `run.app` endpoint must not reach the application.

When the public customer/admin/API Cloud Run resources are added under issue #13, their Terraform definitions must set the equivalent of:

- `ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"`; and
- disable the default `run.app` URL where compatible with the service's invocation model.

Do not disable a default URL for a worker/service that is intentionally invoked through a Google product that requires that URL. The direct-origin negative test remains mandatory for every public customer/admin/API origin.

## Executable UAT evidence

Run **Security acceptance** from GitHub Actions against `uat` after the Cloudflare/GCP public path is deployed. The workflow executes `.github/scripts/security-acceptance.mjs` and uploads `security-acceptance-evidence.json` as a sanitized artifact.

The run fails unless it proves:

1. customer/admin/API HTTPS traffic traverses Cloudflare;
2. HSTS and `nosniff` are present on public application responses;
3. API responses are `no-store` and are not observed as shared-cache hits;
4. plain HTTP redirects to HTTPS;
5. cross-site state-changing API traffic is rejected;
6. the deterministic custom-WAF probe is blocked;
7. the deterministic rate-limit probe crosses its threshold and is blocked;
8. every configured direct-origin probe is unreachable or returns an origin-denial status.

TLS certificate validation is performed by the Node HTTPS client itself; an invalid/untrusted certificate fails the run before a response is accepted.

The evidence file intentionally records only check names, statuses, non-secret response metadata and timestamps. It does not contain provider tokens, application credentials, request authorization, customer data or source documents.

## Release/control evidence

A passing source-code CI run is not provider evidence. For a material edge/security release, retain the successful UAT security-acceptance artifact together with the release SHA/deployment evidence and reference it from the enterprise control-evidence process (#14).

Do not mark issue #8 complete until the production-like UAT run proves the Cloudflare controls and direct-origin blocking against live provider resources.
