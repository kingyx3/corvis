terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

locals {
  prod_api_hostname      = "api.${var.zone_name}"
  prod_customer_hostname = "app.${var.zone_name}"
  prod_admin_hostname    = "admin.${var.zone_name}"
  uat_api_hostname       = "api-uat.${var.zone_name}"
  uat_customer_hostname  = "app-uat.${var.zone_name}"
  uat_admin_hostname     = "admin-uat.${var.zone_name}"

  corvis_hostnames = [
    local.prod_api_hostname,
    local.prod_customer_hostname,
    local.prod_admin_hostname,
    local.uat_api_hostname,
    local.uat_customer_hostname,
    local.uat_admin_hostname,
  ]

  quoted_corvis_hostnames     = join(" ", [for hostname in local.corvis_hostnames : "\"${hostname}\""])
  corvis_host_expression      = "(http.host in {${local.quoted_corvis_hostnames}})"
  api_requests_per_10_seconds = max(1, ceil(var.api_requests_per_minute / 6))
}

# These are intentionally the only zone-wide settings owned by Terraform. Keeping
# them in a state independent from UAT/prod runtime state prevents either environment
# lifecycle from deleting or racing production-wide edge policy.
resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.zone_id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "tls_1_3" {
  zone_id    = var.zone_id
  setting_id = "tls_1_3"
  value      = "on"
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "automatic_https_rewrites" {
  zone_id    = var.zone_id
  setting_id = "automatic_https_rewrites"
  value      = "on"
}

# Scope application-specific WAF behavior to the six derived Corvis hostnames so a
# future apex/marketing site in the same zone is not accidentally coupled to product
# rules. The zone-wide TLS posture above intentionally remains strict everywhere.
resource "cloudflare_ruleset" "custom_waf" {
  zone_id     = var.zone_id
  name        = "Corvis shared application WAF"
  description = "Shared WAF baseline for prod and UAT Corvis application hostnames."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "block_corvis_non_standard_ports"
      description = "Block non-standard public HTTP(S) ports on Corvis application hostnames"
      expression  = "(${local.corvis_host_expression} and not cf.edge.server_port in {80 443})"
      action      = "block"
    },
    {
      ref         = "block_corvis_unsafe_methods"
      description = "Block TRACE and CONNECT on Corvis application hostnames"
      expression  = "(${local.corvis_host_expression} and http.request.method in {\"TRACE\" \"CONNECT\"})"
      action      = "block"
    },
    {
      ref         = "security_acceptance_waf_probe"
      description = "Deterministic Corvis-host-only path probe proving custom-WAF execution"
      expression  = "(${local.corvis_host_expression} and http.request.uri.path eq \"/__corvis/security/waf-block\")"
      action      = "block"
    },
  ]
}

resource "cloudflare_ruleset" "managed_waf" {
  count = var.enable_managed_waf ? 1 : 0

  zone_id     = var.zone_id
  name        = "Corvis shared managed WAF"
  description = "Cloudflare and OWASP managed rules scoped to Corvis application hostnames."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [
    {
      ref         = "execute_cloudflare_managed_ruleset"
      description = "Execute Cloudflare Managed Ruleset on Corvis application hostnames"
      expression  = local.corvis_host_expression
      action      = "execute"
      action_parameters = {
        id = "efb7b8c949ac4650a09736fc376e9aee"
      }
    },
    {
      ref         = "execute_cloudflare_owasp_core_ruleset"
      description = "Execute Cloudflare OWASP Core Ruleset on Corvis application hostnames"
      expression  = local.corvis_host_expression
      action      = "execute"
      action_parameters = {
        id = "4814384a9e5d4991b9815dcfc25d2f1f"
      }
    },
  ]
}

# Cloudflare Free exposes one rate-limit rule and does not allow Host in the match
# expression, so the Free branch is intentionally path-only. Corvis still enforces
# a Postgres-backed per-identity limit inside each environment, so the shared edge
# counter is defense-in-depth rather than the tenant/environment authorization limit.
# Pro exposes two rules plus Host matching, allowing independent prod/UAT edge counters.
resource "cloudflare_ruleset" "rate_limits" {
  zone_id     = var.zone_id
  name        = "Corvis shared API rate limits"
  description = var.enable_managed_waf ? "Separate hostname-scoped prod/UAT rate limits for Pro+." : "Free-compatible shared path/IP API rate limit; authoritative application limits remain environment-isolated."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = var.enable_managed_waf ? [
    {
      ref         = "rate_limit_prod_api_by_ip"
      description = "Bound production API requests per source IP"
      expression  = "(http.host eq \"${local.prod_api_hostname}\" and starts_with(http.request.uri.path, \"/api/\"))"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 10
        requests_per_period = local.api_requests_per_10_seconds
        mitigation_timeout  = 10
      }
    },
    {
      ref         = "rate_limit_uat_api_by_ip"
      description = "Bound UAT API requests per source IP independently from production"
      expression  = "(http.host eq \"${local.uat_api_hostname}\" and starts_with(http.request.uri.path, \"/api/\"))"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 10
        requests_per_period = local.api_requests_per_10_seconds
        mitigation_timeout  = 10
      }
    },
  ] : [
    {
      ref         = "rate_limit_corvis_api_by_ip_free"
      description = "Free-plan defense-in-depth API path rate limit across the shared zone"
      expression  = "(starts_with(http.request.uri.path, \"/api/\"))"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 10
        requests_per_period = local.api_requests_per_10_seconds
        mitigation_timeout  = 10
      }
    },
  ]
}

# Authenticated customer/admin/API surfaces are never shared-cacheable. The hostname
# scope prevents this rule from changing caching for an unrelated apex/marketing site.
resource "cloudflare_ruleset" "cache" {
  zone_id     = var.zone_id
  name        = "Corvis shared authenticated cache isolation"
  description = "Never shared-cache prod or UAT Corvis application traffic."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [
    {
      ref         = "bypass_corvis_application_cache"
      description = "Bypass Cloudflare cache for all Corvis application hostnames"
      expression  = local.corvis_host_expression
      action      = "set_cache_settings"
      action_parameters = {
        cache = false
      }
    },
  ]
}
