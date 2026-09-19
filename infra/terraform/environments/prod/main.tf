terraform {
  required_version = ">= 1.7.0"

  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = "asia-southeast1"
}

provider "cloudflare" {}

locals {
  edge_requested      = trimspace(var.cloudflare_zone_name) != ""
  api_runtime_enabled = trimspace(var.api_image) != ""
  edge_enabled        = local.edge_requested && local.api_runtime_enabled
  api_hostname        = local.edge_enabled ? "api.${trimspace(var.cloudflare_zone_name)}" : ""
}

resource "terraform_data" "edge_configuration_guard" {
  lifecycle {
    precondition {
      condition     = !local.edge_requested || local.api_runtime_enabled
      error_message = "Cloudflare API edge activation requires an immutable API_IMAGE so the origin cannot point at a missing runtime."
    }
  }
}

data "cloudflare_zones" "corvis" {
  count = local.edge_enabled ? 1 : 0

  name      = trimspace(var.cloudflare_zone_name)
  status    = "active"
  max_items = 2
}

data "cloudflare_ip_ranges" "proxy" {
  count = local.edge_enabled ? 1 : 0
}

resource "terraform_data" "edge_zone_guard" {
  count = local.edge_enabled ? 1 : 0

  lifecycle {
    precondition {
      condition     = length(data.cloudflare_zones.corvis[0].result) == 1
      error_message = "CLOUDFLARE_ZONE_NAME must resolve to exactly one active Cloudflare zone."
    }
  }
}

locals {
  cloudflare_zone_id = local.edge_enabled ? try(data.cloudflare_zones.corvis[0].result[0].id, "") : ""
}

module "foundation" {
  source                                        = "../../modules/gcp-foundation"
  project_id                                    = var.project_id
  environment                                   = "prod"
  source_bucket_name                            = var.source_bucket_name
  enforce_service_account_key_creation_disabled = true
  enforce_service_account_key_upload_disabled   = true
}

module "api_runtime" {
  source                    = "../../modules/cloud-run-runtime"
  project_id                = var.project_id
  environment               = "prod"
  api_image                 = var.api_image
  api_service_account_email = module.foundation.api_service_account
}

resource "google_certificate_manager_dns_authorization" "api" {
  count = local.edge_enabled ? 1 : 0

  project     = var.project_id
  name        = "corvis-api-prod"
  location    = "global"
  description = "DNS authorization for the Corvis production API origin certificate."
  domain      = local.api_hostname

  depends_on = [module.foundation]
}

resource "cloudflare_dns_record" "api_certificate_validation" {
  count = local.edge_enabled ? 1 : 0

  zone_id = local.cloudflare_zone_id
  name    = trimsuffix(google_certificate_manager_dns_authorization.api[0].dns_resource_record[0].name, ".")
  content = trimsuffix(google_certificate_manager_dns_authorization.api[0].dns_resource_record[0].data, ".")
  type    = google_certificate_manager_dns_authorization.api[0].dns_resource_record[0].type
  ttl     = 1
  proxied = false
  comment = "Google Certificate Manager DNS authorization for the Corvis production API origin"

  depends_on = [terraform_data.edge_zone_guard]
}

module "api_origin" {
  count = local.edge_enabled ? 1 : 0

  source                 = "../../modules/gcp-serverless-origin"
  project_id             = var.project_id
  environment            = "prod"
  cloud_run_service_name = module.api_runtime.api_service_name
  hostname               = local.api_hostname
  dns_authorization_id   = google_certificate_manager_dns_authorization.api[0].id
  allowed_source_ranges  = data.cloudflare_ip_ranges.proxy[0].ipv4_cidrs

  depends_on = [cloudflare_dns_record.api_certificate_validation]
}

module "cloudflare_edge" {
  count = local.edge_enabled ? 1 : 0

  source              = "../../modules/cloudflare-edge"
  zone_id             = local.cloudflare_zone_id
  origin_ipv4_address = module.api_origin[0].ipv4_address
  api_hostname        = local.api_hostname
  enable_managed_waf  = var.enable_cloudflare_managed_waf

  depends_on = [terraform_data.edge_configuration_guard, terraform_data.edge_zone_guard]
}
