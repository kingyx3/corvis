# Cloudflare shared-zone operating model

Corvis uses **one externally owned root domain and one Cloudflare zone** for production and UAT. The domain itself remains configurable through `CLOUDFLARE_ZONE_NAME`; no TLD or brand domain is hardcoded.

## Hostname contract

Production uses first-level hostnames:

- `api.${CLOUDFLARE_ZONE_NAME}`
- `app.${CLOUDFLARE_ZONE_NAME}`
- `admin.${CLOUDFLARE_ZONE_NAME}`

UAT uses separate first-level hostnames:

- `api-uat.${CLOUDFLARE_ZONE_NAME}`
- `app-uat.${CLOUDFLARE_ZONE_NAME}`
- `admin-uat.${CLOUDFLARE_ZONE_NAME}`

Do not change UAT to nested names such as `api.uat.${zone}`. On a normal full Cloudflare zone, Universal SSL covers the apex and first-level subdomains; deeper names require a different certificate capability. Keeping UAT at one label also makes hostname ownership and security acceptance unambiguous.

## Terraform ownership

Cloudflare resources are deliberately split by lifecycle and blast radius.

| Owner | State | Owns | Must not own |
| --- | --- | --- | --- |
| Shared Cloudflare root | `infra/terraform/shared/cloudflare` in `${UAT_GCP_PROJECT_ID}-corvis-shared-tf-state`, prefix `corvis/cloudflare-zone-policy` | zone TLS settings; custom WAF; optional managed WAF; the single zone rate-limit entry ruleset; authenticated-surface cache bypass | environment DNS records, Worker scripts/deployments/routes, GCP origins |
| UAT root | normal UAT state | `api-uat` / `app-uat` / `admin-uat` DNS, Workers and routes | zone settings/rulesets; production hostnames |
| Prod root | normal prod state | `api` / `app` / `admin` DNS, Workers and routes | zone settings/rulesets; UAT hostnames |

Cloudflare supports at most one zone entry-point ruleset per phase. The shared root is therefore the **only** Terraform state allowed to own `cloudflare_ruleset` or `cloudflare_zone_setting` resources. Contract tests fail if those resources are reintroduced into an environment edge module.

The shared state bucket is separate from `${UAT_GCP_PROJECT_ID}-corvis-tf-state`. `gcp-decommission.yml` deletes only the environment state bucket, so UAT idle/full lifecycle cannot delete the shared Cloudflare policy state. The GCP UAT project and WIF trust remain the state-control anchor until an explicit reviewed state migration changes that ownership.

## Apply order

After the domain has been selected and activated in Cloudflare:

1. Set one repository-level `CLOUDFLARE_ZONE_NAME` so UAT and prod cannot drift to different root zones.
2. Put `CLOUDFLARE_ZONE_POLICY_TOKEN` in the protected `uat` GitHub Environment.
3. Run **Cloudflare shared zone policy** with `plan`, review it, then `apply` from `main`.
4. Configure the environment-specific `CLOUDFLARE_API_TOKEN` in UAT and/or prod.
5. Deploy UAT or prod through the normal immutable-release Terraform path.
6. Run Security acceptance against the deployed environment.

The shared-zone workflow is independent of the GCP foundation bootstrap. A domain is still **not required** to bootstrap the UAT GCP foundation.

## Token separation and least privilege

Use separate Cloudflare credentials for shared zone policy and environment edge deployment.

### Shared zone policy token

`CLOUDFLARE_ZONE_POLICY_TOKEN` is used only by `.github/workflows/cloudflare-zone-policy.yml`. Restrict it to the selected Corvis zone and grant only the permissions required for the shared resources, principally:

