terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

locals {
  worker_name = "corvis-api-${replace(var.api_hostname, ".", "-")}"
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
  script  = local.worker_name

  depends_on = [cloudflare_workers_deployment.api_proxy]
}

resource "cloudflare_dns_record" "api" {
  zone_id = var.zone_id
  name    = var.api_hostname
  content = var.gateway_hostname
  type    = "CNAME"
  ttl     = 1
  proxied = true
  comment = "Corvis environment API edge; shared zone policy is owned by the dedicated cloudflare shared root"

  depends_on = [cloudflare_workers_route.api]
}
