terraform {
  required_version = ">= 1.7.0"

  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
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

provider "google-beta" {
  project = var.project_id
  region  = "asia-southeast1"
}

provider "cloudflare" {}

locals {
  edge_requested                 = trimspace(var.cloudflare_zone_name) != ""
  api_runtime_enabled            = trimspace(var.api_image) != ""
  edge_enabled                   = local.edge_requested && local.api_runtime_enabled
  api_hostname                   = local.edge_enabled ? "api.${trimspace(var.cloudflare_zone_name)}" : ""
  customer_hostname              = local.edge_enabled ? "app.${trimspace(var.cloudflare_zone_name)}" : ""
  deployer_service_account_email = "corvis-deploy@${var.project_id}.iam.gserviceaccount.com"
  cloudflare_zone_id             = local.edge_enabled ? try(data.cloudflare_zones.corvis[0].result[0].id, "") : ""
  cloudflare_account_id          = local.edge_enabled ? try(data.cloudflare_zones.corvis[0].result[0].account.id, "") : ""
}

resource "terraform_data" "edge_configuration_guard" {
  lifecycle {
    precondition {
      condition     = !local.edge_requested || local.api_runtime_enabled
      error_message = "Cloudflare edge activation requires an immutable API_IMAGE so API and customer origins cannot point at missing runtimes."
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
      condition     = length(data.cloudflare_zones.corvis[0].result) == 1 && local.cloudflare_zone_id != "" && local.cloudflare_account_id != ""
      error_message = "CLOUDFLARE_ZONE_NAME must resolve to exactly one active Cloudflare zone with an account ID."
    }
  }
}

module "foundation" {
  source                                        = "../../modules/gcp-foundation"
  project_id                                    = var.project_id
  environment                                   = "prod"
  source_bucket_name                            = var.source_bucket_name
  enforce_service_account_key_creation_disabled = true
  enforce_service_account_key_upload_disabled   = true
  decommission_mode                             = var.decommission_mode
}

module "api_runtime" {
  source                            = "../../modules/cloud-run-runtime"
  project_id                        = var.project_id
  environment                       = "prod"
  api_image                         = var.api_image
  api_service_account_email         = module.foundation.api_service_account
  worker_service_account_email      = module.foundation.worker_service_account
  source_bucket_name                = module.foundation.source_bucket
  processing_topic_name             = module.foundation.document_registered_topic_name
  processing_dead_letter_topic_name = module.foundation.dead_letter_topic_name
  processing_queue_name             = module.foundation.processing_queue_name
  auth_issuer                       = var.auth_issuer
  auth_audience                     = var.auth_audience
  auth_jwks_url                     = var.auth_jwks_url
  upload_allowed_origins            = local.edge_enabled ? ["https://${local.customer_hostname}"] : []
  decommission_mode                 = var.decommission_mode

  depends_on = [module.foundation]
}

module "customer_runtime" {
  source            = "../../modules/cloud-run-customer"
  project_id        = var.project_id
  environment       = "prod"
  image             = var.api_image
  decommission_mode = var.decommission_mode
}

module "control_loop_runtime" {
  source                = "../../modules/control-loop-runtime"
  project_id            = var.project_id
  environment           = "prod"
  control_loop_image    = var.control_loop_image
  service_account_email = module.foundation.control_loop_service_account
  state_bucket_name     = module.foundation.control_loop_state_bucket
  decommission_mode     = var.decommission_mode

  depends_on = [module.foundation]
}

module "api_gateway" {
  count = local.edge_enabled ? 1 : 0

  source                         = "../../modules/gcp-api-gateway"
  project_id                     = var.project_id
  environment                    = "prod"
  cloud_run_service_name         = module.api_runtime.api_service_name
  cloud_run_service_uri          = module.api_runtime.api_service_uri
  deployer_service_account_email = local.deployer_service_account_email

  depends_on = [module.foundation, module.api_runtime]
}

module "customer_gateway" {
  count = local.edge_enabled ? 1 : 0

  source                         = "../../modules/gcp-web-gateway"
  project_id                     = var.project_id
  environment                    = "prod"
  cloud_run_service_name         = module.customer_runtime.service_name
  cloud_run_service_uri          = module.customer_runtime.service_uri
  deployer_service_account_email = local.deployer_service_account_email

  depends_on = [module.customer_runtime]
}

module "cloudflare_edge" {
  count = local.edge_enabled ? 1 : 0

  source             = "../../modules/cloudflare-edge"
  account_id         = local.cloudflare_account_id
  zone_id            = local.cloudflare_zone_id
  gateway_hostname   = module.api_gateway[0].gateway_hostname
  gateway_api_key    = module.api_gateway[0].edge_api_key
  api_hostname       = local.api_hostname
  enable_managed_waf = var.enable_cloudflare_managed_waf

  depends_on = [
    terraform_data.edge_configuration_guard,
    terraform_data.edge_zone_guard,
    module.api_gateway,
  ]
}

module "cloudflare_customer_edge" {
  count = local.edge_enabled ? 1 : 0

  source                    = "../../modules/cloudflare-customer-edge"
  account_id                = local.cloudflare_account_id
  zone_id                   = local.cloudflare_zone_id
  customer_hostname         = local.customer_hostname
  customer_gateway_hostname = module.customer_gateway[0].gateway_hostname
  customer_gateway_api_key  = module.customer_gateway[0].edge_api_key
  api_gateway_hostname      = module.api_gateway[0].gateway_hostname
  api_gateway_api_key       = module.api_gateway[0].edge_api_key

  depends_on = [
    terraform_data.edge_zone_guard,
    module.customer_gateway,
    module.api_gateway,
  ]
}

module "observability" {
  source                    = "../../modules/gcp-observability"
  project_id                = var.project_id
  environment               = "prod"
  api_service_name          = coalesce(module.api_runtime.api_service_name, "")
  dead_letter_topic_name    = module.foundation.dead_letter_topic_name
  processing_queue_name     = module.foundation.processing_queue_name
  notification_channel_ids  = var.monitoring_notification_channel_ids
  billing_account_id        = var.billing_account_id
  monthly_budget_amount_usd = var.monthly_budget_amount_usd
}
