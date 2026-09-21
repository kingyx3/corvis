terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
  }
}

locals {
  runtime_enabled = trimspace(var.image) != ""
}

resource "google_service_account" "customer" {
  project      = var.project_id
  account_id   = "corvis-customer-${var.environment}"
  display_name = "Corvis customer web ${var.environment}"
  description  = "Keyless, presentation-only identity for the Corvis customer web runtime. It receives no direct Postgres, GCS, queue or Secret Manager access."
}

resource "google_project_iam_member" "customer_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.customer.email}"
}

resource "google_cloud_run_v2_service" "customer" {
  count    = local.runtime_enabled ? 1 : 0
  project  = var.project_id
  name     = "corvis-customer-${var.environment}"
  location = var.region

  # Network reachability is required for API Gateway, but Cloud Run IAM remains
  # the invocation boundary. The gateway module grants the only invoker role.
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
        value = "customer"
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
      error_message = "Customer web image must be an immutable digest reference ending in @sha256:<64 hex chars>."
    }
  }

  depends_on = [google_project_iam_member.customer_log_writer]
}