- Zone Read;
- Zone Settings Write/Edit;
- Zone WAF Write/Edit (Rulesets API for custom/managed WAF, rate limiting and cache policy as required by Cloudflare's current permission model).

Do **not** give this token DNS or Workers script deployment authority unless a provider API requirement proves it necessary. Prefer a token TTL/rotation policy and Cloudflare account-level service token/role support where available.

### Environment edge token

`CLOUDFLARE_API_TOKEN` remains environment-scoped. It should have only the permissions needed to look up the zone and manage that environment's DNS record, Worker, deployment and route. At minimum this normally means zone read/DNS write/Workers Routes write plus the narrowest Workers role that supports creating or updating the environment Worker.

Cloudflare now supports per-Worker roles. Once the six Corvis Workers exist, narrow human/operator and CI access to the individual UAT or production Workers wherever the provider/API-token model permits it. Initial Worker creation can require broader Workers product authority; retain it only as long as creation/recovery actually requires it.

Cloudflare DNS token scope is zone-level rather than record-name-level, so provider permissions alone cannot prevent a UAT token from editing a production record in the same zone. Corvis mitigates that remaining provider limitation through deterministic hostname derivation, separate Terraform states, reviewed `main`-only applies, non-bypassable CI, and tests that prevent environment roots from owning the other environment's hostnames.

## TLS and certificate posture

The shared root enforces:

- Full/strict origin TLS;
- TLS 1.3 enabled;
- Always Use HTTPS;
- Automatic HTTPS rewrites.

These are intentionally zone-wide security settings. Any future apex/marketing service in the same zone must therefore support valid origin TLS. If a future third-party site cannot support the shared strict-TLS posture, do not weaken the whole Corvis zone merely to accommodate it; move that service to a suitable separate hostname/provider arrangement or document and review an alternative architecture.

Universal SSL is sufficient for the six first-level Corvis hostnames on a normal full Cloudflare setup. Total TLS/Advanced Certificates are not baseline requirements unless deeper hostnames or another certificate capability becomes necessary.

## WAF, cache and marketing-site isolation

Application-specific shared rules are scoped to the six Corvis application hostnames. This prevents a future apex/marketing site from inheriting product-specific custom/managed WAF behavior or authenticated-application cache bypass.

The deterministic WAF acceptance path is also host-scoped. An identically named path on an unrelated hostname in the same zone must not be blocked merely because Corvis uses it for security acceptance.

All six application hostnames bypass Cloudflare shared caching. This is intentionally conservative for authenticated customer/admin/API surfaces and prevents accidental cross-user or cross-environment cache leakage. Static caching can be introduced later only with an explicit immutable/static asset contract and tests proving no authenticated or tenant-varying response can enter shared cache.

## Rate-limit isolation

Corvis does not rely on Cloudflare rate limiting as the authoritative application quota. The API already enforces a Postgres-backed per-identity/per-environment limit, so Cloudflare is defense in depth.

Cloudflare plan capabilities differ:

- **Free:** one rate-limit rule and no Host field in the rate-limit match expression. The shared root therefore uses one `/api/` path + source-IP rule. A source IP exercising both environments can share that edge counter, which can cause conservative over-blocking but cannot bypass Corvis's environment-specific application limit.
- **Pro with `CLOUDFLARE_MANAGED_WAF_ENABLED=true`:** Cloudflare provides two rate-limit rules and Host matching. The shared ruleset creates one production API rule and one UAT API rule, giving the two environments independent edge counters while keeping the application limiter authoritative.

If strict edge-counter separation becomes a contractual requirement, use at least the Cloudflare capability that provides two host-scoped rules. Do not solve it by giving UAT a second ad-hoc root domain unless a broader isolation requirement justifies a separate zone.

## Browser, CORS and session isolation

Browser trust is exact-host, not root-domain wildcard:

- UAT API upload origin: only `https://app-uat.${zone}`;
- UAT browser origins: only `https://app-uat.${zone}` and `https://admin-uat.${zone}`;
- production equivalents use only production `app` and `admin` hostnames.

Never configure `*.${zone}` or the bare root domain as an application CORS allowlist shortcut.

If browser sessions later use cookies, use host-only cookies by default: omit the `Domain` attribute so a UAT cookie cannot be sent to production or vice versa. Keep `Secure`, `HttpOnly` where JavaScript access is unnecessary, an appropriate `SameSite` policy, environment-specific cookie names where ambiguity is possible, and narrowly scoped `Path` values. A parent-domain cookie such as `Domain=.${zone}` requires an explicit security review and should not be baseline.

OIDC redirect/callback URLs must likewise be registered as exact environment hostnames. Never register a wildcard callback spanning UAT and production.

## Operational blast-radius controls

- Shared-zone applies run in a dedicated concurrency group and only apply from `main`.
- Apply verifies effective GitHub release governance before mutating Cloudflare.
- Shared state is versioned/private/public-access-prevention protected through the standard Terraform-state hardening script.
- Environment deploys cannot mutate zone rulesets/settings after this split.
- Environment decommission removes only environment DNS/Workers/runtime resources; shared zone policy survives.
- UAT uses synthetic or explicitly sanitized data even though its hostname is in the production root zone.
- Security acceptance remains mandatory after environment deployment; provider configuration alone is not evidence that isolation works.

## Future separation trigger

One root zone remains the baseline until a concrete requirement justifies another zone. Re-evaluate if a customer/regulator requires independent DNS administrative domains, independent Cloudflare accounts, materially different TLS/security policy, a provider limitation prevents least-privilege operation, or a demonstrated incident shows that shared-zone blast radius is unacceptable.
