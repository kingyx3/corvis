terraform {
  required_version = ">= 1.7.0"

  backend "gcs" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {}

locals {
  zone_name = trimspace(var.cloudflare_zone_name)
}

data "cloudflare_zones" "corvis" {
  name      = local.zone_name
  status    = "active"
  max_items = 2
}

resource "terraform_data" "zone_guard" {
  lifecycle {
    precondition {
      condition     = length(data.cloudflare_zones.corvis.result) == 1 && try(data.cloudflare_zones.corvis.result[0].id, "") != "" && try(data.cloudflare_zones.corvis.result[0].account.id, "") != ""
      error_message = "CLOUDFLARE_ZONE_NAME must resolve to exactly one active Cloudflare zone with an account ID."
    }
  }
}

module "zone_policy" {
  source = "../../modules/cloudflare-zone-policy"

  zone_id            = data.cloudflare_zones.corvis.result[0].id
  zone_name          = local.zone_name
  enable_managed_waf = var.enable_cloudflare_managed_waf

  depends_on = [terraform_data.zone_guard]
}

output "zone_id" {
  description = "Resolved Cloudflare zone ID."
  value       = data.cloudflare_zones.corvis.result[0].id
}

output "zone_name" {
  description = "Single Corvis root domain shared by UAT and production."
  value       = local.zone_name
}
