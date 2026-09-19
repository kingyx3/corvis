locals {
  api_enabled = trimspace(var.api_image) != ""
}

resource "google_secret_manager_secret" "postgres_dsn" {
  project   = var.project_id
  secret_id = "${var.postgres_dsn_secret_id}-${var.environment}"

  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
}

resource "google_secret_manager_secret" "gateway_identity" {
  project   = var.project_id
  secret_id = "${var.gateway_identity_secret_id}-${var.environment}"

  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
}

resource "google_secret_manager_secret_iam_member" "api_postgres" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.postgres_dsn.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.api_service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "api_gateway_identity" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.gateway_identity.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.api_service_account_email}"
}

resource "google_cloud_run_v2_service" "api" {
  count    = local.api_enabled ? 1 : 0
  project  = var.project_id
  name     = "corvis-api-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  deletion_protection = var.environment == "prod"

  template {
    service_account = var.api_service_account_email

    scaling {
      min_instance_count = 0
      max_instance_count = var.environment == "prod" ? 20 : 5
    }

    containers {
      image = var.api_image

      ports { container_port = 3000 }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "CORVIS_ENVIRONMENT"
        value = var.environment
      }

      env {
        name = "CORVIS_POSTGRES_DSN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.postgres_dsn.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "CORVIS_GATEWAY_IDENTITY_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gateway_identity.secret_id
            version = "latest"
          }
        }
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
      condition     = !local.api_enabled || can(regex("@sha256:[0-9a-fA-F]{64}$", var.api_image))
      error_message = "api_image must be an immutable digest reference ending in @sha256:<64 hex chars>."
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.api_postgres,
    google_secret_manager_secret_iam_member.api_gateway_identity,
  ]
}
