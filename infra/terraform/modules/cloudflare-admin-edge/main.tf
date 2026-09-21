terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

locals {
  worker_name = "corvis-admin-${replace(var.admin_hostname, ".", "-")}"
}

resource "cloudflare_worker" "admin_proxy" {
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

  tags = ["corvis", "admin-edge"]
}

resource "cloudflare_worker_version" "admin_proxy" {
  account_id         = var.account_id
  worker_id          = cloudflare_worker.admin_proxy.id
  compatibility_date = "2026-09-21"
  main_module        = "admin-proxy.mjs"

  modules = [{
    name         = "admin-proxy.mjs"
    content_type = "application/javascript+module"
    content_file = "${path.module}/admin-proxy.mjs"
  }]

  bindings = [
    {
      type = "plain_text"
      name = "PUBLIC_HOSTNAME"
      text = var.admin_hostname
    },
    {
      type = "plain_text"
      name = "ADMIN_GATEWAY_HOST"
      text = var.admin_gateway_hostname
    },
    {
      type = "secret_text"
      name = "ADMIN_GATEWAY_API_KEY"
      text = var.admin_gateway_api_key
    },
    {
      type = "plain_text"
      name = "API_GATEWAY_HOST"
      text = var.api_gateway_hostname
    },
    {
      type = "secret_text"
      name = "API_GATEWAY_API_KEY"
      text = var.api_gateway_api_key
    },
  ]
}

resource "cloudflare_workers_deployment" "admin_proxy" {
  account_id  = var.account_id
  script_name = cloudflare_worker.admin_proxy.name
  strategy    = "percentage"

  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.admin_proxy.id
  }]

  annotations = {
    workers_message = "Corvis admin split-origin proxy with privileged route allowlist"
  }
}

resource "cloudflare_workers_route" "admin" {
  zone_id = var.zone_id
  pattern = "${var.admin_hostname}/*"
  script  = cloudflare_worker.admin_proxy.name

  depends_on = [cloudflare_workers_deployment.admin_proxy]
}

resource "cloudflare_dns_record" "admin" {
  zone_id = var.zone_id
  name    = var.admin_hostname
  content = var.admin_gateway_hostname
  type    = "CNAME"
  ttl     = 1
  proxied = true
  comment = "Corvis admin UI edge with explicit privileged API routing"

  depends_on = [cloudflare_workers_route.admin]
}
