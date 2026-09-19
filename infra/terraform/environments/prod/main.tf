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
  edge_inputs = [
    var.cloudflare_zone_name,
    var.origin_ipv4_address,
  ]
  edge_any     = anytrue([for value in local.edge_inputs : trimspace(value) != ""])
  edge_enabled = alltrue([for value in local.edge_inputs : trimspace(value) != ""])

  customer_hostname = local.edge_enabled ? "app.${trimspace(var.cloudflare_zone_name)}" : ""
  admin_hostname    = local.edge_enabled ? "admin.${trimspace(var.cloudflare_zone_name)}" : ""
  api_hostname      = local.edge_enabled ? "api.${trimspace(var.cloudflare_zone_name)}" : ""
}

resource "terraform_data" "edge_configuration_guard" {
  lifecycle {
    precondition {
      condition     = !local.edge_any || local.edge_enabled
      error_message = "Cloudflare edge configuration is partial. Configure zone name and the derived GCP load-balancer IPv4 together."
    }
  }
}

data "cloudflare_zones" "corvis" {
  count = local.edge_enabled ? 1 : 0

  name      = trimspace(var.cloudflare_zone_name)
  status    = "active"
  max_items = 2
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

module "cloudflare_edge" {
  count = local.edge_enabled ? 1 : 0

  source              = "../../modules/cloudflare-edge"
  zone_id             = local.cloudflare_zone_id
  origin_ipv4_address = var.origin_ipv4_address
  customer_hostname   = local.customer_hostname
  admin_hostname      = local.admin_hostname
  api_hostname        = local.api_hostname
  enable_managed_waf  = var.enable_cloudflare_managed_waf

  depends_on = [terraform_data.edge_configuration_guard, terraform_data.edge_zone_guard]
}
