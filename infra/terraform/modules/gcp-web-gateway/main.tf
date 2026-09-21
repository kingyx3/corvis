terraform {
  required_providers {
    google = { source = "hashicorp/google" }
    google-beta = { source = "hashicorp/google-beta" }
  }
}

locals {
  labels = { service = "corvis", environment = var.environment, managed_by = "terraform" }
}

resource "google_service_account" "gateway" {
  project      = var.project_id
  account_id   = "corvis-web-gw-${var.environment}"
  display_name = "Corvis customer web gateway ${var.environment}"
  description  = "Keyless API Gateway identity allowed to invoke only the customer web Cloud Run service."
}

resource "google_project_service_identity" "api_gateway" {
  provider = google-beta
  project  = var.project_id
  service  = "apigateway.googleapis.com"
}

resource "google_service_account_iam_member" "gateway_token_creator" {
  service_account_id = google_service_account.gateway.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.api_gateway.email}"
}

resource "google_service_account_iam_member" "deployer_act_as_gateway" {
  service_account_id = google_service_account.gateway.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deployer_service_account_email}"
}

resource "google_cloud_run_v2_service_iam_member" "gateway_invoker" {
  project  = var.project_id
  location = var.region
  name     = var.cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_api_gateway_api" "web" {
  provider     = google-beta
  project      = var.project_id
  api_id       = "corvis-web-${var.environment}"
  display_name = "Corvis customer web ${var.environment}"
  labels       = local.labels
}

resource "google_project_service" "managed_api" {
  project            = var.project_id
  service            = google_api_gateway_api.web.managed_service
  disable_on_destroy = false
}

resource "google_apikeys_key" "cloudflare_edge" {
  project      = var.project_id
  name         = "corvis-web-edge-${var.environment}"
  display_name = "Corvis customer web edge ${var.environment}"
  restrictions { api_targets { service = google_project_service.managed_api.service } }
}

resource "google_api_gateway_api_config" "web" {
  provider             = google-beta
  project              = var.project_id
  api                  = google_api_gateway_api.web.api_id
  api_config_id_prefix = "corvis-web-${var.environment}-"
  display_name         = "Corvis customer web ${var.environment}"
  labels               = local.labels

  gateway_config { backend_config { google_service_account = google_service_account.gateway.email } }

  openapi_documents {
    document {
      path = "openapi.yaml"
      contents = base64encode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_uri = nonsensitive(var.cloud_run_service_uri) }))
    }
  }

  lifecycle { create_before_destroy = true }
  depends_on = [google_cloud_run_v2_service_iam_member.gateway_invoker, google_service_account_iam_member.gateway_token_creator, google_service_account_iam_member.deployer_act_as_gateway, google_project_service.managed_api]
}

resource "google_api_gateway_gateway" "web" {
  provider     = google-beta
  project      = var.project_id
  region       = var.region
  gateway_id   = "corvis-web-${var.environment}"
  display_name = "Corvis customer web ${var.environment}"
  api_config   = google_api_gateway_api_config.web.id
  labels       = local.labels
}
