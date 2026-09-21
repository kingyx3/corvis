terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

locals {
  worker_name = "corvis-customer-${replace(var.customer_hostname, ".", "-")}"
}

resource "cloudflare_worker" "customer_proxy" {
  account_id = var.account_id
  name       = local.worker_name
  observability = { enabled = true, head_sampling_rate = 1 }
  subdomain = { enabled = false, previews_enabled = false }
  tags = ["corvis", "customer-edge"]
}

resource "cloudflare_worker_version" "customer_proxy" {
  account_id         = var.account_id
  worker_id          = cloudflare_worker.customer_proxy.id
  compatibility_date = "2026-09-21"
  main_module        = "customer-proxy.mjs"

  modules = [{
    name         = "customer-proxy.mjs"
    content_type = "application/javascript+module"
    content_file = "${path.module}/customer-proxy.mjs"
  }]

  bindings = [
    { type = "plain_text", name = "PUBLIC_HOSTNAME", text = var.customer_hostname },
    { type = "plain_text", name = "CUSTOMER_GATEWAY_HOST", text = var.customer_gateway_hostname },
    { type = "secret_text", name = "CUSTOMER_GATEWAY_API_KEY", text = var.customer_gateway_api_key },
    { type = "plain_text", name = "API_GATEWAY_HOST", text = var.api_gateway_hostname },
    { type = "secret_text", name = "API_GATEWAY_API_KEY", text = var.api_gateway_api_key },
  ]
}

resource "cloudflare_workers_deployment" "customer_proxy" {
  account_id  = var.account_id
  script_name = cloudflare_worker.customer_proxy.name
  strategy    = "percentage"
  versions = [{ percentage = 100, version_id = cloudflare_worker_version.customer_proxy.id }]
  annotations = { workers_message = "Corvis customer web split-origin proxy" }
}

resource "cloudflare_workers_route" "customer" {
  zone_id = var.zone_id
  pattern = "${var.customer_hostname}/*"
  script  = cloudflare_worker.customer_proxy.name
  depends_on = [cloudflare_workers_deployment.customer_proxy]
}

resource "cloudflare_dns_record" "customer" {
  zone_id = var.zone_id
  name    = var.customer_hostname
  content = var.customer_gateway_hostname
  type    = "CNAME"
  ttl     = 1
  proxied = true
  comment = "Corvis customer UI edge; Worker splits UI and API gateway traffic"
  depends_on = [cloudflare_workers_route.customer]
}
