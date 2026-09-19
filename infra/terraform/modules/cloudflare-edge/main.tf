terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

locals {
  public_hostnames = toset(compact([
    trimspace(var.customer_hostname),
    trimspace(var.admin_hostname),
    trimspace(var.api_hostname),
  ]))

  static_hostnames = compact([
    trimspace(var.customer_hostname),
    trimspace(var.admin_hostname),
  ])

  quoted_public_hostnames = join(" ", [for hostname in local.public_hostnames : "\"${hostname}\""])
  quoted_static_hostnames = join(" ", [for hostname in local.static_hostnames : "\"${hostname}\""])

  dynamic_host_expression = join(" ", [
    "(http.host in {${local.quoted_public_hostnames}}",
    "and not starts_with(http.request.uri.path, \"/_next/static/\"))",
  ])

  static_host_expression = length(local.static_hostnames) > 0 ? "(http.host in {${local.quoted_static_hostnames}} and starts_with(http.request.uri.path, \"/_next/static/\"))" : "(http.host eq \"__corvis_static_surface_disabled__\")"
}

resource "cloudflare_dns_record" "public" {
  for_each = local.public_hostnames

  zone_id = var.zone_id
  name    = each.value
  content = var.origin_ipv4_address
  type    = "A"
  ttl     = 1
  proxied = true
  comment = "Corvis public edge; origin is the GCP external HTTPS load balancer"
}

resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.zone_id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "authenticated_origin_pulls" {
  zone_id    = var.zone_id
  setting_id = "tls_client_auth"
  value      = "on"
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

resource "cloudflare_ruleset" "custom_waf" {
  zone_id     = var.zone_id
  name        = "Corvis custom edge security"
  description = "Baseline WAF rules that are available independently of paid managed-WAF features."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "block_non_standard_ports"
      description = "Block non-standard public HTTP(S) ports"
      expression  = "(not cf.edge.server_port in {80 443})"
      action      = "block"
    },
    {
      ref         = "block_unsafe_methods"
      description = "Block TRACE and CONNECT at the public edge"
      expression  = "(http.request.method in {\"TRACE\" \"CONNECT\"})"
      action      = "block"
    },
    {
      ref         = "security_acceptance_waf_probe"
      description = "Deterministic UAT probe proving Cloudflare WAF execution"
      expression  = "(http.host eq \"${var.api_hostname}\" and http.request.headers[\"x-corvis-security-probe\"][0] eq \"waf-block\")"
      action      = "block"
    },
  ]
}

resource "cloudflare_ruleset" "managed_waf" {
  count = var.enable_managed_waf ? 1 : 0

  zone_id     = var.zone_id
  name        = "Corvis managed WAF"
  description = "Cloudflare and OWASP managed rulesets; enable only on a zone plan that supports them."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [
    {
      ref         = "execute_cloudflare_managed_ruleset"
      description = "Execute Cloudflare Managed Ruleset"
      expression  = "true"
      action      = "execute"
      action_parameters = {
        id = "efb7b8c949ac4650a09736fc376e9aee"
      }
    },
    {
      ref         = "execute_cloudflare_owasp_core_ruleset"
      description = "Execute Cloudflare OWASP Core Ruleset"
      expression  = "true"
      action      = "execute"
      action_parameters = {
        id = "4814384a9e5d4991b9815dcfc25d2f1f"
      }
    },
  ]
}

resource "cloudflare_ruleset" "rate_limits" {
  zone_id     = var.zone_id
  name        = "Corvis API rate limits"
  description = "Bound abusive API request rates and provide a deterministic UAT rate-limit probe."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      ref         = "security_acceptance_rate_probe"
      description = "Deterministic UAT probe proving Cloudflare rate-limit enforcement"
      expression  = "(http.host eq \"${var.api_hostname}\" and starts_with(http.request.uri.path, \"/api/\") and http.request.headers[\"x-corvis-security-probe\"][0] eq \"rate-limit\")"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 60
        requests_per_period = 5
        mitigation_timeout  = 60
      }
    },
    {
      ref         = "rate_limit_api_by_ip"
      description = "Bound public API requests per source IP"
      expression  = "(http.host eq \"${var.api_hostname}\" and starts_with(http.request.uri.path, \"/api/\"))"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 60
        requests_per_period = var.api_requests_per_minute
        mitigation_timeout  = 60
      }
    },
  ]
}

resource "cloudflare_ruleset" "cache" {
  zone_id     = var.zone_id
  name        = "Corvis cache isolation"
  description = "Never shared-cache authenticated/dynamic Corvis surfaces; cache only immutable Next.js static assets."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = concat(
    [
      {
        ref         = "bypass_dynamic_corvis_surfaces"
        description = "Bypass Cloudflare cache for customer, admin and API dynamic traffic"
        expression  = local.dynamic_host_expression
        action      = "set_cache_settings"
        action_parameters = {
          cache = false
        }
      },
    ],
    length(local.static_hostnames) > 0 ? [
      {
        ref         = "cache_immutable_next_static"
        description = "Cache immutable Next.js static assets only"
        expression  = local.static_host_expression
        action      = "set_cache_settings"
        action_parameters = {
          cache = true
        }
      },
    ] : [],
  )
}
