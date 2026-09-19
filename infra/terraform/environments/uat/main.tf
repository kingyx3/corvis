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
    var.cloudflare_zone_id,
    var.customer_hostname,
    var.admin_hostname,
    var.api_hostname,
    var.origin_ipv4_address,
  ]
  edge_any     = anytrue([for value in local.edge_inputs : trimspace(value) != ""])
  edge_enabled = alltrue([for value in local.edge_inputs : trimspace(value) != ""])
}

resource "terraform_data" "edge_configuration_guard" {
  lifecycle {
    precondition {
      condition     = !local.edge_any || local.edge_enabled
      error_message = "Cloudflare edge configuration is partial. Configure zone ID, all three public hostnames and the derived GCP load-balancer IPv4 together."
    }
  }
}

module "foundation" {
  source             = "../../modules/gcp-foundation"
  project_id         = var.project_id
  environment        = "uat"
  source_bucket_name = var.source_bucket_name
}

module "cloudflare_edge" {
  count = local.edge_enabled ? 1 : 0

  source             = "../../modules/cloudflare-edge"
  zone_id            = var.cloudflare_zone_id
  origin_ipv4_address = var.origin_ipv4_address
  customer_hostname  = var.customer_hostname
  admin_hostname     = var.admin_hostname
  api_hostname       = var.api_hostname
  enable_managed_waf = var.enable_cloudflare_managed_waf

  depends_on = [terraform_data.edge_configuration_guard]
}
