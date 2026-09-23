terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
  }
}

locals {
  runtime_enabled = trimspace(var.image) != ""
  service_name    = "corvis-${var.surface}-${var.environment}"
  display_surface = var.surface == "admin" ? "admin" : "customer"

  deployer_service_account_email = "corvis-deploy@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_service_account" "customer" {
  project      = var.project_id
  account_id   = local.service_name
  display_name = "Corvis ${local.display_surface} web ${var.environment}"
  description  = "Keyless, presentation-only identity for the Corvis ${local.display_surface} web runtime. No direct data-plane credentials are attached."
}

resource "google_project_iam_member" "customer_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.customer.email}"
}

# Deploying the service as this identity requires the deployer to act as it.
resource "google_service_account_iam_member" "deployer_act_as_customer" {
  service_account_id = google_service_account.customer.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.deployer_service_account_email}"
}

resource "google_cloud_run_v2_service" "customer" {
  count    = local.runtime_enabled ? 1 : 0
  project  = var.project_id
  name     = local.service_name
  location = var.region

  # API Gateway needs network reachability, while Cloud Run IAM remains the
  # invocation boundary. No public invoker is granted here.
  ingress = "INGRESS_TRAFFIC_ALL"

  deletion_protection = var.environment == "prod" && !var.decommission_mode

  template {
    service_account = google_service_account.customer.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.environment == "prod" ? 10 : 3
    }

    containers {
      image = var.image

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "CORVIS_ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "CORVIS_RUNTIME_SURFACE"
        value = var.surface
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[0-9a-fA-F]{64}$", var.image))
      error_message = "Presentation web image must be an immutable digest reference ending in @sha256:<64 hex chars>."
    }
  }

  depends_on = [
    google_project_iam_member.customer_log_writer,
    google_service_account_iam_member.deployer_act_as_customer,
  ]
}
