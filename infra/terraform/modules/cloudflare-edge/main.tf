terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

locals {
  dynamic_host_expression = "(http.host eq \"${var.api_hostname}\")"
  worker_name             = "corvis-api-${replace(var.api_hostname, ".", "-")}"
}

resource "cloudflare_worker" "api_proxy" {
  account_id = var.account_id
  name       = local.worker_name

  observability = {
    enabled            = true
    head_sampling_rate = 1
  }

  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  tags = ["corvis", "api-edge"]
}

resource "cloudflare_worker_version" "api_proxy" {
  account_id         = var.account_id
  worker_id          = cloudflare_worker.api_proxy.id
  compatibility_date = "2026-09-20"
  main_module        = "api-proxy.mjs"

  modules = [{
    name         = "api-proxy.mjs"
    content_type = "application/javascript+module"
    content_file = "${path.module}/api-proxy.mjs"
  }]

  bindings = [
    {
      type = "plain_text"
      name = "PUBLIC_HOSTNAME"
      text = var.api_hostname
    },
    {
      type = "plain_text"
      name = "GATEWAY_HOST"
      text = var.gateway_hostname
    },
    {
      type = "secret_text"
      name = "GATEWAY_API_KEY"
      text = var.gateway_api_key
    },
  ]
}

resource "cloudflare_workers_deployment" "api_proxy" {
  account_id  = var.account_id
  script_name = cloudflare_worker.api_proxy.name
  strategy    = "percentage"

  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.api_proxy.id
  }]

  annotations = {
    workers_message = "Corvis API Gateway edge proxy"
  }
}

resource "cloudflare_workers_route" "api" {
  zone_id = var.zone_id
  pattern = "${var.api_hostname}/*"
  script  = cloudflare_worker.api_proxy.name

  depends_on = [cloudflare_workers_deployment.api_proxy]
}

resource "cloudflare_dns_record" "api" {
  zone_id = var.zone_id
  name    = var.api_hostname
  content = var.gateway_hostname
  type    = "CNAME"
  ttl     = 1
  proxied = true
  comment = "Corvis public API edge; Worker proxies to Google API Gateway"

  depends_on = [cloudflare_workers_route.api]
}

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

resource "cloudflare_ruleset" "custom_waf" {
  zone_id     = var.zone_id
  name        = "Corvis custom edge security"
  description = "Baseline WAF rules available independently of paid managed-WAF features."
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
  name        = "Corvis API cache isolation"
  description = "Never shared-cache authenticated Corvis API traffic."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [
    {
      ref         = "bypass_dynamic_corvis_api"
      description = "Bypass Cloudflare cache for all Corvis API traffic"
      expression  = local.dynamic_host_expression
      action      = "set_cache_settings"
      action_parameters = {
        cache = false
      }
    },
  ]
}
